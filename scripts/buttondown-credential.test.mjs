import test from 'node:test';
import assert from 'node:assert/strict';
import { loadButtondownCredential } from './buttondown-credential.mjs';

const forbidden = () => assert.fail('No subprocess should run');
function reader(result) {
  const calls = [];
  let clock = 100;
  return { calls, options: { platform: 'darwin', env: {}, now: () => (clock += 10), run: (...args) => { calls.push(args); return result; } } };
}
function safeError(fn, code, metadata) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.buttondownSafe, true);
    assert.doesNotMatch(error.message, /fixture-secret|provider-stderr|provider-error/);
    assert.doesNotMatch(JSON.stringify(error), /fixture-secret|provider-stderr|provider-error/);
    for (const [key, value] of Object.entries(metadata ?? {})) assert.equal(error[key], value);
    return true;
  });
}

test('explicit token then environment token take priority without Keychain or disk access', () => {
  assert.equal(loadButtondownCredential({ apiToken: 'explicit-token', env: { BUTTONDOWN_API_KEY: 'env-token' }, platform: 'darwin', run: forbidden }), 'explicit-token');
  assert.equal(loadButtondownCredential({ env: { BUTTONDOWN_API_KEY: 'env-token' }, platform: 'linux', run: forbidden }), 'env-token');
});

test('reads only the exact named item once, with the original ten-second bound', () => {
  const { options, calls } = reader({ status: 0, stdout: 'fixture-secret\n', stderr: '', signal: null });
  assert.equal(loadButtondownCredential(options), 'fixture-secret');
  assert.deepEqual(calls, [['/usr/bin/security', ['find-generic-password', '-s', 'ai-infra-weekly.buttondown', '-a', 'ai-infra-weekly', '-w'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 }]]);
});

test('timeout reports the single-item confirmation/partition issue and never retries', () => {
  const { options, calls } = reader({ status: null, error: { code: 'ETIMEDOUT', message: 'provider-error fixture-secret' }, signal: 'SIGTERM', stdout: 'fixture-secret', stderr: 'provider-stderr' });
  safeError(() => loadButtondownCredential(options), 'credential_timeout', { exitCode: null, elapsedMs: 10 });
  assert.equal(calls.length, 1);
});

test('exit 44 is a missing named item, while other exits or process failures stay distinct', () => {
  for (const [result, code] of [
    [{ status: 44, stdout: '', stderr: 'provider-stderr' }, 'credential_missing'],
    [{ status: 51, stdout: 'fixture-secret', stderr: 'provider-stderr' }, 'credential_read_denied'],
    [{ status: null, error: { code: 'ENOENT', message: 'provider-error' }, stderr: 'provider-stderr' }, 'credential_read_denied'],
    [{ status: 0, signal: 'SIGTERM', stdout: 'fixture-secret' }, 'credential_read_denied'],
  ]) {
    const { options, calls } = reader(result);
    safeError(() => loadButtondownCredential(options), code, { exitCode: result.status, elapsedMs: 10 });
    assert.equal(calls.length, 1);
  }
});

test('invalid explicit/environment or successful Keychain output never falls back or exposes values', () => {
  for (const value of ['fixture-secret bad', 'fixture-secret\n', 'x'.repeat(513), 42]) {
    safeError(() => loadButtondownCredential({ apiToken: value, platform: 'darwin', env: {}, run: forbidden }), 'credential_format');
  }
  safeError(() => loadButtondownCredential({ env: { BUTTONDOWN_API_KEY: 'fixture-secret bad' }, run: forbidden }), 'credential_format');
  for (const stdout of ['', 'fixture-secret bad', 'x'.repeat(513)]) {
    const { options, calls } = reader({ status: 0, stdout, stderr: 'provider-stderr' });
    safeError(() => loadButtondownCredential(options), 'credential_format', { exitCode: 0, elapsedMs: 10 });
    assert.equal(calls.length, 1);
  }
});

test('non-macOS with no supplied token is missing, and unexpected runner exceptions are sanitized', () => {
  safeError(() => loadButtondownCredential({ platform: 'linux', env: {}, run: forbidden }), 'credential_missing');
  const { options } = reader(null);
  options.run = () => { throw new Error('provider-error fixture-secret'); };
  safeError(() => loadButtondownCredential(options), 'credential_read_failed', { exitCode: null, elapsedMs: 10 });
});
