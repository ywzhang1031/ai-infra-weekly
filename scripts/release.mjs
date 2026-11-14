import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This command never stages, pushes, changes credentials, or sends email.
// --dry-run performs the same reads and check.mjs build, but writes no remote state.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
class ReleaseError extends Error {}
const requireCheck = (condition, message) => { if (!condition) throw new ReleaseError(message); };
const commandEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: 'true', GH_HOST: 'github.com', GH_PAGER: 'cat', PAGER: 'cat' };

function run(executable, args, label, { allowFailure = false, binary = false, timeout = 30_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, env: commandEnv, encoding: binary ? undefined : 'utf8',
    timeout, maxBuffer, windowsHide: true,
  });
  // Child output may include account diagnostics or credentials; never echo it.
  requireCheck(!result.error && result.signal == null, `${label} could not complete within its execution limits.`);
  if (!allowFailure) requireCheck(result.status === 0, `${label} failed; no command output is disclosed.`);
  return result;
}
const git = (args, label) => run('git', args, label).stdout.trim();
function json(text, label) {
  try { return JSON.parse(text); }
  catch { throw new ReleaseError(`${label} is not valid JSON.`); }
}
function readJson(file, label) {
  const stat = lstatSync(join(root, file));
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `${label} must be a bounded regular file.`);
  return json(readFileSync(join(root, file), 'utf8'), label);
}
function github(path, label, allowNotFound = false) {
  const result = run('gh', ['api', '--hostname', 'github.com', '--include', path], label, { allowFailure: true });
  const response = result.stdout;
  const status = Number(response.match(/^HTTP\/[\d.]+\s+(\d{3})\b/m)?.[1]);
  const separator = /\r?\n\r?\n/.exec(response);
  requireCheck(Number.isInteger(status) && separator, `${label} returned an unrecognized response.`);
  if (allowNotFound && status === 404) return null;
  requireCheck(result.status === 0 && status === 200, `${label} failed; check GitHub access before retrying.`);
  return json(response.slice(separator.index + separator[0].length), label);
}
function parseOptions() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let expectedWeek = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--expected-week' && expectedWeek == null) expectedWeek = args[++index];
    else if (args[index] === '--dry-run' && !dryRun) dryRun = true;
    else throw new ReleaseError('Use --expected-week YYYY-MM-DD and optionally --dry-run.');
  }
  requireCheck(typeof expectedWeek === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expectedWeek), 'Pass --expected-week YYYY-MM-DD.');
  const parsed = new Date(`${expectedWeek}T00:00:00Z`);
  requireCheck(Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === expectedWeek, 'The expected week must be a real calendar date.');
  return { expectedWeek, dryRun };
}
function repository(value) {
  requireCheck(typeof value === 'string', 'Configure subscriptions.githubUrl before releasing.');
  let url;
  try { url = new URL(value); } catch { throw new ReleaseError('subscriptions.githubUrl is invalid.'); }
  requireCheck(url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash,
    'subscriptions.githubUrl must be a plain HTTPS github.com repository URL.');
  const match = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})\/?$/);
  requireCheck(match && !match[2].endsWith('.git'), 'subscriptions.githubUrl must identify an owner and repository.');
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}`, url: `https://github.com/${match[1]}/${match[2]}` };
}
function originRepository(remote) {
  const scp = remote.match(/^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (scp) return scp[1];
  let url;
  try { url = new URL(remote); } catch { throw new ReleaseError('origin is not a recognized GitHub remote.'); }
  const allowed = (url.protocol === 'https:' && !url.username) || (url.protocol === 'ssh:' && url.username === 'git');
  requireCheck(allowed && url.hostname === 'github.com' && !url.password && !url.port && !url.search && !url.hash, 'origin must point directly to github.com without embedded credentials.');
  const name = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  requireCheck(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name), 'origin does not identify a GitHub repository.');
  return name;
}
function cleanHead(repo, expectedHead = null) {
  requireCheck(resolve(git(['rev-parse', '--show-toplevel'], 'Git checkout lookup')) === resolve(root), 'Run this command from the standalone public-site repository.');
  requireCheck(git(['status', '--porcelain=v1', '--untracked-files=all'], 'Git worktree check') === '', 'The public repository must be clean, including untracked files. Commit and push reviewed changes first.');
  requireCheck(originRepository(git(['remote', 'get-url', 'origin'], 'Git origin lookup')).toLowerCase() === repo.fullName.toLowerCase(), 'origin and subscriptions.githubUrl identify different repositories.');
  const head = git(['rev-parse', '--verify', 'HEAD'], 'Git HEAD lookup');
  requireCheck(/^[a-f0-9]{40}$/.test(head), 'The local HEAD is not a GitHub commit SHA.');
  if (expectedHead) requireCheck(head === expectedHead, 'Local HEAD changed during validation; start again from the reviewed commit.');
  return head;
}
function remoteRefs(tag, expectedHead) {
  const output = git(['ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], 'Remote branch and tag lookup');
  const refs = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{40})\s+(refs\/[\w./^{}-]+)$/);
    requireCheck(match, 'Remote refs returned an unexpected format.');
    refs.set(match[2], match[1]);
  }
  requireCheck(refs.get('refs/heads/main') === expectedHead, 'Remote main does not match local HEAD. Push the reviewed commit before releasing.');
  const tagCommit = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`) || null;
  requireCheck(!tagCommit || tagCommit === expectedHead, 'The issue tag already points to another commit; it will not be moved or replaced.');
  return { tagExists: Boolean(tagCommit), tagCommit };
}
function baseOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ReleaseError('The production base URL is invalid.'); }
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash,
    'The production base URL must be a plain HTTPS origin.');
  requireCheck(url.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname), 'The production base URL must identify a public host.');
  return url.origin;
}
function verifyProduction(config, expectedWeek, dates) {
  const base = baseOrigin(config.baseUrl);
  const state = readJson('publication-state.json', 'Publication state');
  requireCheck(state.status === 'published' && state.latestWeek === expectedWeek && state.url === base, 'Publication state does not confirm this site and issue. Complete production deployment and verification first.');
  requireCheck(typeof state.checkedAt === 'string' && Number.isFinite(Date.parse(state.checkedAt)), 'Publication state has no valid verification timestamp.');
  const required = new Set(['/', '/subscribe/', '/site.css', '/site.js', '/favicon.svg', '/feed.xml', '/sitemap.xml', ...dates.map(date => `/weeks/${date}/`)]);
  requireCheck(Array.isArray(state.checks) && state.checks.length === required.size, 'Publication state does not contain the complete expected route set.');
  const seen = new Set();
  for (const check of state.checks) {
    requireCheck(check && required.has(check.path) && !seen.has(check.path) && check.matched === true && /^[a-f0-9]{64}$/.test(check.sha256), 'Publication state contains a missing, duplicate, failed, or unexpected route check.');
    seen.add(check.path);
    const file = join(root, 'dist', check.path === '/' ? 'index.html' : check.path.endsWith('/') ? `${check.path.slice(1)}index.html` : check.path.slice(1));
    const stat = lstatSync(file);
    requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Generated artifact is invalid: ${check.path}`);
    const localHash = sha256(readFileSync(file));
    requireCheck(localHash === check.sha256, `Generated artifact differs from publication state: ${check.path}`);
    const fetched = run('curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '5', '--max-time', '20', '--max-filesize', '2097152', '--retry', '0', '--write-out', '\n%{http_code}', `${base}${check.path}`], `Production read for ${check.path}`, { binary: true, timeout: 25_000, maxBuffer: 3 * 1024 * 1024 });
    const body = fetched.stdout;
    requireCheck(body.length >= 4 && body.subarray(-4).toString('ascii') === '\n200', `Production did not return HTTP 200: ${check.path}`);
    requireCheck(sha256(body.subarray(0, -4)) === localHash, `Production content differs from the current artifact: ${check.path}`);
  }
  return { base, checks: seen.size, issueUrl: `${base}/weeks/${expectedWeek}/` };
}
const markdown = value => String(value).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\r?\n/g, ' ');
function releaseNotes(issue, expectedWeek, production, head) {
  requireCheck(typeof issue.summary === 'string' && typeof issue.sourceHealth === 'string' && Array.isArray(issue.coverage) && issue.coverage.every(value => typeof value === 'string'), 'The public issue is missing release summary or coverage information.');
  return [
    `# AI Infra Weekly · ${expectedWeek}`, '', markdown(issue.summary), '',
    `[阅读本期周刊](${production.issueUrl})`, '',
    '## 来源覆盖与证据边界', '',
    `来源状态：${markdown(issue.sourceHealth)}`, '',
    ...issue.coverage.map(value => `- ${markdown(value)}`), '',
    '本期由 AI 辅助整理。实验结果归属于引用的原始来源，未经本站独立复现；阅读建议不表示已完成实现或获得个人性能成果。', '',
    `源码版本：\`${head}\``, '',
  ].join('\n');
}
function verifyRelease(release, repo, tag, issueUrl) {
  requireCheck(release && release.tag_name === tag && release.draft === false && release.prerelease === false && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'The existing release does not match the expected published issue. It will not be edited or republished.');
  requireCheck(release.html_url === `${repo.url}/releases/tag/${tag}`, 'The release URL does not match the configured repository.');
  requireCheck(typeof release.body === 'string' && release.body.includes(issueUrl), 'The existing release notes do not contain the verified issue URL. They will not be overwritten.');
  return release.html_url;
}

