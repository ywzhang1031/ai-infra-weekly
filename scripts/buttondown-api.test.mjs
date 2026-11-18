import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEmailDraft } from './email-draft.mjs';
import { createButtondownRequest, syncButtondownDraft } from './buttondown-api.mjs';

const roots = [];
const week = '2026-11-16';
const marker = '<!-- buttondown-editor-mode: plaintext -->\n';
const ids = ['em_existingformal0000000000001', 'em_secondformal00000000000002', 'em_createdformal0000000000003'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'infra-buttondown-'));
  roots.push(root);
  mkdirSync(join(root, 'content'));
  const issue = { date: week, title: '系统与通信', summary: '公开摘要。', tags: ['性能工程'], sourceHealth: 'degraded', progress: [],
    highlights: [{ title: 'Reading', summary: '保留来源与实验条件。' }] };
  const input = JSON.stringify(issue);
  json(join(root, 'content', `${week}.json`), issue);
  json(join(root, 'site-config.json'), { baseUrl: 'https://weekly.example.org', subscriptions: { buttondownStatus: 'active', buttondownUrl: 'https://buttondown.com/example' } });
  const routes = ['/', '/subscribe/', '/latest/', '/site.css', '/site.js', '/favicon.svg', '/feed.xml', '/sitemap.xml', `/weeks/${week}/`];
  for (const route of routes) {
    const target = join(root, 'dist', route.endsWith('/') ? `${route.slice(1)}index.html` : route.slice(1));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, input);
  }
  const publication = { status: 'published', latestWeek: week, url: 'https://weekly.example.org', version: 'test-version', checkedAt: '2026-11-18T15:00:00Z',
    checks: routes.map(path => ({ path, matched: true, sha256: hash(input) })) };
  json(join(root, 'publication-state.json'), publication);
  const draft = prepareEmailDraft({ root, expectedWeek: week, productionVerified: true, verifiedInputSha256: hash(input) });
  const body = readFileSync(draft.bodyPath, 'utf8');
  const directory = join(root, '.local-maintenance/newsletters', week);
  const email = { id: ids[0], subject: draft.manifest.subject, body: marker + body, status: 'draft' };
  return { root, issue, publication, ...draft, body, directory, email,
    createPath: join(directory, 'buttondown-create.json'), errorPath: join(directory, 'buttondown-sync-error.json') };
}

function api({ listed = [], pages, details = {}, create } = {}) {
  const calls = [];
  const request = args => {
    calls.push(structuredClone(args));
    if (args.method === 'GET' && args.path.startsWith('/v1/emails?')) {
      const url = new URL(args.path, 'https://api.buttondown.com');
      assert.equal(url.searchParams.get('subject'), week);
      assert.equal(url.searchParams.has('status'), false, 'Deduplicate across every email status');
      return structuredClone(pages ? pages[Number(url.searchParams.get('page') || '1') - 1] : { count: listed.length, next: null, results: listed });
    }
    if (args.method === 'GET' && args.path.startsWith('/v1/emails/')) {
      const id = args.path.slice('/v1/emails/'.length);
      const found = details[id] ?? listed.find(email => email.id === id);
      assert.ok(found, `Unexpected detail request for ${id}`);
      return structuredClone(found);
    }
    if (args.method === 'POST' && args.path === '/v1/emails' && create) return create(args);
    assert.fail(`Forbidden or unexpected request: ${args.method} ${args.path}`);
  };
  return { request, calls };
}
const sync = (f, request) => syncButtondownDraft({ root: f.root, expectedWeek: week, apiToken: 'fixture-token', request });
const assertNoPost = calls => assert.ok(calls.every(call => call.method === 'GET'));

