import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    if (response.timings.firstByte || response.http === 200) return 'response_body';
    if (response.reusedConnection) return 'response_headers';
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

// One curl process keeps a verified TLS connection across the same site's routes.
// Each body has its own bounded file; metadata never mixes with response bytes.
export function readProductionBatch(values, { run = spawnSync } = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) throw new Error('Production batch requires 1–64 HTTPS URLs.');
  const urls = values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Production batch requires valid HTTPS URLs.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Production batch requires HTTPS without credentials or fragments.');
    return url;
  });
  if (urls.some(url => url.origin !== urls[0].origin) || new Set(urls.map(url => url.href)).size !== urls.length) {
    throw new Error('Production batch requires unique URLs from one origin.');
  }
  const marker = '__INFRA_PRODUCTION_BATCH__';
  const format = `${marker}\t%{urlnum}\t%{http_code}\t%{exitcode}\t%{time_namelookup}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{ssl_verify_result}\t%{num_connects}\t%{conn_id}\n`;
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const temporary = mkdtempSync(join(tmpdir(), 'infra-production-'));
    try {
      const files = urls.map((_, index) => join(temporary, `${index}.body`));
      for (const file of files) writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      const args = ['--disable', '--fail', '--fail-early', '--silent', '--show-error', '--globoff', '--proto', '=https', '--request', 'GET',
        '--connect-timeout', '10', '--max-time', '20', '--max-filesize', String(MAX_BODY_BYTES), '--retry', '0', '--write-out', format];
      urls.forEach((url, index) => args.push('--output', files[index], url.href));
      const result = run('curl', args, { timeout: urls.length * 25_000, maxBuffer: 128 * 1024 });
      const lines = Buffer.from(result.stdout || '').toString('utf8').trimEnd().split('\n');
      const rows = [];
      let validMetadata = Boolean(lines[0]);
      for (const line of lines) {
        const fields = line.split('\t');
        if (fields.length !== 12 || fields[0] !== marker || !fields.slice(1, 11).every(field => /^\d+(?:\.\d+)?$/.test(field)) || !/^-?\d+$/.test(fields[11])) { validMetadata = false; break; }
        const [index, http, exit, dns, connect, tls, firstByte, total, sslVerify, newConnections, connectionId] = fields.slice(1).map(Number);
        if (index !== rows.length || index >= urls.length || !fields.slice(1).map(Number).every(Number.isFinite)) { validMetadata = false; break; }
        rows.push({ index, http, exit, sslVerify, newConnections, connectionId, timings: { dns, connect, tls, firstByte, total } });
      }
      if (validMetadata && !result.error && !result.signal && result.status === 0 && rows.length === urls.length && rows.every(row => row.exit === 0 && row.http === 200 && row.sslVerify === 0)) {
        return rows.map(row => {
          if (statSync(files[row.index]).size > MAX_BODY_BYTES) throw new Error('Production response exceeds its size limit.');
          return { url: urls[row.index].href, body: readFileSync(files[row.index]), transport: {
            attempt, newConnections: row.newConnections, connectionId: row.connectionId, timingsSeconds: row.timings,
          } };
        });
      }
      const last = validMetadata ? rows.at(-1) : null;
      const reusedConnection = last?.newConnections === 0 && last.connectionId >= 0 && rows.slice(0, -1).some(row => row.connectionId === last.connectionId && row.exit === 0 && row.http === 200 && row.sslVerify === 0);
      const response = last ? { ...last, reusedConnection, body: Buffer.alloc(0) } : null;
      const phase = phaseFor(result, response);
      const priorRowsValid = validMetadata && rows.slice(0, -1).every(row => row.exit === 0 && row.http === 200 && row.sslVerify === 0);
      attempts.push({ attempt, route: urls[last?.index ?? 0].pathname, phase, curlExit: result.status ?? null, http: last?.http ?? null, timingsSeconds: last?.timings ?? null });
      if (attempt === 1 && result.status === 28 && !result.error && !result.signal && priorRowsValid && last?.exit === 28 && phase !== 'certificate' && phase !== 'http') continue;
      const error = new Error(`Production batch failed: ${attempts.map(item => `attempt=${item.attempt}, route=${item.route}, phase=${item.phase}, curl_exit=${item.curlExit}, http=${item.http}, timings_s=${JSON.stringify(item.timingsSeconds)}`).join('; ')}`);
      error.attempts = attempts;
      throw error;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
