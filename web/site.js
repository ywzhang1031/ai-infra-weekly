const search = document.querySelector('#issue-search');
if (search) {
  const cards = [...document.querySelectorAll('[data-issue]')];
  const filters = [...document.querySelectorAll('[data-filter]')];
  let selected = '';
  function apply() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const card of cards) {
      const matches = card.dataset.search.includes(query)
        && (!selected || JSON.parse(card.dataset.tags).includes(selected));
      card.hidden = !matches;
      if (matches) visible += 1;
    }
    document.querySelector('#result-count').textContent = `${visible} / ${cards.length} 期研究周报`;
    document.querySelector('#no-results').hidden = visible !== 0;
  }
  search.addEventListener('input', apply);
  for (const button of filters) button.addEventListener('click', () => {
    selected = button.dataset.filter;
    for (const filter of filters) {
      const active = filter === button;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    }
    apply();
  });
}

const rssInput = document.querySelector('#rss-url');
const copyRss = document.querySelector('[data-copy-rss]');
const rssStatus = document.querySelector('#rss-copy-status');
if (rssInput && copyRss && rssStatus) {
  copyRss.hidden = false;
  copyRss.addEventListener('click', async () => {
    copyRss.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(rssInput.value);
      rssStatus.textContent = '已复制 RSS 地址。打开阅读器，添加此地址即可订阅。';
    } catch {
      rssInput.focus();
      rssInput.select();
      rssInput.setSelectionRange(0, rssInput.value.length);
      rssStatus.textContent = '复制未完成，请长按地址复制，或使用键盘复制所选文字。';
    } finally {
      copyRss.disabled = false;
    }
  });
}