test('preserves an existing formal draft and records its verified remote body without POST', () => {
  const f = fixture();
  f.email.body = marker + f.body.replace(/\n/g, '\r\n').trimEnd();
  f.manifest.remote.bodySha256 = hash(f.body);
  json(f.manifestPath, f.manifest);
  json(join(f.directory, 'sync-pending.json'), { status: 'pending' });
  const { request, calls } = api({ listed: [f.email] });
  const before = JSON.stringify(f.email);
  const result = sync(f, request);
  assert.equal(result.reused, true);
  assert.deepEqual(Object.keys(result).sort(), ['reused', 'status', 'url', 'week']);
  assert.equal(JSON.stringify(f.email), before);
  assertNoPost(calls);
  const manifest = readJson(f.manifestPath);
  assert.equal(manifest.status, 'awaiting_owner_review');
  assert.equal(manifest.remote.status, 'draft');
  assert.equal(manifest.remote.url, `https://buttondown.com/emails/${f.email.id}`);
  assert.equal(manifest.remote.bodySha256, hash(f.body), 'Ignore editor metadata, CRLF and missing terminal LF');
  assert.equal(manifest.remote.changedSinceLastVerification, false);
  assert.equal(manifest.remote.differsFromLocal, false);
  assert.equal(existsSync(join(f.directory, 'sync-pending.json')), false);
  assert.equal(readFileSync(f.bodyPath, 'utf8'), f.body);
});

test('a pinned draft with manual edits is preserved and reverified even when absent from the list', () => {
  const f = fixture();
  f.manifest.remote = { status: 'draft', url: `https://buttondown.com/emails/${f.email.id}`, bodySha256: hash(f.body), verifiedAt: '2026-11-18T15:00:00Z' };
  json(f.manifestPath, f.manifest);
  f.email.body += '\n作者手工补充：保留这一句。';
  f.email.subject += '（作者审阅版）';
  const { request, calls } = api({ details: { [f.email.id]: f.email } });
  const result = sync(f, request);
  assert.equal(result.reused, true);
  assertNoPost(calls);
  assert.equal(readJson(f.manifestPath).remote.bodySha256, hash(f.body + '\n作者手工补充：保留这一句。\n'));
  assert.equal(readJson(f.manifestPath).remote.changedSinceLastVerification, true);
  assert.equal(readFileSync(f.bodyPath, 'utf8'), f.body);
});

test('sent, scheduled and about_to_send records block creation rather than being duplicated', () => {
  for (const status of ['sent', 'scheduled', 'about_to_send']) {
    const f = fixture();
    const { request, calls } = api({ listed: [{ ...f.email, status }] });
    assert.throws(() => sync(f, request));
    assertNoPost(calls);
    assert.equal(existsSync(f.createPath), false);
    assert.equal(readJson(f.errorPath).status, 'pending');
    assert.equal(readJson(f.errorPath).actualRemoteStatus, status);
  }
});