let submitted = false;
let notesDirectory = null;
try {
  const options = parseOptions();
  if (options.help) {
    console.log('Usage: node scripts/release.mjs --expected-week YYYY-MM-DD [--dry-run]\nRequires a clean, pushed main commit and a verified public deployment.\nDry-run rebuilds ignored dist via check.mjs and performs bounded remote reads; it creates no remote tag or Release.');
  } else {
    const { expectedWeek, dryRun } = options;
    const config = readJson('site-config.json', 'Site configuration');
    const repo = repository(config.subscriptions?.githubUrl);
    const dates = readdirSync(join(root, 'content')).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).map(file => file.slice(0, 10)).sort().reverse();
    requireCheck(dates[0] === expectedWeek, 'The expected week must equal the latest public content date; older issues are not released automatically.');
    const head = cleanHead(repo);
    run(process.execPath, ['scripts/check.mjs'], 'Public artifact check', { timeout: 60_000 });
    cleanHead(repo, head);
    const issue = readJson(`content/${expectedWeek}.json`, 'Public issue');
    requireCheck(issue.date === expectedWeek, 'The issue date does not match the requested release.');
    const production = verifyProduction(config, expectedWeek, dates);
    const actor = github('user', 'GitHub identity check');
    requireCheck(typeof actor.login === 'string' && actor.login.toLowerCase() === repo.owner.toLowerCase(), 'The active GitHub account is not the configured repository owner; switch accounts explicitly before retrying.');
    const remoteRepo = github(`repos/${repo.fullName}`, 'GitHub repository check');
    requireCheck(typeof remoteRepo.full_name === 'string' && remoteRepo.full_name.toLowerCase() === repo.fullName.toLowerCase() && remoteRepo.private === false && remoteRepo.visibility === 'public' && remoteRepo.archived === false && remoteRepo.default_branch === 'main', 'The configured repository must be public, active, and use main as its default branch.');
    const tag = `issue-${expectedWeek}`;
    const title = `AI Infra Weekly · ${expectedWeek}`;
    const notes = releaseNotes(issue, expectedWeek, production, head);
    const refs = remoteRefs(tag, head);
    const existing = github(`repos/${repo.fullName}/releases/tags/${tag}`, 'Existing release lookup', true);
    if (existing) {
      requireCheck(refs.tagExists, 'An existing release has no matching remote tag; no write was attempted.');
      const url = verifyRelease(existing, repo, tag, production.issueUrl);
      console.log(JSON.stringify({ status: 'already_published', dryRun, url, tag, commit: head, productionChecks: production.checks, remoteWrites: false, note: 'Existing release verified; no duplicate release or notification was created.' }, null, 2));
    } else if (dryRun) {
      console.log(JSON.stringify({ status: 'ready', dryRun: true, repository: repo.fullName, tag, commit: head, issueUrl: production.issueUrl, productionChecks: production.checks, remoteWrites: false, note: 'All checks passed. No tag or Release was created.' }, null, 2));
    } else {
      cleanHead(repo, head);
      const finalRefs = remoteRefs(tag, head);
      // A concurrently published release is never updated or re-announced.
      const concurrent = github(`repos/${repo.fullName}/releases/tags/${tag}`, 'Final existing release lookup', true);
      if (concurrent) {
        requireCheck(finalRefs.tagExists, 'The concurrently published release has no matching remote tag.');
        const url = verifyRelease(concurrent, repo, tag, production.issueUrl);
        console.log(JSON.stringify({ status: 'already_published', url, tag, commit: head, productionChecks: production.checks, remoteWrites: false }, null, 2));
      } else {
        requireCheck(run('git', ['check-ignore', '--quiet', '.local-maintenance/release-notes.txt'], 'Release notes ignore check', { allowFailure: true }).status === 0, 'The .local-maintenance directory must be ignored before release notes can be written.');
        requireCheck(git(['ls-files', '--', '.local-maintenance'], 'Release notes tracking check') === '', 'Release maintenance files must not be tracked in Git.');
        const maintenance = join(root, '.local-maintenance');
        mkdirSync(maintenance, { recursive: true });
        const maintenanceStat = lstatSync(maintenance);
        requireCheck(maintenanceStat.isDirectory() && !maintenanceStat.isSymbolicLink(), 'The release maintenance directory must be a local regular directory.');
        notesDirectory = mkdtempSync(join(maintenance, 'release-notes-'));
        const notesFile = join(notesDirectory, 'notes.md');
        writeFileSync(notesFile, notes, { mode: 0o600, flag: 'wx' });
        const releaseArgs = ['release', 'create', tag, '--repo', repo.fullName, '--target', head, '--title', title, '--notes-file', notesFile];
        if (finalRefs.tagExists) releaseArgs.push('--verify-tag');
        submitted = true;
        run('gh', releaseArgs, 'GitHub Release creation', { timeout: 60_000 });
        const published = github(`repos/${repo.fullName}/releases/tags/${tag}`, 'Published release verification');
        requireCheck(remoteRefs(tag, head).tagExists, 'The created release tag could not be verified.');
        const url = verifyRelease(published, repo, tag, production.issueUrl);
        console.log(JSON.stringify({ status: 'published', url, tag, commit: head, issueUrl: production.issueUrl, productionChecks: production.checks, remoteWrites: true }, null, 2));
      }
    }
  }
} catch (error) {
  const message = error instanceof ReleaseError ? error.message : 'A local file or unexpected operation could not be verified; details are withheld.';
  console.error(`Release not verified: ${message}`);
  if (submitted) console.error('A creation request was attempted. Inspect the existing release and tag before retrying; this command did not roll back or retry the request.');
  process.exitCode = 1;
} finally {
  if (notesDirectory) {
    try { rmSync(notesDirectory, { recursive: true, force: true }); }
    catch { console.error('Temporary release notes could not be removed from the ignored maintenance directory.'); }
  }
}
