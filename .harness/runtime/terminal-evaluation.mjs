#!/usr/bin/env node
/** Supported, reversible, same-principal terminal-evaluation entry. */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_CLI = join(HARNESS_DIR, 'runtime', 'harness.mjs');
const CONTROL_DIR = process.env.HARNESS_CONTROL_ROOT
  ? resolve(process.env.HARNESS_CONTROL_ROOT)
  : join(HARNESS_DIR, 'state/control');
const MARKER = join(CONTROL_DIR, 'terminal-evaluation.disabled');
function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  return 2;
}
function isRegularMarker() {
  if (!existsSync(MARKER)) return false;
  const stat = lstatSync(MARKER);
  return stat.isFile() && !stat.isSymbolicLink();
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function disable() {
  mkdirSync(CONTROL_DIR, { recursive: true });
  if (existsSync(MARKER)) {
    if (!isRegularMarker()) return fail('INVALID_MARKER', 'disable marker must be a regular non-symlink file');
    process.stdout.write('terminal evaluation disabled\n');
    return 0;
  }

  let descriptor;
  try {
    descriptor = openSync(MARKER, 'wx', 0o600);
    writeSync(descriptor, 'terminal evaluation disabled by operator\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(CONTROL_DIR);
    process.stdout.write('terminal evaluation disabled\n');
    return 0;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    return fail('DISABLE_FAILED', error.message);
  }
}

function status() {
  if (existsSync(MARKER)) {
    if (!isRegularMarker()) return fail('INVALID_MARKER', 'disable marker must be a regular non-symlink file');
    process.stdout.write('terminal evaluation disabled\n');
    return 1;
  }
  process.stdout.write('terminal evaluation enabled\n');
  return 0;
}

function enable() {
  if (!existsSync(MARKER)) return fail('ENABLE_NOT_REQUIRED', 'disable marker does not exist');
  if (!isRegularMarker()) return fail('INVALID_MARKER', 'refusing to remove a non-regular or symlink marker');
  try {
    unlinkSync(MARKER);
    syncDirectory(CONTROL_DIR);
    process.stdout.write('terminal evaluation enabled\n');
    return 0;
  } catch (error) {
    return fail('ENABLE_FAILED', error.message);
  }
}

function evaluate(args) {
  if (existsSync(MARKER)) {
    return fail('TERMINAL_EVALUATION_DISABLED', 'supported terminal evaluation is disabled');
  }
  const result = spawnSync(process.execPath, [HARNESS_CLI, 'evaluate', ...args], { stdio: 'inherit' });
  if (result.error) return fail('EVALUATE_LAUNCH_FAILED', result.error.message);
  return result.status ?? 1;
}

const [operation = 'status', ...args] = process.argv.slice(2);
const result =
  operation === 'disable'
    ? disable()
    : operation === 'status'
      ? status()
      : operation === 'enable'
        ? enable()
        : operation === 'evaluate'
          ? evaluate(args)
          : fail('UNSUPPORTED_OPERATION', 'use disable, status, enable, or evaluate');
process.exit(result);
