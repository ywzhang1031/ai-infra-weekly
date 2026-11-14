import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Check the generated public artifact, without contacting sources or providers.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = spawnSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' });
if (build.error || build.status !== 0) {
  console.error('Public build failed; publication checks were not run.');
  process.exit(1);
}

const problems = [];
const requireCheck = (condition, message) => { if (!condition) problems.push(message); };
const read = file => readFileSync(join(root, file), 'utf8');
const config = JSON.parse(read('site-config.json'));
const base = new URL(config.baseUrl);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('site-config.baseUrl must be a public HTTPS origin without credentials, path, query or fragment.');
}
const issues = readdirSync(join(root, 'content'))
  .filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
  .map(file => JSON.parse(read(`content/${file}`)));
const issueDates = new Set(issues.map(issue => issue.date));
requireCheck(issueDates.size === issues.length, 'Public content contains duplicate issue dates.');
requireCheck(issues.every(issue => Array.isArray(issue.progress) && issue.progress.length === 0), 'Public issues must keep progress=[].');

const expected = new Set([
  'index.html', '404.html', 'site.css', 'site.js', 'favicon.svg', 'feed.xml',
  'sitemap.xml', 'robots.txt', '_headers', 'subscribe/index.html',
  ...issues.map(issue => `weeks/${issue.date}/index.html`),
]);
const generated = new Map();
function scan(directory = '') {
  for (const entry of readdirSync(join(root, 'dist', directory))) {
    const relative = posix.join(directory, entry);
    const stat = lstatSync(join(root, 'dist', relative));
    if (stat.isSymbolicLink()) {
      problems.push(`Generated output must not contain symlinks: ${relative}`);
    } else if (stat.isDirectory()) {
      if (![...expected].some(file => file.startsWith(`${relative}/`))) {
        problems.push(`Unexpected generated directory: ${relative}`);
      } else scan(relative);
    } else if (!stat.isFile() || !expected.has(relative)) {
      problems.push(`Unexpected generated file: ${relative}`);
    } else if (stat.size > 2 * 1024 * 1024) {
      problems.push(`Generated text file exceeds the 2 MiB review limit: ${relative}`);
    } else generated.set(relative, read(`dist/${relative}`));
  }
}
scan();
for (const file of expected) requireCheck(generated.has(file), `Missing generated file: ${file}`);

