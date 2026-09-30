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

## curl-timing.sh — single-request timing decomposition

`total / connect / TLS / TTFB(starttransfer)` + remote IP + HTTP version for fresh-connection and keep-alive modes.

```bash
tools/curl-timing.sh fresh 30 /api/ping    # 30 requests, new connection each
tools/curl-timing.sh ka     60 /api/ping   # 60 requests, one connection
```

## Typical spike investigation workflow

1. `curl-timing.sh fresh` vs `ka` — do spikes depend on connections?
2. `api-series.py` on a no-Mongo endpoint (`/api/ping`, 401 probe) — spikes without Mongo?
3. `api-series.py` on a Mongo endpoint — does the spike sit on a Mongo request at all, or on a non-Mongo one in the same
   window?
4. If the time must be attributed _inside_ the Worker (reconnect vs slow operation vs a pre-DB stall), instrument the
   request path first: emit one structured log line per phase boundary, capture it with
   `npx wrangler tail --format json`, and correlate those lines with the `api-series.py` JSONL by timestamp. There is no
   such emitter in the tree today, so nothing parses a `wrangler tail` capture as-is.

### Reading a `wrangler tail` capture

Known artifact: DO event `wallTime` in wrangler tail approximates the interval between events (polluted by request
cadence) — do NOT use it as handler duration. Reliable: `stateless` wallTime (Worker waiting for the DO) and `cpuTime`.
