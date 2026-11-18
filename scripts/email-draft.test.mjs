import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEmailDraft } from './email-draft.mjs';

const roots = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const week = '2026-11-16';
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
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
  writeFileSync(join(root, 'scripts/email-draft.mjs'), readFileSync(new URL('./email-draft.mjs', import.meta.url)));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/curl'), `#!${process.execPath}
const fs=require('node:fs');
const route=new URL(process.argv.at(-1)).pathname;
process.stdout.write(fs.readFileSync('dist/'+(route.endsWith('/')?route.slice(1)+'index.html':route.slice(1))));
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