const privatePatterns = [
  ['private local path or profile', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|teacher\/|learner_profile|career_target|memory\.md)/i],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['API or repository token', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|oauth[_-]?token|password|secret)\s*[=:]\s*["']?[^\s"'<>{}]{12,}/i],
  ['credential-bearing URL', /https?:\/\/[^\s/<>"']+:[^\s/<>"']+@/i],
];
for (const [file, text] of generated) {
  for (const [label, pattern] of privatePatterns) {
    requireCheck(!pattern.test(text), `${file}: ${label} detected (value withheld).`);
  }
}

function decode(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.slice(2, -1);
    const code = /^x/i.test(number) ? parseInt(number.slice(1), 16) : Number(number);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}
// This intentionally handles our generated HTML attributes, not arbitrary HTML.
function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}
const html = [...generated].filter(([file]) => file.endsWith('.html'));
const anchors = new Map(html.map(([file, text]) => [file, new Set(
  [...text.matchAll(/<[^>]+>/g)].flatMap(([tag]) => {
    const attr = attributes(tag);
    return [attr.id, /^<a\b/i.test(tag) ? attr.name : null].filter(Boolean);
  }),
)]));
const pagePath = file => file === 'index.html' ? '/' : file.endsWith('/index.html') ? `/${file.slice(0, -10)}` : `/${file}`;
let internalLinks = 0;
let anchorLinks = 0;
for (const [file, text] of html) {
  for (const [tag] of text.matchAll(/<[^>]+>/g)) {
    const attr = attributes(tag);
    for (const name of ['href', 'src']) {
      if (!(name in attr)) continue;
      let url;
      try { url = new URL(attr[name], new URL(pagePath(file), base)); }
      catch { problems.push(`${file}: invalid ${name} URL.`); continue; }
      requireCheck(!url.username && !url.password, `${file}: ${name} contains URL credentials.`);
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') continue;
      if (!['http:', 'https:'].includes(url.protocol)) {
        problems.push(`${file}: unsupported ${name} protocol ${url.protocol}`);
        continue;
      }
      if (url.origin !== base.origin) continue;
      internalLinks += 1;
      let route;
      try { route = decodeURIComponent(url.pathname).replace(/^\//, ''); }
      catch { problems.push(`${file}: malformed local URL encoding.`); continue; }
      if (!route || route.endsWith('/')) route += 'index.html';
      else if (!posix.extname(route)) route += '/index.html';
      requireCheck(generated.has(route), `${file}: local ${name} target is missing: ${route}`);
      if (url.hash && anchors.has(route)) {
        anchorLinks += 1;
        let anchor;
        try { anchor = decodeURIComponent(url.hash.slice(1)); }
        catch { problems.push(`${file}: malformed anchor encoding.`); continue; }
        requireCheck(anchors.get(route).has(anchor), `${file}: anchor target is missing: ${route}#${anchor}`);
      }
    }
  }
  if (file !== '404.html') {
    const canonicals = [...text.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => attributes(tag))
      .filter(attr => attr.rel?.split(/\s+/).includes('canonical'));
    requireCheck(canonicals.length === 1 && canonicals[0].href === new URL(pagePath(file), base).href, `${file}: canonical URL mismatch.`);
  }
}

function xmlText(xml, tag) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
  if (matches.length !== 1) return null;
  return decode(matches[0][1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'));
}
const feed = generated.get('feed.xml') || '';
const items = [...feed.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map(match => match[1]);
const guids = new Set();
requireCheck(items.length === issues.length, 'RSS item count must equal the public issue count.');
const expectedGuids = new Map(issues.map(issue => [new URL(`/weeks/${issue.date}/`, base).href, issue.date]));
for (const item of items) {
  const guid = xmlText(item, 'guid');
  const link = xmlText(item, 'link');
  const published = xmlText(item, 'pubDate');
  requireCheck(expectedGuids.has(guid), 'RSS GUID does not match a public issue permalink.');
  requireCheck(guid && !guids.has(guid), 'RSS contains a missing or duplicate GUID.');
  requireCheck(link === guid, 'RSS link and GUID must identify the same issue.');
  guids.add(guid);
  if (expectedGuids.has(guid)) {
    // Publication time is tied to the issue date (Monday 08:30 Asia/Shanghai),
    // never to the current build/deployment time, so backfills remain stable.
    const expectedDate = new Date(`${expectedGuids.get(guid)}T00:30:00Z`);
    requireCheck(published === expectedDate.toUTCString(), `RSS pubDate must remain tied to issue ${expectedGuids.get(guid)}.`);
  }
}
for (const guid of expectedGuids.keys()) requireCheck(guids.has(guid), 'RSS is missing a public issue GUID.');
const sitemap = generated.get('sitemap.xml') || '';
const locations = [...sitemap.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map(match => decode(match[1].trim()));
requireCheck(new Set(locations).size === locations.length, 'Sitemap contains duplicate URLs.');
for (const route of ['/', '/subscribe/', ...issues.map(issue => `/weeks/${issue.date}/`)]) {
  requireCheck(locations.includes(new URL(route, base).href), `Sitemap is missing ${route}`);
}

if (problems.length) {
  console.error(`Public artifact checks failed (${problems.length}):`);
  for (const message of problems.slice(0, 30)) console.error(`- ${message}`);
  if (problems.length > 30) console.error(`- ${problems.length - 30} additional problems omitted.`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: 'passed', issues: issues.length, publicFiles: generated.size,
    internalLinks, anchorLinks, stableRssItems: items.length,
    subscriptionCanonicalAndSitemap: true, privacyScan: 'passed',
    limits: 'Generated HTML/XML contract checks only; no browser, provider delivery, external-source or production verification.',
  }, null, 2));
}
