import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailDraftDirectory, parseEmailOptions, prepareEmailDraft } from './email-draft.mjs';

const roots = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const week = '2026-11-16';
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
const productionBatchStub = `
let index=0;
for(let i=2;i<process.argv.length;i+=1) if(process.argv[i]==='--output') {
  const route=new URL(process.argv[i+2]).pathname;
  fs.writeFileSync(process.argv[i+1],fs.readFileSync('dist/'+(route.endsWith('/')?route.slice(1)+'index.html':route.slice(1))));
  process.stdout.write('__INFRA_PRODUCTION_BATCH__\\t'+index+'\\t200\\t0\\t0.0001\\t0.0003\\t0.9\\t1.0\\t1.1\\t0\\t'+(index===0?1:0)+'\\t0\\n');
  index+=1;
}
`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'infra-email-'));
  roots.push(root);
  mkdirSync(join(root, 'content'));
  mkdirSync(join(root, 'scripts'));
  const issue = { date: week, title: '系统与通信', summary: '一个公开的技术摘要。', tags: ['性能工程'], sourceHealth: 'degraded', progress: [],
    highlights: [1, 2, 3, 4].map(index => ({ title: `Reading ${index}`, summary: '保留来源条件。' })) };
  json(join(root, 'content', `${week}.json`), issue);
  json(join(root, 'site-config.json'), { baseUrl: 'https://weekly.example.org', subscriptions: { buttondownStatus: 'active', buttondownUrl: 'https://buttondown.com/example' } });
  const routes = ['/', '/subscribe/', '/latest/', '/site.css', '/site.js', '/favicon.svg', '/feed.xml', '/sitemap.xml', `/weeks/${week}/`];
  for (const route of routes) {
    const relative = route.endsWith('/') ? `${route.slice(1)}index.html` : route.slice(1);
    const target = join(root, 'dist', relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(issue));
  }
  const publication = { status: 'published', latestWeek: week, url: 'https://weekly.example.org', version: 'test-version', checkedAt: '2026-11-18T15:00:00Z',
    checks: routes.map(path => ({ path, matched: true, sha256: hash(JSON.stringify(issue)) })) };
  json(join(root, 'publication-state.json'), publication);
  // Simulate the preflight rebuild to prove a stale publication receipt rejects edited source.
  writeFileSync(join(root, 'scripts/check.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
const input=readFileSync('content/${week}.json');
for(const route of ${JSON.stringify(routes)}) writeFileSync('dist/'+(route.endsWith('/')?route.slice(1)+'index.html':route.slice(1)),input);
`);
  return { root, issue, publication, options: { root, expectedWeek: week, productionVerified: true, verifiedInputSha256: hash(JSON.stringify(issue)) } };
}

test('prepares one draft with permanent links and preserves a reviewed remote record on repeat', () => {
  const { options } = fixture();
  const first = prepareEmailDraft(options);
  const body = readFileSync(first.bodyPath, 'utf8');
  assert.equal((body.match(/^### /gm) || []).length, 3);
  assert.match(body, /https:\/\/weekly\.example\.org\/weeks\/2026-11-16\//);
  assert.match(body, /<span style="color:#ffffff;">/);
  assert.doesNotMatch(body, /^# /m);
  first.manifest.status = 'awaiting_owner_review';
  first.manifest.remote = { status: 'draft', url: 'https://buttondown.com/emails/em_existing', bodySha256: 'reviewed-by-owner', verifiedAt: '2026-11-18T16:00:00Z' };
  json(first.manifestPath, first.manifest);
  const before = readFileSync(first.manifestPath, 'utf8');
  const second = prepareEmailDraft(options);
  assert.equal(second.reused, true);
  assert.equal(readFileSync(first.manifestPath, 'utf8'), before);
});

test('isolated tests keep the real issue and never-send identity without touching a sent formal manifest', () => {
  const { root, options } = fixture();
  const formal = prepareEmailDraft(options);
  formal.manifest.status = 'sent';
  formal.manifest.remote = { status: 'sent', url: 'https://buttondown.com/emails/em_formalsent' };
  json(formal.manifestPath, formal.manifest);
  const before = [readFileSync(formal.manifestPath), readFileSync(formal.bodyPath)];
  const emailTestId = 'BD-CREATE-E2E-fixture-1';
  const first = prepareEmailDraft({ ...options, emailTestId });
  assert.equal(first.manifestPath, join(root, '.local-maintenance/newsletter-tests', week, emailTestId, 'manifest.json'));
  assert.equal(first.manifest.testId, emailTestId);
  assert.equal(first.manifest.sendPolicy, 'never_send');
  assert.equal(first.manifest.week, week);
  assert.equal(first.manifest.issueUrl, formal.manifest.issueUrl);
  assert.equal(first.manifest.inputSha256, formal.manifest.inputSha256);
  assert.match(first.manifest.subject, /^\[TEST · 不发送\]/);
  assert.ok(first.manifest.subject.includes(emailTestId));
  assert.ok(readFileSync(first.bodyPath, 'utf8').includes(`标识：${emailTestId}\n`));
  assert.equal(prepareEmailDraft({ ...options, emailTestId }).reused, true);
  assert.deepEqual([readFileSync(formal.manifestPath), readFileSync(formal.bodyPath)], before);
  first.manifest.sendPolicy = 'owner_confirmation_required';
  json(first.manifestPath, first.manifest);
  assert.throws(() => prepareEmailDraft({ ...options, emailTestId }), /identity differs/);
});

test('test IDs and CLI arguments reject ambiguity and path traversal before preparation', () => {
  const { root, options } = fixture();
  for (const emailTestId of ['', null, 'regular-id', 'BD-CREATE-E2E-../escape', 'BD-CREATE-E2E-', `BD-CREATE-E2E-${'x'.repeat(61)}`]) {
    assert.throws(() => prepareEmailDraft({ ...options, emailTestId }), /email-test-id/);
  }
  assert.equal(existsSync(join(root, '.local-maintenance')), false);
  const valid = ['--expected-week', week, '--email-test-id', 'BD-CREATE-E2E-abc'];
  assert.deepEqual(parseEmailOptions(valid), { expectedWeek: week, emailTestId: 'BD-CREATE-E2E-abc' });
  assert.equal(emailDraftDirectory({ root, ...parseEmailOptions(valid) }), join(root, '.local-maintenance/newsletter-tests', week, 'BD-CREATE-E2E-abc'));
  for (const args of [valid.slice(0, -1), [...valid, '--email-test-id', 'BD-CREATE-E2E-def'], [...valid, '--expected-week', week],
    [...valid, '--unknown'], [...valid, 'toString', 'x'], [...valid, '--verify-only', '--verify-only']]) {
    assert.throws(() => parseEmailOptions(args, { allowVerifyOnly: true }));
  }
});

test('rejects unpublished or wrong-week state without creating a draft', () => {
  const { root, options, publication } = fixture();
  publication.status = 'failed';
  json(join(root, 'publication-state.json'), publication);
  assert.throws(() => prepareEmailDraft(options), /Publication state/);
  assert.equal(existsSync(join(root, '.local-maintenance')), false);
  assert.throws(() => prepareEmailDraft({ ...options, expectedWeek: '2026-11-09' }), /latest public issue/);
  assert.throws(() => prepareEmailDraft({ ...options, expectedWeek: '2026-02-30' }), /real date/);
});

test('rejects incomplete, duplicate, and failed route receipts', () => {
  const { root, options, publication } = fixture();
  const checks = structuredClone(publication.checks);
  for (const invalid of [checks.slice(1), [...checks.slice(1), checks[1]], checks.map((check, index) => index ? check : { ...check, matched: false })]) {
    json(join(root, 'publication-state.json'), { ...publication, checks: invalid });
    assert.throws(() => prepareEmailDraft(options), /route/);
  }
});

test('a rebuild cannot use an old deployment receipt to approve edited public content', () => {
  const { root, options, issue } = fixture();
  json(join(root, 'content', `${week}.json`), { ...issue, summary: '尚未发布的新摘要。' });
  let onlineReads = 0;
  assert.throws(() => prepareEmailDraft({ ...options, productionVerified: false, verifyOnline: () => { onlineReads += 1; } }), /differs from the verified deployment/);
  assert.equal(onlineReads, 0);
});

test('reused production verification rejects input changed while checked dist remains unchanged', () => {
  const { root, options, issue } = fixture();
  json(join(root, 'content', `${week}.json`), { ...issue, summary: '生产验收过程中被编辑的摘要。' });
  assert.throws(() => prepareEmailDraft(options), /changed since the verified build/);
  assert.equal(existsSync(join(root, '.local-maintenance')), false);
  assert.throws(() => prepareEmailDraft({ ...options, verifiedInputSha256: undefined }), /build input hash is required/);
});

test('standalone generation performs one online issue verification, and failure writes no draft', () => {
  const { root, options } = fixture();
  let reads = 0;
  assert.throws(() => prepareEmailDraft({ ...options, productionVerified: false, verifyOnline: () => { reads += 1; throw new Error('offline'); } }), /offline/);
  assert.equal(reads, 1);
  assert.equal(existsSync(join(root, '.local-maintenance')), false);
  prepareEmailDraft({ ...options, productionVerified: false, verifyOnline: (url, expected) => {
    reads += 1;
    assert.equal(url, 'https://weekly.example.org/weeks/2026-11-16/');
    assert.match(expected, /^[a-f0-9]{64}$/);
  } });
  assert.equal(reads, 2);
});

test('preserves hand-edited local body and changed-source draft instead of overwriting', () => {
  const { root, options, issue, publication } = fixture();
  const draft = prepareEmailDraft(options);
  const original = readFileSync(draft.bodyPath, 'utf8');
  writeFileSync(draft.bodyPath, `${original}\n人工批注`);
  assert.throws(() => prepareEmailDraft(options), /edited or removed/);
  assert.match(readFileSync(draft.bodyPath, 'utf8'), /人工批注/);
  writeFileSync(draft.bodyPath, original);
  const changed = JSON.stringify({ ...issue, summary: '更新且重新发布的摘要。' });
  writeFileSync(join(root, 'content', `${week}.json`), changed);
  for (const check of publication.checks) {
    writeFileSync(join(root, 'dist', check.path.endsWith('/') ? `${check.path.slice(1)}index.html` : check.path.slice(1)), changed);
    check.sha256 = hash(changed);
  }
  json(join(root, 'publication-state.json'), publication);
  options.verifiedInputSha256 = hash(changed);
  assert.throws(() => prepareEmailDraft(options), /preserved for review/);
  assert.equal(readFileSync(draft.bodyPath, 'utf8'), original);
});

test('rejects nonempty personal progress even with a matching artifact receipt', () => {
  const { root, options, issue } = fixture();
  const changed = { ...issue, progress: ['private learning'] };
  json(join(root, 'content', `${week}.json`), changed);
  options.verifiedInputSha256 = hash(JSON.stringify(changed));
  assert.throws(() => prepareEmailDraft(options), /progress=\[\]/);
});

test('verified publication stays published when preparing the email fails', () => {
  const { root } = fixture();
  const config = JSON.parse(readFileSync(join(root, 'site-config.json')));
  config.subscriptions.buttondownStatus = 'pending_review';
  json(join(root, 'site-config.json'), config);
  writeFileSync(join(root, 'publish.mjs'), readFileSync(new URL('../publish.mjs', import.meta.url)));
  for (const file of ['email-draft.mjs', 'email-sync.mjs', 'buttondown-api.mjs', 'buttondown-credential.mjs']) {
    writeFileSync(join(root, 'scripts', file), readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  writeFileSync(join(root, 'scripts/production-read.mjs'), readFileSync(new URL('./production-read.mjs', import.meta.url)));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('node:fs');
${productionBatchStub}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['publish.mjs', '--expected-week', week, '--verify-only'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'publication-state.json'))).status, 'published');
  assert.equal(existsSync(join(root, 'publication-last-error.json')), false);
  const error = JSON.parse(readFileSync(join(root, '.local-maintenance/newsletters', week, 'generation-error.json')));
  assert.equal(error.status, 'pending');
  assert.match(error.message, /active, verified Buttondown/);
});

test('two TLS timeouts preserve the successful publication receipt and create no email draft', () => {
  const { root } = fixture();
  const receiptPath = join(root, 'publication-state.json');
  const previousReceipt = readFileSync(receiptPath);
  writeFileSync(join(root, 'publish.mjs'), readFileSync(new URL('../publish.mjs', import.meta.url)));
  for (const file of ['email-draft.mjs', 'email-sync.mjs', 'buttondown-api.mjs', 'buttondown-credential.mjs']) {
    writeFileSync(join(root, 'scripts', file), readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  writeFileSync(join(root, 'scripts/production-read.mjs'), readFileSync(new URL('./production-read.mjs', import.meta.url)));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync('curl-attempts.txt','attempt\\n');
process.stdout.write('__INFRA_PRODUCTION_BATCH__\\t0\\t000\\t28\\t0.0001\\t0.000293\\t0\\t0\\t5.006781\\t1\\t0\\t0\\n');
process.exitCode=28;
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['publish.mjs', '--expected-week', week, '--verify-only'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(root, 'curl-attempts.txt'), 'utf8'), 'attempt\nattempt\n');
  assert.deepEqual(readFileSync(receiptPath), previousReceipt, 'Keep the last successful receipt byte for byte');
  const directory = join(root, '.local-maintenance/newsletters', week);
  assert.equal(existsSync(join(directory, 'manifest.json')), false);
  assert.equal(existsSync(join(directory, 'draft.md')), false);
  assert.equal(existsSync(directory), false, 'Do not enter email generation after failed verification');
  const error = JSON.parse(readFileSync(join(root, 'publication-last-error.json')));
  assert.equal(error.status, 'failed');
  assert.equal(error.expectedWeek, week);
  assert.equal(error.version, 'test-version');
  assert.match(error.message, /Production batch failed/);
  assert.match(error.message, /attempt=1, route=\/, phase=tls_handshake, curl_exit=28/);
  assert.match(error.message, /attempt=2, route=\/, phase=tls_handshake, curl_exit=28/);
});


test('verified publication remains published when the Buttondown API rejects credentials', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'publish.mjs'), readFileSync(new URL('../publish.mjs', import.meta.url)));
  for (const file of ['email-draft.mjs', 'email-sync.mjs', 'buttondown-api.mjs', 'buttondown-credential.mjs', 'production-read.mjs']) {
    writeFileSync(join(root, 'scripts', file), readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--config')) {
  const config=fs.readFileSync(0,'utf8');
  if(!config.includes('request = "GET"')) process.exit(99);
  fs.appendFileSync('api-reads.txt','GET\\n');
  process.stdout.write('{}\\n__BUTTONDOWN_HTTP__401\\n');
} else {
  ${productionBatchStub}
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['publish.mjs', '--expected-week', week, '--verify-only'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BUTTONDOWN_API_KEY: 'fixture-only', PATH: `${join(root, 'bin')}:${process.env.PATH}` }, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'publication-state.json'))).status, 'published');
  assert.equal(existsSync(join(root, 'publication-last-error.json')), false);
  assert.equal(readFileSync(join(root, 'api-reads.txt'), 'utf8'), 'GET\n');
  const directory = join(root, '.local-maintenance/newsletters', week);
  assert.equal(existsSync(join(directory, 'draft.md')), true);
  assert.equal(existsSync(join(directory, 'buttondown-create.json')), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'buttondown-sync-error.json'))).code, 'api_auth_scope');
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only/);
});

function publishTestFixture() {
  const f = fixture();
  const formal = prepareEmailDraft(f.options);
  formal.manifest.status = 'sent';
  formal.manifest.remote = { status: 'sent', id: 'em_formalsent', url: 'https://buttondown.com/emails/em_formalsent' };
  json(formal.manifestPath, formal.manifest);
  const historicalError = join(f.root, '.local-maintenance/newsletters', week, 'generation-error.json');
  json(historicalError, { status: 'historical', message: 'Preserve the formal record.' });
  const formalPaths = [formal.manifestPath, formal.bodyPath, historicalError];
  const formalBytes = formalPaths.map(path => readFileSync(path));
  writeFileSync(join(f.root, 'publish.mjs'), readFileSync(new URL('../publish.mjs', import.meta.url)));
  for (const file of ['email-draft.mjs', 'email-sync.mjs', 'buttondown-api.mjs', 'buttondown-credential.mjs', 'production-read.mjs']) {
    writeFileSync(join(f.root, 'scripts', file), readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  const originalEmail = { id: 'em_formalsent', status: 'sent', subject: formal.manifest.subject, body: readFileSync(formal.bodyPath, 'utf8') };
  json(join(f.root, 'api-db.json'), [originalEmail]);
  mkdirSync(join(f.root, 'bin'));
  writeFileSync(join(f.root, 'bin/curl'), `#!${process.execPath}
const fs=require('node:fs');
const event=value=>fs.appendFileSync('events.jsonl',JSON.stringify(value)+'\\n');
if(process.argv.includes('--config')) {
  const config=fs.readFileSync(0,'utf8');
  const get=name=>JSON.parse(config.split('\\n').find(line=>line.startsWith(name+' = ')).slice(name.length+3));
  const url=new URL(get('url'));
  const method=get('request');
  event({kind:'api',method,path:url.pathname});
  if(process.env.FIXTURE_FAILURE==='api') {process.stdout.write('{}\\n__BUTTONDOWN_HTTP__401\\n');process.exit(0);}
  const emails=JSON.parse(fs.readFileSync('api-db.json'));
  let result;
  if(method==='GET'&&url.pathname==='/v1/emails') {
    const matches=emails.filter(email=>email.subject.includes(url.searchParams.get('subject')));
    result={count:matches.length,next:null,results:matches};
  } else if(method==='GET') result=emails.find(email=>email.id===url.pathname.split('/').at(-1));
  else if(method==='POST'&&url.pathname==='/v1/emails') {
    const payload=JSON.parse(get('data-raw'));
    if(payload.status!=='draft'||Object.keys(payload).sort().join(',')!=='body,status,subject'||!payload.subject.startsWith('[TEST · 不发送]')) process.exit(99);
    result={id:'em_e2etestdraft',...payload};emails.push(result);fs.writeFileSync('api-db.json',JSON.stringify(emails));
  } else process.exit(99);
  if(!result) process.exit(98);
  process.stdout.write(JSON.stringify(result)+'\\n__BUTTONDOWN_HTTP__'+(method==='POST'?'201':'200')+'\\n');
} else {
  let index=0;
  for(let i=2;i<process.argv.length;i+=1) if(process.argv[i]==='--output') {
    const route=new URL(process.argv[i+2]).pathname;
    event({kind:'production',route});
    const content=fs.readFileSync('dist/'+(route.endsWith('/')?route.slice(1)+'index.html':route.slice(1)));
    fs.writeFileSync(process.argv[i+1],process.env.FIXTURE_FAILURE==='production'&&index===0?'different production artifact':content);
    process.stdout.write('__INFRA_PRODUCTION_BATCH__\\t'+index+'\\t200\\t0\\t0.0001\\t0.0003\\t0.9\\t1.0\\t1.1\\t0\\t'+(index===0?1:0)+'\\t0\\n');index+=1;
  }
}
`, { mode: 0o755 });
  const emailTestId = 'BD-CREATE-E2E-publish-fixture';
  const args = ['publish.mjs', '--expected-week', week, '--verify-only', '--email-test-id', emailTestId];
  const run = ({ failure = '', command = args } = {}) => spawnSync(process.execPath, command, {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, BUTTONDOWN_API_KEY: 'fixture-only', FIXTURE_FAILURE: failure, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` }, timeout: 15_000,
  });
  const events = () => existsSync(join(f.root, 'events.jsonl')) ? readFileSync(join(f.root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const unchanged = () => {
    assert.deepEqual(formalPaths.map(path => readFileSync(path)), formalBytes);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'api-db.json')))[0], originalEmail);
  };
  return { ...f, run, events, unchanged, emailTestId, directory: join(f.root, '.local-maintenance/newsletter-tests', week, emailTestId) };
}

