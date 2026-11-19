import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emailDraftDirectory, prepareEmailDraft } from './email-draft.mjs';
import { loadButtondownCredential } from './buttondown-credential.mjs';

const ORIGIN = 'https://api.buttondown.com';
const VERSION = '2026-04-01';
const LIMIT = 2 * 1024 * 1024;
const EDITOR = '<!-- buttondown-editor-mode: plaintext -->\n';
const ID = /^(?:em_[A-Za-z0-9]{1,80}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code, buttondownSafe: true });
const requireCheck = (condition, code, message) => { if (!condition) throw failure(code, message); };
const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
function read(file) {
  const stat = lstatSync(file);
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMIT, 'local_file', 'Expected a bounded regular local file.');
  return readFileSync(file);
}
const readJson = file => JSON.parse(read(file));
function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, jsonBytes(value), { flag: 'wx', mode: 0o600 });
  try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}
function allowedRequest({ method, path, payload, idempotencyKey }) {
  requireCheck(typeof path === 'string' && path.startsWith('/v1/emails'), 'request_scope', 'Only Buttondown email list/detail and draft creation are allowed.');
  const url = new URL(path, ORIGIN);
  const list = url.pathname === '/v1/emails';
  const detail = url.pathname.startsWith('/v1/emails/') && ID.test(url.pathname.slice('/v1/emails/'.length));
  requireCheck(url.origin === ORIGIN && !url.hash && !url.username && !url.password, 'request_scope', 'Invalid Buttondown request origin.');
  if (method === 'GET') {
    const keys = [...url.searchParams.keys()];
    requireCheck((list || detail) && (!detail || !url.search) && keys.every(key => ['subject', 'page'].includes(key)) && keys.length === new Set(keys).size &&
      (!url.searchParams.has('page') || /^(?:[1-9]|10)$/.test(url.searchParams.get('page'))) && payload === undefined && idempotencyKey === undefined,
    'request_scope', 'Only bounded, unfiltered-by-status email reads are allowed.');
  } else {
    requireCheck(method === 'POST' && list && !url.search && payload && Object.keys(payload).sort().join(',') === 'body,status,subject' &&
      typeof payload.subject === 'string' && payload.subject.length > 0 && typeof payload.body === 'string' && payload.body.startsWith(EDITOR) &&
      payload.status === 'draft' && UUID.test(idempotencyKey ?? ''), 'request_scope', 'Only three-field draft creation with a persisted UUID is allowed.');
  }
  return url.href;
}

// No PATCH, send endpoint, redirect, retry, or provider error body is exposed here.
// Authorization and JSON travel only in curl's stdin configuration, never argv/logs.
export function createButtondownRequest({ apiToken } = {}) {
  let token;
  return ({ method, path, payload, idempotencyKey }) => {
    const url = allowedRequest({ method, path, payload, idempotencyKey });
    token ??= loadButtondownCredential({ apiToken });
    const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    const config = [`url = ${quote(url)}`, `request = ${quote(method)}`, `header = ${quote(`Authorization: Token ${token}`)}`,
      `header = ${quote(`X-API-Version: ${VERSION}`)}`, 'header = "Accept: application/json"'];
    if (payload) {
      requireCheck(Buffer.byteLength(JSON.stringify(payload)) <= LIMIT, 'request_size', 'Draft payload exceeds the bounded request size.');
      config.push('header = "Content-Type: application/json"', `header = ${quote(`X-Idempotency-Key: ${idempotencyKey}`)}`, `data-raw = ${quote(JSON.stringify(payload))}`);
    }
    const { BUTTONDOWN_API_KEY: omitted, ...env } = process.env;
    const result = spawnSync('curl', ['--disable', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '10', '--max-time', '20',
      '--max-filesize', String(LIMIT), '--retry', '0', '--config', '-', '--write-out', '\n__BUTTONDOWN_HTTP__%{http_code}\n'],
    { input: config.join('\n') + '\n', encoding: 'utf8', timeout: 25_000, maxBuffer: LIMIT + 1024, env });
    const output = result.stdout || '';
    const footer = output.match(/\n__BUTTONDOWN_HTTP__(\d{3})\n$/);
    const http = footer ? Number(footer[1]) : 0;
    requireCheck(!result.error && !result.signal && result.status === 0, 'api_transport', `Buttondown transport failed (curl_exit=${Number.isInteger(result.status) ? result.status : 'none'}, http=${http}); outcome requires verification.`);
    requireCheck(http !== 401 && http !== 403, 'api_auth_scope', 'Buttondown authentication or API scope was rejected.');
    requireCheck(method === 'GET' ? http === 200 : http === 200 || http === 201, 'api_http', `Buttondown request failed (http=${http}); no automatic retry.`);
    const body = output.slice(0, footer.index);
    requireCheck(Buffer.byteLength(body) <= LIMIT, 'api_size', 'Buttondown response exceeds the bounded size.');
    try { return JSON.parse(body); } catch { throw failure('api_json', 'Buttondown returned invalid JSON.'); }
  };
}

