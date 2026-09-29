# Performance forensics tools

Diagnostic scripts used during the latency investigation (see
[`product-analysis/100-performance-optimizations.md`](../product-analysis/100-performance-optimizations.md)). Not part
of build/test — run manually from a local machine.

## Prerequisites

An env file (default `/tmp/jitter.env`, override with `--env`):

```
TOKEN=<JWT access token>
TID=<tenant id>
PID=<project id>
```

Production API: `https://task-board-api.app-server.workers.dev` (override with `--host`).

## api-series.py — keep-alive request series

A single HTTPS connection (keep-alive), controlled intervals and pauses, JSONL output
(`{op, start, end, ttfb, total, status}` per request). Resilient to timeouts (reconnects and continues).

```bash
# 30 × GET /auth/me at 1s interval
python3 tools/api-series.py --env /tmp/jitter.env \
  --op authme:/api/auth/me:30:1.0

# multiple phases + pauses: 10×1s → pause 6s → 1 request → 10×1s
python3 tools/api-series.py --env /tmp/jitter.env \
  --op authme:/api/auth/me:10:1.0 \
  --pause 6 \
  --op authme:/api/auth/me:1:0 \
  --op authme:/api/auth/me:10:1.0

# different endpoints in one round-robin (ping / 401 probe / Mongo requests)
python3 tools/api-series.py --env /tmp/jitter.env --rounds 30 --interval 1.0 \
  --op ping:/api/ping:1:0 \
  --op tenants401:/api/tenants:1:0 \
  --op authme:/api/auth/me:1:0 \
  --op tasks:/api/projects/<PID>/tasks?page=1\&limit=26\&sort=title:asc:1:0
```

Key technique: **keep-alive** separates reconnect spikes from network jitter — on a warm connection any remaining spikes
are not network-related.

## parse-dbev-tail.py — `wrangler tail` DBEV event parser

Parses `wrangler tail --format json` output containing `DBEV {json}` log lines and correlates them with client-side
JSONL rows from `api-series.py` by timestamp.

> **The `DBEV` producer no longer exists.** The temporary `mongo.ts` diagnostic instrumentation that emitted these lines
> was removed in `377917f` (`chore(server): remove Mongo lifecycle instrumentation`); `grep -rn DBEV server/src/` is
> empty. The parser is retained for a re-instrumented run — **against the current tree it produces nothing**, so a
> latency investigation that runs it will wait on an input nothing produces.

```bash
# 1. capture tail while running a series
cd server && npx wrangler tail task-board-api --format json > /tmp/tail.json &
python3 tools/api-series.py ... > /tmp/series.jsonl

# 2. parse
python3 tools/parse-dbev-tail.py --tail /tmp/tail.json --series /tmp/series.jsonl
```

Output: event type counts; connection lifetimes (created → closed) with close reasons; per-request segmentation
`arrival → DO → dbmw → checkOutStarted → checkedOut → connCreated → connReady → cmdStarted/Succeeded (dur) → response`;
spikes with in-window driver events.

Known artifact: DO event `wallTime` in wrangler tail approximates the interval between events (polluted by request
cadence) — do NOT use it as handler duration. Reliable: `stateless` wallTime (Worker waiting for the DO) and `cpuTime`.

## curl-timing.sh — single-request timing decomposition

`total / connect / TLS / TTFB(starttransfer)` + remote IP + HTTP version for fresh-connection and keep-alive modes.

```bash
tools/curl-timing.sh fresh 30 /api/ping    # 30 requests, new connection each
tools/curl-timing.sh ka     60 /api/ping   # 60 requests, one connection
```

## Typical spike investigation workflow

1. `curl-timing.sh fresh` vs `ka` — do spikes depend on connections?
2. `api-series.py` on a no-Mongo endpoint (`/api/ping`, 401 probe) — spikes without Mongo?
3. `api-series.py` on a Mongo endpoint + `parse-dbev-tail.py` — where the time goes: `connCreated→connReady`
   (reconnect), `cmdSucceeded.dur` (slow operation), or before the first checkout (pre-DB, not Mongo).
4. Cross-check driver events (`connectionClosed.reason`: `error` vs `idle`) against the client configuration.