test('publish verifies every route before its real hook creates an isolated test, then reuses it', () => {
  const f = publishTestFixture();
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /test_draft_verified/);
  const events = f.events();
  const firstApi = events.findIndex(event => event.kind === 'api');
  assert.equal(firstApi, f.publication.checks.length, 'All configured production routes must precede the API hook');
  assert.equal(events.filter(event => event.method === 'POST').length, 1);
  const receipt = JSON.parse(readFileSync(join(f.root, 'publication-state.json')));
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.checks.length, f.publication.checks.length);
  assert.equal(receipt.checks.reduce((sum, check) => sum + check.transport.newConnections, 0), 1);
  const manifestPath = join(f.directory, 'manifest.json');
  const firstManifest = JSON.parse(readFileSync(manifestPath));
  const firstCreate = JSON.parse(readFileSync(join(f.directory, 'buttondown-create.json')));
  assert.equal(firstManifest.testId, f.emailTestId);
  assert.equal(firstManifest.sendPolicy, 'never_send');
  assert.equal(firstManifest.status, 'test_draft_verified');
  assert.equal(firstManifest.publication.issueSha256, f.publication.checks.at(-1).sha256);
  f.unchanged();
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  const nextEvents = f.events().slice(events.length);
  assert.equal(nextEvents.filter(event => event.kind === 'production').length, f.publication.checks.length);
  assert.ok(nextEvents.filter(event => event.kind === 'api').every(event => event.method === 'GET'));
  const secondManifest = JSON.parse(readFileSync(manifestPath));
  assert.equal(secondManifest.remote.id, firstManifest.remote.id);
  assert.equal(secondManifest.remote.preservedExisting, true);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'buttondown-create.json'))).idempotencyKey, firstCreate.idempotencyKey);
  f.unchanged();
});

