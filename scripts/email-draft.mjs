import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProduction } from './production-read.mjs';

// Local draft preparation only. This module has no provider credentials or sending API.
const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
const markdown = value => String(value).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\s+/g, ' ').trim();

function validateIdentity({ expectedWeek, emailTestId }) {
  requireCheck(typeof expectedWeek === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expectedWeek), 'Pass --expected-week YYYY-MM-DD.');
  const date = new Date(`${expectedWeek}T00:00:00Z`);
  requireCheck(Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === expectedWeek, 'The expected week must be a real date.');
  requireCheck(emailTestId === undefined || typeof emailTestId === 'string' && /^BD-CREATE-E2E-[A-Za-z0-9-]{1,60}$/.test(emailTestId), 'Pass a valid --email-test-id BD-CREATE-E2E-<identifier>.');
}

export function emailDraftDirectory({ root = defaultRoot, expectedWeek, emailTestId }) {
  validateIdentity({ expectedWeek, emailTestId });
  return emailTestId === undefined ? join(root, '.local-maintenance', 'newsletters', expectedWeek)
    : join(root, '.local-maintenance', 'newsletter-tests', expectedWeek, emailTestId);
}

export function parseEmailOptions(args, { allowVerifyOnly = false } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--verify-only' && allowVerifyOnly && options.verifyOnly === undefined) options.verifyOnly = true;
    else {
      const key = flag === '--expected-week' ? 'expectedWeek' : flag === '--email-test-id' ? 'emailTestId' : null;
      requireCheck(key && options[key] === undefined && index + 1 < args.length && !args[index + 1].startsWith('--'), 'Invalid, duplicate, or incomplete email publication arguments.');
      options[key] = args[++index];
    }
  }
  validateIdentity(options);
  return options;
}

function read(root, file) {
  const target = join(root, file);
  const stat = lstatSync(target);
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Invalid bounded regular file: ${file}`);
  return readFileSync(target);
}
const readJson = (root, file) => JSON.parse(read(root, file).toString('utf8'));

function verifyIssueOnline(url, expectedHash) {
  const body = readProduction(url);
  requireCheck(sha256(body) === expectedHash, 'The online issue differs from the published artifact; no draft was prepared.');
}

function bodyFor(issue, base) {
  const issueUrl = `${base}/weeks/${issue.date}/`;
  const highlights = issue.highlights.filter(item => !item.extension).slice(0, 3);
  return [
    `**${issue.tags.slice(0, 4).map(markdown).join(' · ')}**`, '', markdown(issue.summary), '',
    `<p><a href="${issueUrl}" style="display:inline-block;background:#183a32;padding:14px 20px;text-decoration:none;font-weight:700;border-radius:6px;"><span style="color:#ffffff;">阅读本期完整周报 →</span></a></p>`, '',
    '全文包含原始来源、实验条件、机制分析与尚未验证的部分。', '',
    ...(highlights.length ? ['---', '', '## 本期重点', '', ...highlights.flatMap((item, index) => [
      `### ${String(index + 1).padStart(2, '0')} · ${markdown(item.title)}`, '', markdown(item.summary), '',
    ])] : []),
    '---', '', '**继续阅读**', '',
    `[阅读本期全文](${issueUrl}) · [查看最新一期](${base}/latest/) · [浏览历史归档](${base}/#archive)`, '',
    `*证据说明：本期来源状态为 ${markdown(issue.sourceHealth)}。文中实验结果归属于原始来源，未经本站独立复现；完整覆盖说明见正文。*`, '',
    'Evan · AI Infra Weekly', '',
  ].join('\n');
}

