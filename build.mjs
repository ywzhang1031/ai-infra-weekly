import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
const config = existsSync(join(root, 'site-config.json'))
  ? JSON.parse(readFileSync(join(root, 'site-config.json'), 'utf8')) : {};
const name = config.title || 'AI Infra Weekly';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function https(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label}: require a public HTTPS URL`);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(url.hostname)) throw new Error(`${label}: local URL is not public`);
  return url.href;
}
const base = config.baseUrl ? https(config.baseUrl, 'baseUrl').replace(/\/$/, '') : null;
const subscriptions = config.subscriptions ?? {};
if (!subscriptions || typeof subscriptions !== 'object' || Array.isArray(subscriptions)) {
  throw new Error('subscriptions: expected object');
}
function subscriptionUrl(value, label, hostname, pathnamePattern) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected a public subscription URL`);
  const url = new URL(https(value, label));
  if (url.hostname !== hostname || url.port || url.search || url.hash || !pathnamePattern.test(url.pathname)) {
    throw new Error(`${label}: expected a plain ${hostname} profile or repository URL without query parameters`);
  }
  return url.href.replace(/\/$/, '');
}
const buttondownUrl = subscriptionUrl(subscriptions.buttondownUrl, 'subscriptions.buttondownUrl', 'buttondown.com', /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/?$/);
const buttondownStatus = subscriptions.buttondownStatus === undefined ? 'active' : subscriptions.buttondownStatus;
if (!['pending_review', 'active'].includes(buttondownStatus)) {
  throw new Error('subscriptions.buttondownStatus: expected pending_review or active');
}
const githubUrl = subscriptionUrl(subscriptions.githubUrl, 'subscriptions.githubUrl', 'github.com', /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/?$/);
function date(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`${label}: invalid date`);
  return value;
}
function string(value, label, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`${label}: expected ${required ? 'nonempty ' : ''}string`);
  return value;
}
function checkPrivate(value, label) {
  const text = JSON.stringify(value);
  if (/(?:\/Users\/|\/home\/|teacher\/|memory\.md|learner_profile|career_target|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|-----BEGIN .*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|oauth[_-]?token)\s*[=:]|<\s*\/?[a-z][^>]*>|javascript\s*:)/i.test(text)) {
    throw new Error(`${label}: private path, credential, or HTML detected; public content must be plain text`);
  }
}
function item(value, label, end) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  string(value.title, `${label}.title`, true);
  string(value.summary, `${label}.summary`, true);
  https(value.url, `${label}.url`);
  if (value.published) date(value.published, `${label}.published`);
  if (value.published && value.published > end) throw new Error(`${label}: published after report window`);
  for (const key of ['topic', 'mechanism', 'limits', 'reading']) if (value[key] != null) string(value[key], `${label}.${key}`);
}
const contentDir = join(root, 'content');
if (!existsSync(contentDir)) throw new Error('Create reviewed public content/*.json before building.');
const files = readdirSync(contentDir).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().reverse();
if (!files.length) throw new Error('No reviewed public issues in content/*.json.');
const issues = files.map(file => {
  const issue = JSON.parse(readFileSync(join(contentDir, file), 'utf8'));
  checkPrivate(issue, file);
  date(issue.date, `${file}.date`);
  if (file !== `${issue.date}.json`) throw new Error(`${file}: filename/date mismatch`);
  date(issue.window?.start, `${file}.window.start`);
  date(issue.window?.end, `${file}.window.end`);
  if (issue.window.start > issue.window.end || issue.window.end > issue.date) throw new Error(`${file}: invalid window order`);
  for (const key of ['title', 'summary', 'sourceHealth']) string(issue[key], `${file}.${key}`, true);
  for (const key of ['tags', 'coverage']) {
    if (!Array.isArray(issue[key])) throw new Error(`${file}.${key}: expected array`);
    issue[key].forEach((value, index) => string(value, `${file}.${key}[${index}]`, true));
  }
  for (const key of ['highlights', 'watch']) {
    if (issue[key] == null) issue[key] = [];
    if (!Array.isArray(issue[key])) throw new Error(`${file}.${key}: expected array`);
    issue[key].forEach((value, index) => {
      item(value, `${file}.${key}[${index}]`, issue.window.end);
      if (value.published && value.published < issue.window.start && !value.extension) throw new Error(`${file}.${key}[${index}]: outside window; mark extension=true`);
    });
    issue[key].sort((a, b) => Number(Boolean(a.extension)) - Number(Boolean(b.extension)));
  }
  if (issue.practice) {
    for (const key of ['title', 'duration', 'requirements', 'deliverable', 'acceptance']) string(issue.practice[key], `${file}.practice.${key}`, true);
    if (!Array.isArray(issue.practice.steps)) throw new Error(`${file}.practice.steps: expected array`);
    issue.practice.steps.forEach(value => string(value, `${file}.practice.steps`, true));
  }
  if (issue.progress?.length) throw new Error(`${file}: public progress entries need a reviewed evidence schema before publication`);
  return issue;
});
checkPrivate({ title: name }, 'site-config');
const tags = [...new Set(issues.flatMap(issue => issue.tags))].sort();
const pathFor = issue => `/weeks/${issue.date}/`;
const source = value => `<a class="source-link" href="${escape(value.url)}" target="_blank" rel="noopener noreferrer">阅读原文 <span aria-hidden="true">↗</span></a>`;
const pills = issue => issue.tags.map(tag => `<span class="tag">${escape(tag)}</span>`).join('');
const featuredCount = issue => issue.highlights.filter(value => !value.extension).length;
const extensionCount = issue => issue.highlights.filter(value => value.extension).length;
const readingCountLabel = issue => `${featuredCount(issue)} 篇重点${extensionCount(issue) ? ` · ${extensionCount(issue)} 篇延伸` : ''}`;
function document(title, description, body, path = '/') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escape(description)}"><meta name="theme-color" content="#174b3e"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>${escape(title)}</title>${base ? `<link rel="canonical" href="${escape(base + path)}"><meta property="og:url" content="${escape(base + path)}"><link rel="alternate" type="application/rss+xml" title="${escape(name)}" href="${escape(base + '/feed.xml')}">` : ''}<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:type" content="website"><link rel="stylesheet" href="/site.css"><script src="/site.js" defer></script></head><body><a class="skip-link" href="#main">跳转到正文</a><header class="masthead"><div class="shell masthead-inner"><a class="brand" href="/" aria-label="${escape(name)} 首页"><span class="brand-mark" aria-hidden="true">IW</span><span>${escape(name)}</span></a><nav aria-label="主导航"><a href="/#archive">往期归档</a><a href="/#about">关于周刊</a><a href="/subscribe/">订阅周刊</a>${base ? '<a href="/feed.xml">RSS <span aria-hidden="true">↗</span></a>' : ''}</nav></div></header>${body}<footer class="shell footer"><a class="footer-brand" href="/">${escape(name)}</a><p>AI 辅助编辑 · 中文系统研究阅读笔记<br>文中结果归属于原始来源，未经本站独立复现。</p><div class="footer-links"><a href="/subscribe/">订阅周刊</a><a href="/#archive">浏览全部期刊 <span aria-hidden="true">↑</span></a></div></footer></body></html>`;
}
function card(issue, index) {
  const searchable = [issue.title, issue.summary, ...issue.tags, ...issue.highlights.map(x => x.title), ...issue.watch.map(x => x.title)].join(' ');
  return `<article class="archive-card" data-issue data-search="${escape(searchable.toLowerCase())}" data-tags="${escape(JSON.stringify(issue.tags))}"><div class="card-top"><time datetime="${issue.date}">${issue.date.replaceAll('-', ' / ')}</time><span class="issue-index">NO. ${String(issues.length - index).padStart(2, '0')}</span></div><h3><a href="${pathFor(issue)}">${escape(issue.title)}</a></h3><p>${escape(issue.summary)}</p><div class="tags">${pills(issue)}</div><div class="card-bottom"><span>${readingCountLabel(issue)} · ${issue.watch.length} 条关注</span><a href="${pathFor(issue)}" aria-label="阅读 ${issue.date} 周报">阅读本期 <span aria-hidden="true">↗</span></a></div></article>`;
}
const subscriptionTeaser = `<section class="subscribe-teaser" aria-labelledby="subscribe-teaser-title"><div><div class="eyebrow">KEEP READING</div><h2 id="subscribe-teaser-title">让每周的阅读，主动到来。</h2><p>订阅新一期的标题、阅读重点与全文链接，按自己的节奏继续深入。</p></div><a class="button" href="/subscribe/">订阅周刊 <span aria-hidden="true">→</span></a></section>`;
const latest = issues[0];
const home = document(`${name} · 读懂模型背后的系统`, '每周整理推理框架、训练系统与性能工程的原始论文和工程实践。保留实验条件，关注可复现的技术细节。', `<main id="main" class="shell"><section class="hero"><div class="eyebrow">每周一更新 / 中文研究周刊</div><h1>读懂模型背后的<span>系统。</span></h1><div class="hero-bottom"><p>从推理调度到训练通信，追踪真正影响性能的工程细节。<br class="desktop-break">精选原始来源，记录机制、取舍与尚未验证的部分。</p><div class="issue-count"><strong>${String(issues.length).padStart(2, '0')}</strong><span>期公开归档</span></div></div></section>${subscriptionTeaser}<section class="latest-section" aria-labelledby="latest-title"><div class="section-label"><span>最新一期</span><time datetime="${latest.date}">${latest.date.replaceAll('-', ' / ')}</time></div><div class="latest-layout"><div class="latest-lead"><div class="tags">${pills(latest)}</div><h2 id="latest-title"><a href="${pathFor(latest)}">${escape(latest.title)}</a></h2><p>${escape(latest.summary)}</p><a class="button" href="${pathFor(latest)}">展开本期周报 <span aria-hidden="true">→</span></a><p class="window-note">观察窗口 ${latest.window.start} — ${latest.window.end}</p></div><div class="reading-list">${latest.highlights.map((x, i) => `<a class="reading-row" href="${pathFor(latest)}#reading-${i + 1}"><span class="reading-number">0${i + 1}</span><div><span class="small-label">${escape(x.extension ? '延伸阅读 · 窗口外' : x.topic || '重点阅读')}</span><h3>${escape(x.title)}</h3></div><span aria-hidden="true">↗</span></a>`).join('')}</div></div></section><section id="archive" class="archive-section" aria-labelledby="archive-heading"><div class="section-heading"><div><div class="eyebrow">THE ARCHIVE</div><h2 id="archive-heading">把每周的阅读，连成线。</h2></div><p id="result-count" role="status">${issues.length} 期研究周报</p></div><div class="archive-controls"><label class="search-label"><span>搜索归档</span><input id="issue-search" type="search" placeholder="搜索论文、框架或关键词…" autocomplete="off"></label><div class="filters" role="group" aria-label="按主题筛选"><button class="filter active" data-filter="" aria-pressed="true">全部</button>${tags.map(tag => `<button class="filter" data-filter="${escape(tag)}" aria-pressed="false">${escape(tag)}</button>`).join('')}</div></div><div class="archive-grid">${issues.map(card).join('')}</div><p id="no-results" class="empty-state" hidden>暂时没有匹配的期刊。试试其他关键词，或切回“全部”。</p></section><section id="about" class="about-section"><div><div class="eyebrow">ABOUT THE WEEKLY</div><h2>关注系统，<br>也关注证据。</h2></div><div class="about-copy"><p>这是一份面向 AI Infrastructure 的技术阅读周刊，围绕大模型推理框架、训练系统与底层性能优化持续积累。</p><p>每期以论文、官方仓库和第一方技术文章为入口，保留工作负载、基线与实验限制。阅读建议和小实验提案帮助形成下一步问题，不代表已经完成复现。</p><p class="about-note">由 AI 辅助整理。请通过每条原文链接核对最新版本；来源覆盖不足会在当期说明。${base ? ' <a href="/feed.xml">通过 RSS 订阅 →</a>' : ''}</p></div></section></main>`);
function reading(value, index) {
  const detail = [['机制与取舍', value.mechanism], ['证据与局限', value.limits], ['建议阅读顺序', value.reading]].filter(([, value]) => value);
  return `<article class="reading-article" id="reading-${index + 1}"><div class="article-kicker"><span>0${index + 1} / ${escape(value.topic || '重点阅读')}</span>${value.published ? `<time datetime="${value.published}">${value.published}</time>` : ''}</div>${value.extension ? '<p class="extension-note">延伸阅读 · 此文发表于本期观察窗口之外。</p>' : ''}<h3>${escape(value.title)}</h3><p class="article-summary">${escape(value.summary)}</p>${detail.map(([label, text]) => `<section class="detail"><h4>${label}</h4><p>${escape(text)}</p></section>`).join('')}${source(value)}</article>`;
}
function issuePage(issue) {
  const practice = issue.practice;
  return document(`${issue.title} · ${name}`, issue.summary, `<main id="main" class="shell issue-page"><a class="back-link" href="/#archive">← 全部期刊</a><header class="issue-hero"><div class="eyebrow">WEEKLY RESEARCH / <time datetime="${issue.date}">${issue.date}</time></div><h1>${escape(issue.title)}</h1><p>${escape(issue.summary)}</p><div class="tags">${pills(issue)}</div></header><div class="issue-body"><aside class="issue-sidebar"><div class="sidebar-block"><span class="small-label">观察窗口</span><p>${issue.window.start}<br>— ${issue.window.end}</p><span class="small-label">来源覆盖</span><p>${escape(issue.sourceHealth)}</p></div><nav class="contents" aria-label="本期目录"><a href="#featured">重点阅读 <span>${featuredCount(issue)}</span></a>${extensionCount(issue) ? `<a href="#extensions">延伸阅读 <span>${extensionCount(issue)}</span></a>` : ''}<a href="#watch">值得关注 <span>${issue.watch.length}</span></a>${practice ? '<a href="#practice">一项实践建议 <span>1</span></a>' : ''}<a href="#coverage">覆盖与证据</a></nav></aside><div class="issue-content"><section id="featured"><h2 class="content-heading">重点阅读</h2>${issue.highlights.filter(value => !value.extension).map(reading).join('')}</section>${extensionCount(issue) ? `<section id="extensions"><h2 class="content-heading">窗口外延伸阅读</h2>${issue.highlights.filter(value => value.extension).map((value, index) => reading(value, featuredCount(issue) + index)).join('')}</section>` : ''}<section id="watch" class="watch-section"><h2 class="content-heading">值得关注</h2>${issue.watch.map(value => `<article class="watch-item"><div class="small-label">${escape(value.topic || '系统观察')}${value.published ? ` · ${value.published}` : ''}${value.extension ? ' · 窗口外延伸阅读' : ''}</div><h3>${escape(value.title)}</h3><p>${escape(value.summary)}</p>${value.limits ? `<p class="muted">${escape(value.limits)}</p>` : ''}${source(value)}</article>`).join('')}</section>${practice ? `<section class="practice" id="practice"><div class="eyebrow">ONE SMALL EXPERIMENT / ${escape(practice.duration)}</div><h2>${escape(practice.title)}</h2><p><strong>所需资源</strong> ${escape(practice.requirements)}</p><ol>${practice.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol><p><strong>产物</strong> ${escape(practice.deliverable)}</p><p><strong>验收条件</strong> ${escape(practice.acceptance)}</p><p class="small-note">此项是实践建议，本站未因此执行实验或获得新的性能结果。</p></section>` : ''}<section id="coverage" class="coverage"><h2 class="content-heading">来源覆盖与证据缺口</h2><ul>${issue.coverage.map(value => `<li>${escape(value)}</li>`).join('')}</ul><p>本文由 AI 辅助整理，实验结果属于被引用的原始来源，未经本站独立复现。</p></section><a class="back-link bottom-back" href="/#archive">← 回到全部期刊</a></div></div></main>`, pathFor(issue));
}

function subscriptionPage() {
  const rss = base ? `<section class="subscription-card" aria-labelledby="rss-heading"><div class="eyebrow">RSS</div><h2 id="rss-heading">在阅读器里订阅</h2><p>把下面的地址添加到常用 RSS 阅读器。每期包含标题、摘要与网页链接，完整内容留在周刊网站。</p><label class="rss-label" for="rss-url">RSS 订阅地址</label><div class="rss-copy-row"><input id="rss-url" type="url" readonly value="${escape(base + '/feed.xml')}" spellcheck="false" autocomplete="off"><button class="button copy-rss" type="button" data-copy-rss hidden>复制地址</button></div><p class="copy-status" id="rss-copy-status" role="status" aria-live="polite">也可以长按上方地址手动复制。</p><a class="source-link" href="/feed.xml">打开 RSS 文件 <span aria-hidden="true">↗</span></a></section>` : '';
  const email = buttondownUrl ? buttondownStatus === 'pending_review'
    ? `<section class="subscription-card" aria-labelledby="email-heading"><div class="eyebrow">EMAIL</div><h2 id="email-heading">邮件订阅审核中</h2><p>AI Infra Weekly 的 Buttondown 账号正在等待平台审核，邮件订阅尚未开放。你可以先使用下方的 RSS 或 GitHub 订阅。</p><a class="button" href="${escape(buttondownUrl)}" target="_top" rel="noopener noreferrer">查看 Buttondown 页面（审核中） <span aria-hidden="true">↗</span></a><p class="subscription-note">审核完成前，Buttondown 页面可能暂时无法访问；此入口不表示订阅已完成或邮件已启用。</p></section>`
    : `<section class="subscription-card" aria-labelledby="email-heading"><div class="eyebrow">EMAIL</div><h2 id="email-heading">通过邮箱订阅</h2><p>登记邮箱 → 点击确认邮件 → 完成订阅。后续邮件内容由编辑审核后发布。</p><a class="button" href="${escape(buttondownUrl)}" target="_top" rel="noopener noreferrer">通过邮箱订阅 <span aria-hidden="true">↗</span></a><p class="subscription-note">确认邮件和欢迎信用于确认订阅；完整周报可从下方入口直接阅读，无需等待邮件。</p><p><a class="source-link" href="/latest/">阅读最新一期 <span aria-hidden="true">→</span></a></p><p><a class="source-link" href="/#archive">浏览历史归档 <span aria-hidden="true">→</span></a></p><p class="subscription-note">邮箱由 Buttondown 处理；订阅是否完成，以其页面及确认邮件为准。可通过邮件中的入口退订。</p></section>` : '';
  const github = githubUrl ? `<section class="subscription-card" aria-labelledby="github-heading"><div class="eyebrow">GITHUB</div><h2 id="github-heading">关注期刊发布与纠错</h2><p>打开仓库，选择 <strong>Watch → Custom → Releases</strong>，保存后订阅新一期发布通知。也欢迎通过 Issues 提交选题或勘误。</p><a class="button" href="${escape(githubUrl)}" target="_top" rel="noopener noreferrer">打开 GitHub 仓库 <span aria-hidden="true">↗</span></a><p class="subscription-note">通知发送到哪里，由你的 GitHub 通知设置决定。Star 用于收藏，订阅更新请使用 Watch。</p><a class="source-link" href="${escape(githubUrl + '/releases')}" target="_top" rel="noopener noreferrer">查看已发布期刊 <span aria-hidden="true">↗</span></a></section>` : '';
  const methods = [email, rss, github].filter(Boolean).join('');
  return document(`订阅周刊 · ${name}`, '选择 RSS、邮箱或 GitHub，持续收到 AI Infrastructure 研究周刊的新一期。', `<main id="main" class="shell subscribe-page"><a class="back-link" href="/">← 回到周刊首页</a><header class="subscribe-hero"><div class="eyebrow">SUBSCRIBE TO THE WEEKLY</div><h1>每周一，继续读懂系统。</h1><p>围绕推理框架、训练系统与性能工程，精选原始来源，保留实验条件与尚未验证的部分。</p></header>${methods ? `<div class="subscription-grid">${methods}</div>` : '<p class="subscription-empty">订阅入口尚未开放，可以先从归档阅读已有期刊。</p>'}<section class="subscription-promise" aria-labelledby="subscription-promise-heading"><h2 id="subscription-promise-heading">先看一期，再决定订阅。</h2><p>每期聚焦技术机制、工程取舍与证据边界；来源覆盖不足会在当期说明。阅读建议不代表已经完成复现。</p><a class="source-link" href="${pathFor(latest)}">阅读最新一期 · ${latest.date} <span aria-hidden="true">→</span></a></section></main>`, '/subscribe/');
}

// dist contains only this generator's output; never copy reports or private source caches.
if (existsSync(output)) rmSync(output, { recursive: true });
mkdirSync(output, { recursive: true });
function write(path, content) { const file = join(output, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
write('index.html', home);
write('subscribe/index.html', subscriptionPage());
write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#183a32"/><text x="32" y="43" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="34" fill="#f7f6f0">IW</text></svg>');
write('site.css', readFileSync(join(root, 'web/site.css')));
write('site.js', readFileSync(join(root, 'web/site.js')));
for (const issue of issues) write(`weeks/${issue.date}/index.html`, issuePage(issue));
write('latest/index.html', issuePage(latest));
write('404.html', document(`页面未找到 · ${name}`, '返回周报归档。', '<main id="main" class="shell not-found"><div class="eyebrow">404 / NOT FOUND</div><h1>这一页还没有写下。</h1><p>可以从周刊归档继续阅读。</p><a class="button" href="/">回到首页 →</a></main>'));
write('robots.txt', `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`);
write('_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src \'self\'; style-src \'self\'; script-src \'self\'; img-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'\n');
if (base) {
  write('feed.xml', `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escape(name)}</title><link>${escape(base)}</link><description>中文 AI Infrastructure 研究周刊</description><language>zh-CN</language>${issues.map(issue => `<item><title>${escape(issue.title)}</title><link>${escape(base + pathFor(issue))}</link><guid>${escape(base + pathFor(issue))}</guid><pubDate>${new Date(`${issue.date}T00:30:00Z`).toUTCString()}</pubDate><description>${escape(issue.summary)}</description></item>`).join('')}</channel></rss>`);
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escape(base + '/')}</loc></url><url><loc>${escape(base + '/subscribe/')}</loc></url>${issues.map(issue => `<url><loc>${escape(base + pathFor(issue))}</loc></url>`).join('')}</urlset>`);
}
console.log(JSON.stringify({ output, issues: issues.length, latest: latest.date, rss: Boolean(base), note: base ? 'Public archive generated.' : 'Set HTTPS baseUrl in site-config.json to enable canonical URLs, RSS and sitemap.' }, null, 2));