// UI and API can differ only in editor metadata, CRLF, and trailing newlines.
const normalizedBody = body => (body.startsWith(EDITOR.trimEnd()) ? body.slice(EDITOR.trimEnd().length).replace(/^\r?\n/, '') : body).replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
const isTest = email => email.subject.startsWith('[TEST · 不发送]') || email.body.includes('BD-CREATE-');
const hasIssueLink = (body, url) => new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s"\'<>\\)\\]`])').test(body);
function emailShape(email, id) {
  requireCheck(email && ID.test(email.id ?? '') && (!id || email.id === id) && typeof email.subject === 'string' && typeof email.body === 'string' && /^[a-z_]{1,40}$/.test(email.status ?? ''),
    'api_shape', 'Email detail is incomplete or its ID differs.');
  return email;
}
function remoteId(value) {
  const match = typeof value === 'string' && value.match(/^https:\/\/buttondown\.com\/emails\/([^/?#]+)\/?$/);
  requireCheck(match && ID.test(match[1]), 'remote_binding', 'The recorded remote draft URL is invalid.');
  return match[1];
}

export function syncButtondownDraft({ root, expectedWeek, emailTestId, apiToken, request } = {}) {
  requireCheck(typeof root === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expectedWeek ?? ''), 'local_identity', 'A local root and YYYY-MM-DD expected week are required.');
  const directory = emailDraftDirectory({ root, expectedWeek, emailTestId });
  const testMode = emailTestId !== undefined;
  const searchSubject = emailTestId ?? expectedWeek;
  const manifestPath = join(directory, 'manifest.json');
  const bodyPath = join(directory, 'draft.md');
  const createPath = join(directory, 'buttondown-create.json');
  const errorPath = join(directory, 'buttondown-sync-error.json');
  try {
    const original = read(manifestPath);
    const manifest = JSON.parse(original);
    requireCheck(manifest.schemaVersion === 1 && manifest.week === expectedWeek && manifest.testId === emailTestId && manifest.sendPolicy === (testMode ? 'never_send' : 'owner_confirmation_required') && manifest.format === 'markdown', 'local_binding', 'The prepared draft manifest has an invalid identity or send policy.');
    try { prepareEmailDraft({ root, expectedWeek, emailTestId, productionVerified: true, verifiedInputSha256: manifest.inputSha256 }); }
    catch { throw failure('local_binding', 'The prepared draft no longer matches its public issue, publication receipt, or body hash.'); }
    const body = read(bodyPath).toString('utf8');
    const config = readJson(join(root, 'site-config.json'));
    requireCheck(manifest.newsletterUrl === config.subscriptions?.buttondownUrl && manifest.issueUrl === `${new URL(config.baseUrl).origin}/weeks/${expectedWeek}/` &&
      manifest.subject.includes(expectedWeek) && hasIssueLink(body, manifest.issueUrl), 'local_binding', 'The prepared draft does not bind to this newsletter and permanent issue URL.');
    const payload = { subject: manifest.subject, body: EDITOR + body, status: 'draft' };
    const payloadSha256 = sha(JSON.stringify(payload));
    let pending = existsSync(createPath) ? readJson(createPath) : null;
    if (pending) requireCheck(pending.week === expectedWeek && pending.testId === emailTestId && pending.issueUrl === manifest.issueUrl && pending.payloadSha256 === payloadSha256 && UUID.test(pending.idempotencyKey ?? ''),
      'create_binding', 'A previous create record differs; preserve it for manual recovery.');
    const client = request ?? createButtondownRequest({ apiToken });
    const call = options => {
      try {
        const result = client(options);
        requireCheck(result && typeof result === 'object' && typeof result.then !== 'function', 'api_shape', 'Expected a synchronous JSON API response.');
        return result;
      } catch (error) {
        if (error.buttondownSafe) throw error;
        throw failure(error.status === 401 || error.status === 403 ? 'api_auth_scope' : 'api_request', 'Buttondown request failed; preserve pending state and verify the remote outcome.');
      }
    };
    const details = new Map();
    const detail = id => {
      requireCheck(ID.test(id ?? ''), 'api_shape', 'Invalid email ID.');
      if (!details.has(id)) details.set(id, emailShape(call({ method: 'GET', path: `/v1/emails/${id}` }), id));
      return details.get(id);
    };
    const candidates = new Map();
    const consider = (email, pinned = false) => {
      const inScope = testMode ? email.subject.includes(emailTestId) : !isTest(email) && email.subject.includes(expectedWeek);
      const testIdentity = !testMode || email.subject.startsWith('[TEST · 不发送]') && normalizedBody(email.body).split('\n').includes(`标识：${emailTestId}`);
      const matches = inScope && testIdentity && email.subject.includes(expectedWeek) && hasIssueLink(email.body, manifest.issueUrl);
      if (pinned) requireCheck(matches, 'remote_binding', 'The recorded remote draft does not match this issue.');
      if (!inScope) return;
      requireCheck(matches, 'remote_conflict', 'An email for this date lacks the permanent issue link; preserve it for review.');
      candidates.set(email.id, email);
    };
    const ids = new Set();
    let count;
    for (let page = 1; page <= 10; page += 1) {
      const result = call({ method: 'GET', path: `/v1/emails?subject=${encodeURIComponent(searchSubject)}&page=${page}` });
      requireCheck(Array.isArray(result.results) && Number.isSafeInteger(result.count) && result.count >= 0 && (count === undefined || count === result.count), 'pagination', 'Email pagination lacks a stable total count.');
      count = result.count;
      for (const item of result.results) {
        requireCheck(item && ID.test(item.id ?? '') && !ids.has(item.id), 'pagination', 'Email pagination contains invalid or repeated IDs.');
        ids.add(item.id);
        if (typeof item.subject === 'string' && (testMode ? !item.subject.includes(emailTestId) : item.subject.startsWith('[TEST · 不发送]') || !item.subject.includes(expectedWeek))) continue;
        consider(detail(item.id));
      }
      requireCheck(ids.size <= count, 'pagination', 'Email pagination exceeds its declared count.');
      if (result.next === null || result.next === undefined) {
        requireCheck(ids.size === count, 'pagination', 'Email pagination is incomplete; no draft may be created.');
        break;
      }
      const next = new URL(result.next, ORIGIN);
      requireCheck(page < 10 && ids.size < count && next.origin === ORIGIN && next.pathname === '/v1/emails' && !next.hash && !next.username && !next.password &&
        next.searchParams.get('subject') === searchSubject && next.searchParams.get('page') === String(page + 1) && [...next.searchParams.keys()].sort().join(',') === 'page,subject',
      'pagination', 'Email pagination is untrusted, inconsistent, or exceeds ten pages.');
    }
    if (manifest.remote?.url) {
      const id = remoteId(manifest.remote.url);
      requireCheck(!manifest.remote.id || manifest.remote.id === id, 'remote_binding', 'Remote ID and URL disagree.');
      consider(detail(id), true);
    }
    if (pending?.remoteId) consider(detail(pending.remoteId), true);
    requireCheck(candidates.size <= 1, 'remote_conflict', 'Multiple emails match this issue; preserve all drafts for manual review.');
    let email = [...candidates.values()][0];
    const reused = Boolean(email);
    if (!email) {
      requireCheck(!pending, 'create_unresolved', 'An earlier create has an unresolved outcome; no new POST or idempotency key is allowed.');
      requireCheck(sha(read(manifestPath)) === sha(original) && sha(read(bodyPath)) === manifest.bodySha256 && sha(read(join(root, 'content', `${expectedWeek}.json`))) === manifest.inputSha256, 'local_binding', 'Local draft input changed during API verification.');
      pending = { schemaVersion: 1, week: expectedWeek, ...(testMode ? { testId: emailTestId } : {}), issueUrl: manifest.issueUrl, idempotencyKey: randomUUID(), payloadSha256, createdAt: new Date().toISOString(), status: 'pending_outcome', remoteId: null };
      // Exclusive creation prevents concurrent runners from issuing different keys.
      writeFileSync(createPath, jsonBytes(pending), { flag: 'wx', mode: 0o600 });
      const created = call({ method: 'POST', path: '/v1/emails', payload, idempotencyKey: pending.idempotencyKey });
      requireCheck(ID.test(created.id ?? ''), 'api_shape', 'Draft creation returned no valid email ID; verify the pending outcome.');
      pending = { ...pending, remoteId: created.id, status: 'pending_readback' };
      save(createPath, pending);
      email = detail(created.id);
      requireCheck(email.subject === payload.subject && normalizedBody(email.body) === normalizedBody(body), 'create_readback', 'Created draft content differs on readback; preserve it for review.');
    }
    if (email.status !== 'draft') throw Object.assign(failure('remote_status', 'The matching email is not a draft; no creation, update, or sending is allowed.'), { actualRemoteStatus: email.status });
    if (testMode) requireCheck(email.subject === payload.subject && normalizedBody(email.body) === normalizedBody(body), 'test_readback', 'The isolated test draft differs from its prepared content; preserve it for review.');
    requireCheck(sha(read(manifestPath)) === sha(original) && sha(read(bodyPath)) === manifest.bodySha256 && sha(read(join(root, 'content', `${expectedWeek}.json`))) === manifest.inputSha256, 'local_binding', 'Local draft state changed during synchronization; preserve it for review.');
    const remoteBodySha256 = sha(normalizedBody(email.body));
    const remote = { ...manifest.remote, id: email.id, status: 'draft', url: `https://buttondown.com/emails/${email.id}`, bodySha256: remoteBodySha256,
      verifiedAt: new Date().toISOString(), preservedExisting: reused, differsFromLocal: email.subject !== payload.subject || normalizedBody(email.body) !== normalizedBody(body),
      changedSinceLastVerification: Boolean(manifest.remote?.bodySha256 && manifest.remote.bodySha256 !== remoteBodySha256) };
    const updated = { ...manifest, status: testMode ? 'test_draft_verified' : 'awaiting_owner_review', remote };
    save(manifestPath, updated);
    if (pending) save(createPath, { ...pending, status: 'resolved', remoteId: email.id, resolvedAt: remote.verifiedAt });
    rmSync(errorPath, { force: true });
    rmSync(join(directory, 'sync-pending.json'), { force: true });
    return { status: updated.status, reused, url: remote.url, week: expectedWeek, ...(testMode ? { testId: emailTestId } : {}) };
  } catch (error) {
    const safe = error.buttondownSafe ? error : failure('local_state', 'Buttondown synchronization could not verify local state; preserve it for manual recovery.');
    if (existsSync(directory)) save(errorPath, { status: 'pending', week: expectedWeek, ...(testMode ? { testId: emailTestId } : {}), attemptedAt: new Date().toISOString(), code: safe.code, message: safe.message,
      ...(safe.actualRemoteStatus ? { actualRemoteStatus: safe.actualRemoteStatus } : {}) });
    throw safe;
  }
}
