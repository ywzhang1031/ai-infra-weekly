import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareEmailDraft } from './scripts/email-draft.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const statePath = path.join(root, 'publication-state.json');
await mkdir(path.join(root, '.wrangler'), {recursive:true});
const config = JSON.parse(await readFile(path.join(root,'site-config.json'), 'utf8'));
const args = process.argv.slice(2);
const expectedIndex = args.indexOf('--expected-week');
const expectedWeek = expectedIndex >= 0 ? args[expectedIndex + 1] : null;
const verifyOnly = args.includes('--verify-only');
const digest = body => createHash('sha256').update(body).digest('hex');
let deployed = null;
let version = null;
let publicationVerified = false;
let verifiedInputSha256 = null;
const run = args => {
  const result = spawnSync(process.execPath, args, {
    cwd:root, encoding:'utf8', maxBuffer:10*1024*1024,
    env:{...process.env, WRANGLER_SEND_METRICS:'false', WRANGLER_LOG_PATH:path.join(root,'.wrangler','publish.log')}
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${args[0]}`);
  return result.stdout;
};
try {
  if (!expectedWeek || !/^\d{4}-\d{2}-\d{2}$/.test(expectedWeek)) throw new Error('Pass --expected-week YYYY-MM-DD; missing current content must not publish an older issue.');
  const weeks = (await readdir(path.join(root,'content'))).filter(x=>/^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse();
  if (weeks[0] !== `${expectedWeek}.json`) throw new Error(`Latest public issue does not match expected week ${expectedWeek}`);
  const inputPath = path.join(root, 'content', `${expectedWeek}.json`);
  verifiedInputSha256 = digest(await readFile(inputPath));
  run(['scripts/check.mjs']);
  if (digest(await readFile(inputPath)) !== verifiedInputSha256) throw new Error('Public issue changed during the build; start from a stable reviewed input.');
  if (verifyOnly) {
    deployed = config.baseUrl;
    // Preserve the version returned by the deployment being resumed, when available.
    for (const file of ['publication-last-error.json','publication-state.json']) {
      try {
        const previous = JSON.parse(await readFile(path.join(root,file),'utf8'));
        if (previous.url === deployed && (previous.expectedWeek || previous.latestWeek) === expectedWeek && previous.version) {
          version = previous.version;
          break;
        }
      } catch { /* No preceding deployment record is required for a read-only verification. */ }
    }
  } else {
    const output = run(['node_modules/wrangler/bin/wrangler.js','deploy','--config','wrangler.jsonc']);
    deployed = output.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev\b/)?.[0];
    version = output.match(/Current Version ID: ([a-f0-9-]+)/)?.[1] || null;
  }
  if (!deployed) throw new Error('Deployment URL missing from Wrangler output; verify deployment before retrying.');
  const checks = ['/', '/subscribe/', '/latest/', '/site.css', '/site.js', '/favicon.svg', ...weeks.map(w=>`/weeks/${w.slice(0,10)}/`)];
  if (config.baseUrl) checks.push('/feed.xml', '/sitemap.xml');
  const verified = [];
  for (const route of checks) {
    const response = spawnSync('curl', ['--fail','--silent','--show-error','--max-time','20',deployed+route], {maxBuffer:10*1024*1024});
    if (response.status !== 0) throw new Error(`Production check failed: ${route}: ${String(response.stderr).trim()}`);
    const local = await readFile(path.join(root,'dist',route.endsWith('/') ? route+'index.html' : route));
    const sha256 = digest(response.stdout);
    if (sha256 !== digest(local)) throw new Error(`Production content hash mismatch: ${route}`);
    verified.push({path:route,matched:true,sha256});
  }
  await writeFile(statePath, JSON.stringify({status:'published',checkedAt:new Date().toISOString(),url:deployed,version,latestWeek:expectedWeek,checks:verified},null,2)+'\n');
  await rm(path.join(root, 'publication-last-error.json'), {force:true});
  publicationVerified = true;
  console.log(`Verified public site: ${deployed}`);
} catch(error) {
  console.error(`Publication not verified: ${error.message}`);
  await writeFile(path.join(root,'publication-last-error.json'),JSON.stringify({status:'failed',attemptedAt:new Date().toISOString(),url:deployed,version,expectedWeek,message:error.message},null,2)+'\n');
  process.exitCode=1;
}

// A draft failure must not turn a verified website deployment into a publication failure.
if (publicationVerified) {
  const directory = path.join(root, '.local-maintenance', 'newsletters', expectedWeek);
  try {
    const result = prepareEmailDraft({ root, expectedWeek, productionVerified: true, verifiedInputSha256 });
    await rm(path.join(directory, 'generation-error.json'), { force: true });
    console.log(`Email draft ${result.reused ? 'reused' : 'prepared'}: ${result.manifestPath}; remote=${result.manifest.remote.status}; no email sent.`);
  } catch (error) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'generation-error.json'), JSON.stringify({
      status: 'pending', week: expectedWeek, attemptedAt: new Date().toISOString(), message: error.message,
    }, null, 2) + '\n');
    console.error(`Website verified; email draft pending: ${error.message}`);
  }
}
