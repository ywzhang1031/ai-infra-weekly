import { spawnSync } from 'node:child_process';

const TOKEN = /^[A-Za-z0-9._-]{1,512}$/;
function fail(code, message, { exitCode = null, elapsedMs = 0 } = {}) {
  throw Object.assign(new Error(message), { code, exitCode, elapsedMs, buttondownSafe: true });
}
function validated(value, metadata) {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    fail('credential_format', 'Buttondown credential has an invalid format; its value was not logged.', metadata);
  }
  return value;
}

// Only the specified credential is read. No ACL changes, retries, or disk copies.
export function loadButtondownCredential({ apiToken, run = spawnSync, platform = process.platform, env = process.env, now = Date.now } = {}) {
  const provided = apiToken ?? env.BUTTONDOWN_API_KEY;
  if (provided !== undefined && provided !== '') return validated(provided);
  if (platform !== 'darwin') {
    fail('credential_missing', 'Provide BUTTONDOWN_API_KEY; the named macOS Keychain item is unavailable on this platform.');
  }
  const started = now();
  let result;
  try {
    result = run('/usr/bin/security', ['find-generic-password', '-s', 'ai-infra-weekly.buttondown', '-a', 'ai-infra-weekly', '-w'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 });
  } catch {
    fail('credential_read_failed', 'The named Buttondown Keychain item could not be read.', { elapsedMs: Math.max(0, now() - started) });
  }
  const metadata = { exitCode: Number.isInteger(result.status) ? result.status : null, elapsedMs: Math.max(0, now() - started) };
  if (result.error?.code === 'ETIMEDOUT') {
    fail('credential_timeout', 'Reading ai-infra-weekly.buttondown timed out after 10 seconds. Complete the system confirmation for this item; its partition may not authorize /usr/bin/security. No retry or ACL change was made.', metadata);
  }
  if (result.status === 44 && !result.error && !result.signal) {
    fail('credential_missing', 'The named ai-infra-weekly.buttondown Keychain item was not found.', metadata);
  }
  if (result.error || result.signal || result.status !== 0) {
    fail('credential_read_denied', 'The named Buttondown Keychain read was denied or failed; check its system access confirmation.', metadata);
  }
  return validated(typeof result.stdout === 'string' ? result.stdout.trim() : null, metadata);
}
