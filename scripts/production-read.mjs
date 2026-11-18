import { spawnSync } from 'node:child_process';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MARKER = '\n__INFRA_PRODUCTION_READ__\t';
const WRITE_OUT = `${MARKER}%{http_code}\t%{time_namelookup}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{ssl_verify_result}\n`;

function responseParts(stdout) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  const index = bytes.lastIndexOf(MARKER);
  if (index < 0) return null;
  const fields = bytes.subarray(index + Buffer.byteLength(MARKER)).toString('ascii').match(
    /^(\d{3})\t(\d+(?:\.\d+)?)\t(\d+(?:\.\d+)?)\t(\d+(?:\.\d+)?)\t(\d+(?:\.\d+)?)\t(\d+(?:\.\d+)?)\t(\d+)\n$/,
  );
  if (!fields) return null;
  const [http, dns, connect, tls, firstByte, total, sslVerify] = fields.slice(1).map(Number);
  if (![http, dns, connect, tls, firstByte, total, sslVerify].every(Number.isFinite)) return null;
  return { body: bytes.subarray(0, index), http, sslVerify, timings: { dns, connect, tls, firstByte, total } };
}

function phaseFor(result, response) {
  if (result.error || result.signal) return 'process';
  if (result.status === 60 || result.status === 51) return 'certificate';
  // An unfinished TLS handshake can leave ssl_verify_result=1 on curl exit 28.
  // Only that timeout state is retryable; completed/explicit verification failures are not.
  const unfinishedTlsTimeout = result.status === 28 && response?.http === 0 && response.timings.tls === 0;
  if (response && response.sslVerify !== 0 && !unfinishedTlsTimeout) return 'certificate';
  if (response && response.http !== 0 && response.http !== 200) return 'http';
  if (result.status === 28) {
    if (!response) return 'timeout_unknown';
    if (!response.timings.connect) return 'connect';
    if (!response.timings.tls) return 'tls_handshake';
    return response.timings.firstByte ? 'response_body' : 'response_headers';
  }
  if (result.status === 63 || (response && response.body.length > MAX_BODY_BYTES)) return 'size_limit';
  if (result.status !== 0) return 'transport';
  return 'metadata';
}

// Each retry is a new GET/process with independent stdout. No credentials or stderr are logged.
// The existing proxy and CA environment is inherited; certificate validation is never disabled.
export function readProduction(value, { run = spawnSync } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Production read requires a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Production read requires HTTPS without credentials or fragments.');
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = run('curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--request', 'GET',
      '--connect-timeout', '10', '--max-time', '20', '--max-filesize', String(MAX_BODY_BYTES), '--retry', '0',
      '--write-out', WRITE_OUT, url.href], { timeout: 25_000, maxBuffer: 3 * 1024 * 1024 });
    const response = responseParts(result.stdout);
    if (!result.error && !result.signal && result.status === 0 && response?.http === 200 && response.sslVerify === 0 && response.body.length <= MAX_BODY_BYTES) return response.body;
    const phase = phaseFor(result, response);
    attempts.push({ phase, curlExit: Number.isInteger(result.status) ? result.status : null, http: response?.http ?? null, timingsSeconds: response?.timings ?? null });
    if (attempt === 1 && result.status === 28 && !result.error && !result.signal && phase !== 'certificate' && phase !== 'http') continue;
    const details = attempts.map((item, index) => `attempt=${index + 1}, phase=${item.phase}, curl_exit=${item.curlExit ?? 'none'}, http=${item.http ?? 'unknown'}, timings_s=${JSON.stringify(item.timingsSeconds)}`).join('; ');
    const error = new Error(`Production GET failed for ${url.pathname} after ${attempts.length} attempt(s): ${details}`);
    error.attempts = attempts;
    throw error;
  }
}