export function prepareEmailDraft({ root = defaultRoot, expectedWeek, emailTestId, productionVerified = false, verifiedInputSha256, verifyOnline = verifyIssueOnline } = {}) {
  const directory = emailDraftDirectory({ root, expectedWeek, emailTestId });
  const weeks = readdirSync(join(root, 'content')).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().reverse();
  requireCheck(weeks[0] === `${expectedWeek}.json`, 'Only the latest public issue can prepare a weekly email draft.');
  const inputFile = `content/${expectedWeek}.json`;
  const expectedInputHash = productionVerified ? verifiedInputSha256 : sha256(read(root, inputFile));
  requireCheck(/^[a-f0-9]{64}$/.test(expectedInputHash ?? ''), 'A verified build input hash is required when reusing production verification.');
  // Rebuilding binds the current JSON to the checked HTML, so an old receipt cannot approve edited content.
  if (!productionVerified) {
    const check = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit', timeout: 30_000 });
    requireCheck(!check.error && check.status === 0, 'Public content checks failed; no email draft was prepared.');
  }
  const config = readJson(root, 'site-config.json');
  const origin = new URL(config.baseUrl);
  requireCheck(origin.protocol === 'https:' && !origin.username && !origin.password && !origin.port && origin.pathname === '/' && !origin.search && !origin.hash &&
    origin.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(origin.hostname), 'The production origin must be public HTTPS.');
  const base = origin.origin;
  requireCheck(config.subscriptions?.buttondownStatus === 'active' && /^https:\/\/buttondown\.com\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/?$/.test(config.subscriptions.buttondownUrl), 'Configure an active, verified Buttondown newsletter first.');
  const publicationBytes = read(root, 'publication-state.json');
  const publication = JSON.parse(publicationBytes);
  requireCheck(publication.status === 'published' && publication.latestWeek === expectedWeek && publication.url === base && Number.isFinite(Date.parse(publication.checkedAt)), 'Publication state does not verify this issue and origin.');
  const routes = new Set(['/', '/subscribe/', '/latest/', '/site.css', '/site.js', '/favicon.svg', '/feed.xml', '/sitemap.xml', ...weeks.map(file => `/weeks/${file.slice(0, 10)}/`)]);
  requireCheck(Array.isArray(publication.checks) && publication.checks.length === routes.size, 'Publication state lacks the complete route set.');
  const seen = new Set();
  for (const check of publication.checks) {
    requireCheck(check && routes.has(check.path) && !seen.has(check.path) && check.matched === true && /^[a-f0-9]{64}$/.test(check.sha256), 'Publication state contains an invalid or duplicate route.');
    seen.add(check.path);
    const relative = check.path.endsWith('/') ? `${check.path.slice(1)}index.html` : check.path.slice(1);
    requireCheck(sha256(read(root, `dist/${relative}`)) === check.sha256, `Current public content differs from the verified deployment: ${check.path}`);
  }
  const input = read(root, inputFile);
  requireCheck(sha256(input) === expectedInputHash, 'Public issue changed since the verified build; no email draft was prepared.');
  const issue = JSON.parse(input);
  requireCheck(issue.date === expectedWeek && Array.isArray(issue.progress) && issue.progress.length === 0, 'Email input must be the public issue with progress=[].');
  requireCheck(typeof issue.title === 'string' && typeof issue.summary === 'string' && typeof issue.sourceHealth === 'string' && Array.isArray(issue.tags) && Array.isArray(issue.highlights), 'The public issue is missing newsletter fields.');
  const issueUrl = `${base}/weeks/${expectedWeek}/`;
  const issueHash = publication.checks.find(check => check.path === `/weeks/${expectedWeek}/`).sha256;
  if (!productionVerified) verifyOnline(issueUrl, issueHash);
  const body = (emailTestId === undefined ? '' : `**测试草稿：不发送、不排期。**\n\n标识：${emailTestId}\n\n这只是上线后自动备稿链路验收，复用已公开的 ${expectedWeek} 内容，不代表新一期。\n\n---\n\n`) + bodyFor(issue, base);
  const subject = (emailTestId === undefined ? '' : '[TEST · 不发送] ') + `AI Infra Weekly · ${expectedWeek}｜${issue.title.replace(/\s+/g, ' ').trim()}` + (emailTestId === undefined ? '' : ` · ${emailTestId}`);
  const sendPolicy = emailTestId === undefined ? 'owner_confirmation_required' : 'never_send';
  const inputSha256 = sha256(input);
  const bodySha256 = sha256(body);
  const manifestPath = join(directory, 'manifest.json');
  const bodyPath = join(directory, 'draft.md');
  if (existsSync(manifestPath)) {
    const previous = readJson(directory, 'manifest.json');
    requireCheck(previous.week === expectedWeek && previous.issueUrl === issueUrl && previous.testId === emailTestId && previous.sendPolicy === sendPolicy, 'Existing draft identity differs; it was preserved for review.');
    requireCheck(existsSync(bodyPath) && sha256(read(directory, 'draft.md')) === previous.bodySha256, 'The local draft was edited or removed; it was preserved for manual review.');
    requireCheck(previous.inputSha256 === inputSha256 && previous.bodySha256 === bodySha256 && previous.subject === subject, 'Published content or the template changed; the existing draft and remote record were preserved for review.');
    return { reused: true, manifestPath, bodyPath, manifest: previous };
  }
  requireCheck(!existsSync(bodyPath), 'An untracked local draft already exists; it was preserved for review.');
  mkdirSync(directory, { recursive: true });
  const manifest = {
    schemaVersion: 1, week: expectedWeek, subject, issueUrl, newsletterUrl: config.subscriptions.buttondownUrl,
    inputSha256, bodySha256, createdAt: new Date().toISOString(), status: 'local_ready',
    publication: { checkedAt: publication.checkedAt, version: publication.version ?? null, issueSha256: issueHash, receiptSha256: sha256(publicationBytes) },
    format: 'markdown', sendPolicy, ...(emailTestId === undefined ? {} : { testId: emailTestId }),
    remote: { status: 'pending', url: null, bodySha256: null, verifiedAt: null },
  };
  writeFileSync(bodyPath, body, { flag: 'wx' });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { reused: false, manifestPath, bodyPath, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let options;
  try {
    options = parseEmailOptions(args);
    const result = prepareEmailDraft(options);
    rmSync(join(dirname(result.manifestPath), 'generation-error.json'), { force: true });
    console.log(JSON.stringify({ status: result.manifest.status, reused: result.reused, manifest: result.manifestPath, body: result.bodyPath, remote: result.manifest.remote.status, sendsEmail: false }, null, 2));
  } catch (error) {
    console.error(`Email draft not prepared: ${error.message}`);
    if (options) {
      const directory = emailDraftDirectory(options);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'generation-error.json'), JSON.stringify({
        status: 'pending', week: options.expectedWeek, ...(options.emailTestId === undefined ? {} : { testId: options.emailTestId }), attemptedAt: new Date().toISOString(), message: error.message,
      }, null, 2) + '\n');
    }
    process.exitCode = 1;
  }
}