test('production failure never enters the test hook; API failure preserves website success and isolated pending', () => {
  for (const failure of ['production', 'api']) {
    const f = publishTestFixture();
    const result = f.run({ failure });
    assert.equal(result.status, 1, result.stderr);
    if (failure === 'production') {
      assert.equal(f.events().some(event => event.kind === 'api'), false);
      assert.equal(existsSync(f.directory), false);
      assert.equal(existsSync(join(f.root, 'publication-last-error.json')), true);
    } else {
      assert.equal(JSON.parse(readFileSync(join(f.root, 'publication-state.json'))).status, 'published');
      assert.equal(existsSync(join(f.root, 'publication-last-error.json')), false);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'generation-error.json'))).testId, f.emailTestId);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'buttondown-sync-error.json'))).code, 'api_auth_scope');
      assert.equal(existsSync(join(f.directory, 'buttondown-create.json')), false);
    }
    f.unchanged();
  }
});

test('publish rejects incomplete, duplicate and unsafe test CLI flags before network or state writes', () => {
  const f = publishTestFixture();
  const publication = readFileSync(join(f.root, 'publication-state.json'));
  const base = ['publish.mjs', '--expected-week', week, '--verify-only'];
  for (const extra of [['--email-test-id'], ['--email-test-id', ''], ['--email-test-id', '../newsletters'],
    ['--email-test-id', f.emailTestId, '--email-test-id', f.emailTestId]]) {
    assert.equal(f.run({ command: [...base, ...extra] }).status, 1);
  }
  assert.equal(f.events().length, 0);
  assert.equal(existsSync(f.directory), false);
  assert.equal(existsSync(join(f.root, 'publication-last-error.json')), false);
  assert.deepEqual(readFileSync(join(f.root, 'publication-state.json')), publication);
  f.unchanged();
});