test('creates only a Draft payload after persisting its UUID and hash, then reads back the email', () => {
  const f = fixture();
  const created = { ...f.email, id: ids[2], body: f.body.trimEnd().replace(/\n/g, '\r\n') };
  const { request, calls } = api({ details: { [created.id]: created }, create: args => {
    assert.equal(existsSync(f.createPath), true, 'Record uncertainty before the network write');
    const pending = readJson(f.createPath);
    assert.equal(pending.status, 'pending_outcome');
    assert.match(pending.idempotencyKey, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
    assert.equal(args.idempotencyKey, pending.idempotencyKey);
    assert.equal(pending.payloadSha256, hash(JSON.stringify(args.payload)));
    assert.deepEqual(Object.keys(args.payload).sort(), ['body', 'status', 'subject']);
    assert.deepEqual(args.payload, { subject: f.manifest.subject, body: marker + f.body, status: 'draft' });
    return created;
  } });
  assert.equal(sync(f, request).reused, false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(calls.some(call => call.method === 'GET' && call.path === `/v1/emails/${created.id}`));
  assert.equal(readJson(f.manifestPath).status, 'awaiting_owner_review');
  assert.equal(readJson(f.manifestPath).remote.url, `https://buttondown.com/emails/${created.id}`);
});

test('TEST subjects and BD-CREATE bodies are ignored while formal candidates still require detail reads', () => {
  const f = fixture();
  const tests = [{ ...f.email, subject: `[TEST · 不发送] ${f.manifest.subject}` },
    { ...f.email, id: ids[1], body: `BD-CREATE-probe\n${f.body}` }];
  const formal = { ...f.email, id: ids[2] };
  const { request, calls } = api({ listed: [...tests, { id: formal.id, subject: formal.subject }], details: { [formal.id]: formal } });
  assert.equal(sync(f, request).reused, true);
  assertNoPost(calls);
  assert.equal(readJson(f.manifestPath).remote.url, `https://buttondown.com/emails/${formal.id}`);
});

test('a TEST marker quoted inside a formal subject does not permit a duplicate creation', () => {
  const f = fixture();
  f.email.subject += '：说明 [TEST · 不发送] 标记的含义';
  const { request, calls } = api({ listed: [f.email] });
  assert.equal(sync(f, request).reused, true);
  assertNoPost(calls);
  assert.ok(calls.some(call => call.path === `/v1/emails/${f.email.id}`));
  assert.equal(readJson(f.manifestPath).remote.url, `https://buttondown.com/emails/${f.email.id}`);
});

test('reads every bounded page and does not mistake the first page for complete coverage', () => {
  const f = fixture();
  const testEmail = { ...f.email, id: ids[1], subject: `[TEST · 不发送] ${f.manifest.subject}` };
  const { request, calls } = api({ pages: [
    { count: 2, next: `https://api.buttondown.com/v1/emails?subject=${week}&page=2`, results: [testEmail] },
    { count: 2, next: null, results: [{ id: f.email.id, subject: f.email.subject }] },
  ], details: { [f.email.id]: f.email } });
  assert.equal(sync(f, request).reused, true);
  assert.equal(calls.filter(call => call.path.startsWith('/v1/emails?')).length, 2);
  assertNoPost(calls);
});

test('incomplete, unsafe and oversized pagination never permits a create', () => {
  for (const page of [{ results: [], next: null }, { count: 1, results: [] }, { count: 1, results: [], next: null },
    { count: 1, results: [], next: `https://other.example/v1/emails?subject=${week}&page=2` },
    { count: 1, results: [], next: 'https://api.buttondown.com/v1/emails?subject=2026-11-09&page=2' }]) {
    const f = fixture();
    const { request, calls } = api({ pages: [page] });
    assert.throws(() => sync(f, request));
    assertNoPost(calls);
    assert.equal(existsSync(f.createPath), false);
  }
  const f = fixture();
  const pages = Array.from({ length: 10 }, (_, index) => ({ count: 11,
    next: `https://api.buttondown.com/v1/emails?subject=${week}&page=${index + 2}`,
    results: [{ id: `em_test${index}`, subject: `[TEST · 不发送] ${week}`, body: 'test', status: 'draft' }] }));
  const { request, calls } = api({ pages });
  assert.throws(() => sync(f, request));
  assert.ok(calls.filter(call => call.path.startsWith('/v1/emails?')).length <= 10);
  assertNoPost(calls);
});

test('same-date drafts with a missing issue link and multiple formal matches require manual review', () => {
  for (const kind of ['missing-link', 'two-matches']) {
    const f = fixture();
    const listed = kind === 'missing-link' ? [{ ...f.email, body: '同日期的另一个草稿。' }] : [f.email, { ...f.email, id: ids[1] }];
    const { request, calls } = api({ listed });
    assert.throws(() => sync(f, request));
    assertNoPost(calls);
    assert.equal(existsSync(f.createPath), false);
  }
});

test('a pinned URL must match the week and issue, and cannot hide a second formal match', () => {
  for (const kind of ['wrong-week', 'wrong-link', 'two-matches']) {
    const f = fixture();
    f.manifest.remote.url = `https://buttondown.com/emails/${f.email.id}`;
    json(f.manifestPath, f.manifest);
    const pinned = { ...f.email };
    if (kind === 'wrong-week') pinned.subject = pinned.subject.replace(week, '2026-11-09');
    if (kind === 'wrong-link') pinned.body = pinned.body.replaceAll(`/weeks/${week}/`, '/weeks/2026-11-09/');
    const { request, calls } = api({ listed: kind === 'two-matches' ? [{ ...f.email, id: ids[1] }] : [], details: { [pinned.id]: pinned } });
    assert.throws(() => sync(f, request));
    assertNoPost(calls);
    assert.equal(existsSync(f.createPath), false);
  }
});

test('an uncertain POST is never retried automatically, including on the next run with no match', () => {
  const f = fixture();
  const original = readFileSync(f.manifestPath);
  const first = api({ create: () => { throw new Error('timeout; credential-like-provider-response'); } });
  assert.throws(() => sync(f, first.request));
  assert.equal(first.calls.filter(call => call.method === 'POST').length, 1);
  const pending = readJson(f.createPath);
  assert.equal(pending.status, 'pending_outcome');
  assert.deepEqual(readFileSync(f.manifestPath), original);
  assert.doesNotMatch(readFileSync(f.errorPath, 'utf8'), /credential-like-provider-response/);
  const second = api();
  assert.throws(() => sync(f, second.request));
  assertNoPost(second.calls);
  assert.equal(readJson(f.createPath).idempotencyKey, pending.idempotencyKey);
  assert.equal(readJson(f.createPath).payloadSha256, pending.payloadSha256);
});

test('the next run recovers an uncertain create by finding its existing draft without another POST', () => {
  const f = fixture();
  const first = api({ create: () => { throw new Error('timeout'); } });
  assert.throws(() => sync(f, first.request));
  const key = readJson(f.createPath).idempotencyKey;
  const second = api({ listed: [f.email] });
  assert.equal(sync(f, second.request).reused, true);
  assertNoPost(second.calls);
  assert.equal(readJson(f.createPath).idempotencyKey, key);
  assert.equal(readJson(f.manifestPath).remote.url, `https://buttondown.com/emails/${f.email.id}`);
});

test('created email readback must match the requested draft status, subject and full body', () => {
  for (const changed of [{ status: 'sent' }, { subject: `AI Infra Weekly ${week} another subject` }, { body: 'changed remote body' }]) {
    const f = fixture();
    const created = { ...f.email, id: ids[2] };
    const { request, calls } = api({ details: { [created.id]: { ...created, ...changed } }, create: () => created });
    assert.throws(() => sync(f, request));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(readJson(f.manifestPath).remote.url, null);
    assert.equal(existsSync(f.createPath), true);
    assert.equal(readJson(f.errorPath).status, 'pending');
  }
});

test('wrong-scope read failures preserve the local draft and never expose provider error bodies', () => {
  const f = fixture();
  const before = readFileSync(f.manifestPath);
  const calls = [];
  assert.throws(() => sync(f, args => {
    calls.push(args);
    throw Object.assign(new Error('provider body with secret fixture-token'), { code: 'auth_scope', status: 403 });
  }));
  assertNoPost(calls);
  assert.deepEqual(readFileSync(f.manifestPath), before);
  assert.equal(existsSync(f.createPath), false);
  assert.doesNotMatch(readFileSync(f.errorPath, 'utf8'), /provider body|fixture-token/);
});

test('local body hash, issue binding and publication mismatches are rejected before any API request', () => {
  for (const mutate of [
    f => writeFileSync(f.bodyPath, `${f.body}\nEdited locally`),
    f => json(f.manifestPath, { ...f.manifest, issueUrl: 'https://other.example/weeks/2026-11-16/' }),
    f => json(join(f.root, 'publication-state.json'), { ...f.publication, status: 'failed' }),
    f => json(join(f.root, 'content', `${week}.json`), { ...f.issue, progress: ['private learning'] }),
  ]) {
    const f = fixture();
    mutate(f);
    let calls = 0;
    assert.throws(() => sync(f, () => { calls += 1; assert.fail('No API request is authorized'); }));
    assert.equal(calls, 0);
    assert.equal(existsSync(f.createPath), false);
  }
});

test('request factory rejects other origins, methods and send routes before loading a credential', () => {
  const request = createButtondownRequest({ apiToken: 'fixture-token' });
  for (const args of [
    { method: 'PATCH', path: `/v1/emails/${ids[0]}` },
    { method: 'POST', path: `/v1/emails/${ids[0]}/send` },
    { method: 'GET', path: 'https://other.example/v1/emails' },
    { method: 'GET', path: '/v1/subscribers' },
    { method: 'POST', path: '/v1/emails', payload: { subject: 'test', body: 'test', status: 'sent' }, idempotencyKey: '00000000-0000-4000-8000-000000000000' },
  ]) assert.throws(() => request(args));
});

test('default curl transport keeps credentials in stdin, enforces safe flags and sanitizes failures', () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  const capture = join(f.root, 'requests.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(process.env.BD_TEST_CAPTURE,JSON.stringify({args:process.argv.slice(2),config:fs.readFileSync(0,'utf8'),key:process.env.BUTTONDOWN_API_KEY,proxy:process.env.HTTPS_PROXY})+'\\n');
const mode=process.env.BD_TEST_RESPONSE;
process.stderr.write('provider-stderr-with-secret');
process.stdout.write((mode==='403'?'provider-body-with-secret':JSON.stringify({id:'${ids[2]}',status:'draft'}))+'\\n__BUTTONDOWN_HTTP__'+(mode==='403'?'403':mode==='timeout'?'000':'201')+'\\n');
if(mode==='timeout') process.exitCode=28;
`, { mode: 0o755 });
  const names = ['PATH', 'BUTTONDOWN_API_KEY', 'HTTPS_PROXY', 'BD_TEST_CAPTURE', 'BD_TEST_RESPONSE'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, BUTTONDOWN_API_KEY: 'unused-env-secret', HTTPS_PROXY: 'http://127.0.0.1:9999', BD_TEST_CAPTURE: capture, BD_TEST_RESPONSE: '201' });
    const request = createButtondownRequest({ apiToken: 'fixture-secret' });
    const idempotencyKey = '00000000-0000-4000-8000-000000000000';
    const payload = { subject: `AI Infra Weekly ${week}`, body: `${marker}**中文 "quote" \\**\n`, status: 'draft' };
    assert.equal(request({ method: 'POST', path: '/v1/emails', payload, idempotencyKey }).status, 'draft');
    const sent = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)[0];
    assert.doesNotMatch(JSON.stringify(sent.args), /fixture-secret|unused-env-secret|中文/);
    assert.equal(sent.args[0], '--disable');
    assert.equal(sent.args[sent.args.indexOf('--proto') + 1], '=https');
    assert.equal(sent.args[sent.args.indexOf('--retry') + 1], '0');
    assert.equal(sent.args[sent.args.indexOf('--config') + 1], '-');
    assert.ok(!sent.args.some(arg => ['--location', '-L', '--insecure', '-k'].includes(arg)));
    assert.equal(sent.key, undefined);
    assert.equal(sent.proxy, 'http://127.0.0.1:9999');
    assert.match(sent.config, /Authorization: Token fixture-secret/);
    assert.match(sent.config, /X-API-Version: 2026-04-01/);
    assert.match(sent.config, /X-Idempotency-Key: 00000000-0000-4000-8000-000000000000/);
    assert.match(sent.config, /url = "https:\/\/api\.buttondown\.com\/v1\/emails"/);
    const data = sent.config.split('\n').find(line => line.startsWith('data-raw = '));
    assert.deepEqual(JSON.parse(JSON.parse(data.slice('data-raw = '.length))), payload);
    process.env.BD_TEST_RESPONSE = '403';
    assert.throws(() => request({ method: 'GET', path: `/v1/emails/${ids[0]}` }), error => {
      assert.equal(error.code, 'api_auth_scope');
      assert.doesNotMatch(error.message, /provider-|fixture-secret|unused-env-secret/);
      return true;
    });
    process.env.BD_TEST_RESPONSE = 'timeout';
    assert.throws(() => request({ method: 'POST', path: '/v1/emails', payload, idempotencyKey }), error => {
      assert.equal(error.code, 'api_transport');
      assert.doesNotMatch(error.message, /provider-|fixture-secret|unused-env-secret/);
      return true;
    });
    assert.equal(readFileSync(capture, 'utf8').trim().split('\n').length, 3, 'No automatic POST retry');
  } finally {
    for (const name of names) before[name] === undefined ? delete process.env[name] : process.env[name] = before[name];
  }
});
