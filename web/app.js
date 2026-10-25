'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const native = Boolean(window.__TAURI__?.core);
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const STORAGE = 'paper-reader-v1';
  const MAX_BYTES = 16 * 1024 * 1024;
  const GUIDE = `# 让阅读，回归简单。

在信息匆忙流过的日子里，留一页安静的空间。  
纸页，让每一份 Markdown 都值得慢慢读。

> 阅读是一座随身携带的避难所。  
> 放慢一点，让文字自己说话。

## 从一份文档开始

点击左侧 **打开文档**，或把 Markdown 文件拖进窗口，即可开始。你也可以按下 **Ctrl + O**，打开工作笔记、项目文档，或一篇还没读完的文章。

纸页会记住你的阅读位置。下一次打开，继续上一次的思路。

## 为专注而留白

好的阅读体验，来自恰到好处的细节。

- **舒适的排版** — 宽松的行距、清晰的层次，以及适合长时间阅读的行宽。
- **随手可达的目录** — 点击右侧章节，轻松找到你想读的部分。
- **属于你的光线** — 在浅色、深色和跟随系统之间自由切换。
- **少一点打扰** — 开启专注模式，让整个窗口只留下文字。

### 调成你喜欢的样子

点击左下角的阅读设置，调整字号与页面宽度。你的偏好会保留在本机，下一次打开依然熟悉。

## 不止于文字

从项目说明到技术笔记，常用的 Markdown 格式都能自然呈现。

| 内容 | 阅读体验 |
| :--- | :--- |
| 标题与目录 | 自动生成章节导航 |
| 表格与列表 | 清晰有序，便于浏览 |
| 代码片段 | 等宽排版，一键复制 |
| 任务清单 | 保留每一个完成的瞬间 |

### 代码，也可以很好读

\`\`\`rust
fn main() {
    let reader = "Paper";
    println!("Hello, {reader}. Keep it simple.");
}
\`\`\`

- [x] 找到一篇想读的文档
- [x] 选择舒服的阅读主题
- [ ] 留一点时间，读完它

## 几个顺手的快捷键

| 快捷键 | 操作 |
| :--- | :--- |
| Ctrl + O | 打开文档 |
| Ctrl + F | 搜索当前文档 |
| Ctrl + Shift + F | 切换专注模式 |
| Ctrl + + / − | 调整字号 |
| Esc | 关闭搜索、设置或专注模式 |

---

**轻一点，静一点。**  
愿你在这里，读到一些值得停留的文字。
`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch {}
  const state = {
    theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'light',
    fontSize: Math.max(14, Math.min(24, Number(saved.fontSize) || 17)),
    width: saved.width === 'wide' ? 'wide' : 'comfortable',
    recent: Array.isArray(saved.recent) ? saved.recent.filter(x => x && typeof x.path === 'string' && typeof x.name === 'string').slice(0, 12) : [],
    positions: saved.positions && typeof saved.positions === 'object' ? saved.positions : {},
    doc: null, headings: [], hits: [], hitIndex: 0, sourceMode: false, loadId: 0, documentId: 0,
  };
  let parserReady, observer, imageObserver, scrollFrame, saveTimer, toastTimer, searchTimer;
  let searchedQuery = null;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const compactOutline = matchMedia('(max-width: 1020px)');
  function setOutlineHidden(hidden) {
    document.body.classList.toggle('outline-hidden', hidden);
    $('outline-toggle').setAttribute('aria-pressed', String(!hidden));
  }
  compactOutline.addEventListener('change', event => setOutlineHidden(event.matches));
  const persist = () => {
    const { theme, fontSize, width, recent, positions } = state;
    try { localStorage.setItem(STORAGE, JSON.stringify({ theme, fontSize, width, recent, positions })); } catch {}
  };
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
  }
  function applyPreferences() {
    document.documentElement.dataset.theme = state.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.theme;
    document.documentElement.style.setProperty('--reader-font-size', `${state.fontSize}px`);
    document.documentElement.style.setProperty('--reading-size', `${state.fontSize}px`);
    document.body.dataset.width = state.width;
    $('font-size').textContent = `${state.fontSize}`;
    $('width-select').value = state.width;
    for (const name of ['light', 'dark', 'system']) {
      $(`theme-${name}`).setAttribute('aria-pressed', String(name === state.theme));
    }
    $('theme-toggle').setAttribute('aria-label', document.documentElement.dataset.theme === 'dark' ? '切换浅色主题' : '切换深色主题');
    persist();
  }
  function changeFont(delta) { state.fontSize = Math.max(14, Math.min(24, state.fontSize + delta)); applyPreferences(); }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('本地预览组件加载失败，请检查 vendor 文件。'));
      document.head.append(s);
    });
  }
  async function render(source) {
    if (native) return invoke('render_markdown', { source });
    if (!parserReady) parserReady = Promise.all([loadScript('./vendor/marked.umd.js'), loadScript('./vendor/purify.min.js')]);
    await parserReady;
    const html = DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: false }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'video', 'audio', 'source'],
      FORBID_ATTR: ['style', 'name', 'autofocus', 'formaction', 'srcset', 'background'], ADD_ATTR: ['disabled', 'checked'],
    });
    const wordCount = (source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || []).length;
    return { html, wordCount, readingMinutes: Math.max(1, Math.ceil(wordCount / 400)) };
  }
  function rememberPosition() {
    if (!state.doc || state.sourceMode) return;
    const el = $('reader-scroll'), max = el.scrollHeight - el.clientHeight;
    state.positions[state.doc.path] = max > 0 ? el.scrollTop / max : 0;
    const keys = Object.keys(state.positions);
    while (keys.length > 50) delete state.positions[keys.shift()];
    persist();
  }
  function renderRecent() {
    const list = $('recent-list'); list.replaceChildren();
    if (!state.recent.length) {
      const empty = document.createElement('p'); empty.className = 'recent-empty';
      empty.textContent = '读过的文档，会留在这里'; list.append(empty);
    }
    state.recent.forEach(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-item';
      if (state.doc?.path === item.path) button.classList.add('active');
      const icon = document.createElement('span'); icon.className = 'recent-file-icon'; icon.textContent = '▤';
      const text = document.createElement('span'); text.textContent = item.name.replace(/\.(md|markdown|mdown|txt)$/i, '');
      button.append(icon, text); button.title = item.path;
      button.addEventListener('click', () => {
        if (native && !item.path.startsWith('browser:')) loadPath(item.path);
        else { toast('浏览器预览需要重新选择本地文件'); $('file-input').click(); }
      });
      list.append(button);
    });
    $('clear-recent').disabled = state.recent.length === 0;
    $('welcome-button').classList.toggle('active', state.doc?.path === 'paper:welcome');
  }
  const slug = text => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
  function decorateArticle() {
    const article = $('article'), used = new Set(), ids = new Map();
    // Namespace authored IDs to prevent document content from shadowing app controls.
    article.querySelectorAll('[id]').forEach(el => {
      const old = el.id; el.id = `md-${old}`; ids.set(old, el.id);
    });
    state.headings = [...article.querySelectorAll('h1,h2,h3,h4')];
    state.headings.forEach(h => {
      const old = h.id, base = slug(h.textContent); let id = base, count = 1;
      while (used.has(id) || document.getElementById(id)) id = `${base}-${count++}`;
      used.add(id); h.id = `heading-${id}`;
      if (!ids.has(base)) ids.set(base, h.id); if (old) ids.set(old.replace(/^md-/, ''), h.id);
    });
    article.querySelectorAll('a[href^="#"]').forEach(a => {
      let hash; try { hash = decodeURIComponent(a.getAttribute('href').slice(1)); } catch { return; }
      a.setAttribute('href', `#${ids.get(hash) || hash}`);
    });
    state.anchors = ids;
    article.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code'); if (!code) return;
      const wrap = document.createElement('div'); wrap.className = 'code-block';
      const bar = document.createElement('div'); bar.className = 'code-header';
      const lang = document.createElement('span'); lang.textContent = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'TEXT';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制代码';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code.textContent); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制代码'; }, 1800); }
        catch { toast('复制失败，请选中代码后按 Ctrl + C'); }
      });
      bar.append(lang, copy); pre.before(wrap); wrap.append(bar, pre);
    });
    article.querySelectorAll('table').forEach(table => { const wrap = document.createElement('div'); wrap.className = 'table-wrap'; table.before(wrap); wrap.append(table); });
    article.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = true; });
    buildOutline();
  }
  function buildOutline() {
    observer?.disconnect();
    const list = $('outline-list'); list.replaceChildren();
    state.headings.filter(h => h.tagName !== 'H1').forEach(h => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `outline-item level-${h.tagName.slice(1)}`;
      button.textContent = h.textContent; button.dataset.target = h.id;
      button.addEventListener('click', () => {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (compactOutline.matches) setOutlineHidden(true);
      });
      list.append(button);
    });
    if (!list.children.length) { const p = document.createElement('p'); p.className = 'outline-empty'; p.textContent = '此文档没有章节标题'; list.append(p); }
    observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveHeading(visible.target.id);
    }, { root: $('reader-scroll'), rootMargin: '-4% 0px -70% 0px' });
    state.headings.forEach(h => observer.observe(h));
  }
  function setActiveHeading(id) {
    $('outline-list').querySelectorAll('button').forEach(b => { const active = b.dataset.target === id; b.classList.toggle('active', active); b.setAttribute('aria-current', active ? 'location' : 'false'); });
  }
  async function prepareImages(fragment, doc, id) {
    const pending = new Map();
    fragment.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || ''; img.removeAttribute('src'); img.removeAttribute('srcset');
      img.loading = 'lazy'; img.decoding = 'async';
      if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) { img.src = src; return; }
      if (/^https?:\/\//i.test(src)) {
        const box = document.createElement('button'); box.type = 'button'; box.className = 'image-placeholder';
        box.textContent = `加载远程图片${img.alt ? ` · ${img.alt}` : ''}`;
        box.addEventListener('click', () => { img.src = src; box.replaceWith(img); }, { once: true });
        img.replaceWith(box); return;
      }
      if (native && doc.path && !doc.path.startsWith('paper:')) {
        pending.set(img, async () => {
          try {
            const data = await invoke('read_local_image', { documentPath: doc.path, imagePath: src });
            if (id === state.documentId) img.src = data;
          } catch { img.alt = `${img.alt || '图片'}（无法读取）`; img.classList.add('image-error'); }
        });
      } else { img.alt = `${img.alt || '图片'}（浏览器预览不读取同目录文件）`; }
    });
    // Read local images only near the viewport, with at most two reads in flight.
    return () => {
      imageObserver?.disconnect();
      const queue = []; let active = 0;
      const pump = () => {
        while (active < 2 && queue.length && id === state.documentId) {
          active++;
          queue.shift()().finally(() => { active--; updateProgress(); pump(); });
        }
      };
      imageObserver = new IntersectionObserver(entries => {
        entries.filter(entry => entry.isIntersecting).forEach(entry => {
          const task = pending.get(entry.target);
          if (task) { queue.push(task); pending.delete(entry.target); }
          imageObserver.unobserve(entry.target);
        });
        pump();
      }, { root: $('reader-scroll'), rootMargin: '600px' });
      for (const img of pending.keys()) imageObserver.observe(img);
    };
  }
  async function showDocument(doc, id) {
    if (id !== state.loadId) return;
    rememberPosition();
    const restore = Number(state.positions[doc.path]) || 0;
    closeSearch(); state.sourceMode = false;
    document.body.classList.remove('source-mode'); $('source-view').hidden = true; $('article').hidden = false;
    $('source-toggle').setAttribute('aria-pressed', 'false');
    const template = document.createElement('template'); template.innerHTML = doc.html;
    template.content.querySelectorAll('input').forEach(input => { input.type = 'checkbox'; input.disabled = true; });
    template.content.querySelectorAll('[class]').forEach(el => {
      const allowed = [...el.classList].filter(c => (el.tagName === 'CODE' && /^language-[\w+-]+$/.test(c)) || /^(footnote-definition|footnote-reference|footnote-definition-label|markdown-alert(?:-[a-z]+)?)$/.test(c));
      el.className = allowed.join(' ');
    });
    const loadImages = await prepareImages(template.content, doc, id);
    if (id !== state.loadId) return;
    // Opening or cancelling another file must not invalidate the displayed images.
    state.documentId = id;
    state.doc = { path: doc.path, name: doc.name, source: doc.source, wordCount: doc.wordCount, readingMinutes: doc.readingMinutes };
    $('article').replaceChildren(template.content);
    decorateArticle();
    $('source-view').textContent = '';
    $('breadcrumb-name').textContent = doc.name;
    document.title = `${doc.name} — 纸页 Paper`;
    $('status-words').textContent = `${Number(doc.wordCount).toLocaleString('zh-CN')} 字`;
    $('status-time').textContent = `约 ${doc.readingMinutes} 分钟`;
    if (doc.path !== 'paper:welcome') {
      state.recent = [{ path: doc.path, name: doc.name }, ...state.recent.filter(r => r.path !== doc.path)].slice(0, 12);
    }
    renderRecent(); persist();
    document.body.classList.remove('sidebar-open');
    requestAnimationFrame(() => {
      if (id !== state.documentId) return;
      const el = $('reader-scroll'); el.scrollTop = restore * Math.max(0, el.scrollHeight - el.clientHeight); updateProgress();
    });
    loadImages();
  }
  async function welcome() {
    const id = ++state.loadId;
    try { await showDocument({ ...await render(GUIDE), source: GUIDE, path: 'paper:welcome', name: '欢迎使用纸页.md' }, id); }
    catch (e) { toast(`无法打开阅读指南：${e.message || e}`); }
  }
  async function loadPath(path, hash = '') {
    const id = ++state.loadId;
    try {
      await showDocument(await invoke('read_document', { path }), id);
      if (hash && id === state.loadId) requestAnimationFrame(() => scrollToHash(hash));
    }
    catch (e) { toast(`无法打开文件：${e.message || e}`); }
  }
  async function openFile() {
    if (!native) { $('file-input').click(); return; }
    const id = ++state.loadId;
    try { const doc = await invoke('open_document'); if (doc) await showDocument(doc, id); }
    catch (e) { toast(`无法打开文件：${e.message || e}`); }
  }
  async function browserFile(file) {
    if (!file) return;
    if (!/\.(md|markdown|mdown|txt)$/i.test(file.name)) { toast('请选择 .md、.markdown、.mdown 或 .txt 文件'); return; }
    if (file.size > MAX_BYTES) { toast('文档超过 16 MB，请使用较小的文件'); return; }
    const id = ++state.loadId;
    try {
      const bytes = await file.arrayBuffer();
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await showDocument({ ...await render(source), source, path: `browser:${file.name}:${file.size}:${file.lastModified}`, name: file.name }, id);
    } catch (e) { toast(`无法读取文件，请确认它是 UTF-8 编码：${e.message || e}`); }
  }
  function updateProgress() {
    scrollFrame = null;
    const el = $('reader-scroll'), max = el.scrollHeight - el.clientHeight;
    const percent = max > 0 ? Math.min(100, Math.max(0, Math.round(el.scrollTop / max * 100))) : 100;
    $('status-progress').textContent = `${percent}%`;
    $('progress-fill').style.width = `${percent}%`;
    const top = el.getBoundingClientRect().top;
    const current = state.headings.filter(h => h.getBoundingClientRect().top <= top + 110).at(-1);
    if (current) setActiveHeading(current.id);
  }
  function clearHits() {
    $('article').querySelectorAll('mark.search-hit').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent)));
    $('article').normalize(); state.hits = []; state.hitIndex = 0;
  }
  function runSearch() {
    clearHits();
    const query = $('search-input').value.trim().toLocaleLowerCase();
    searchedQuery = query;
    if (!query) { $('search-count').textContent = ''; return; }
    const walker = document.createTreeWalker($('article'), NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement.closest('button,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.textContent, lower = text.toLocaleLowerCase(); let start = 0, found = lower.indexOf(query);
      if (found < 0) continue;
      const fragment = document.createDocumentFragment();
      while (found >= 0 && state.hits.length < 1000) {
        fragment.append(document.createTextNode(text.slice(start, found)));
        const mark = document.createElement('mark'); mark.className = 'search-hit'; mark.textContent = text.slice(found, found + query.length);
        fragment.append(mark); state.hits.push(mark); start = found + query.length; found = lower.indexOf(query, start);
      }
      fragment.append(document.createTextNode(text.slice(start))); node.replaceWith(fragment);
      if (state.hits.length >= 1000) break;
    }
    selectHit(0);
  }
  function navigateSearch(delta) {
    clearTimeout(searchTimer);
    const query = $('search-input').value.trim().toLocaleLowerCase();
    if (query !== searchedQuery) {
      runSearch();
      if (delta < 0 && state.hits.length) selectHit(-1);
    } else selectHit(delta);
  }
  function selectHit(delta) {
    if (!state.hits.length) { $('search-count').textContent = '无匹配'; return; }
    state.hits[state.hitIndex]?.classList.remove('current');
    state.hitIndex = (state.hitIndex + delta + state.hits.length) % state.hits.length;
    const hit = state.hits[state.hitIndex]; hit.classList.add('current'); hit.scrollIntoView({ block: 'center', behavior: 'instant' });
    $('search-count').textContent = `${state.hitIndex + 1} / ${state.hits.length}${state.hits.length === 1000 ? '+' : ''}`;
  }
  function openSearch() {
    if (state.sourceMode) toggleSource();
    $('search-bar').hidden = false; $('search-toggle').setAttribute('aria-expanded', 'true'); $('search-input').focus(); $('search-input').select();
  }
  function closeSearch() {
    clearTimeout(searchTimer); clearHits(); searchedQuery = null; $('search-input').value = ''; $('search-count').textContent = '';
    $('search-bar').hidden = true; $('search-toggle').setAttribute('aria-expanded', 'false');
  }
  function toggleSource() {
    closeSearch(); rememberPosition(); state.sourceMode = !state.sourceMode;
    $('source-view').textContent = state.sourceMode ? (state.doc?.source || '') : '';
    $('article').hidden = state.sourceMode; $('source-view').hidden = !state.sourceMode;
    document.body.classList.toggle('source-mode', state.sourceMode);
    $('source-toggle').setAttribute('aria-pressed', String(state.sourceMode));
    if (!state.sourceMode && state.doc) {
      const el = $('reader-scroll'); el.scrollTop = (Number(state.positions[state.doc.path]) || 0) * Math.max(0, el.scrollHeight - el.clientHeight);
    }
    updateProgress();
  }
  function toggleFocus() {
    const active = document.body.classList.toggle('focus-mode');
    $('focus-toggle').setAttribute('aria-pressed', String(active)); updateProgress();
  }
  function toggleSettings(force) {
    const visible = force ?? $('settings-panel').hidden;
    $('settings-panel').hidden = !visible; $('settings-toggle').setAttribute('aria-expanded', String(visible));
  }
  $('open-file').addEventListener('click', openFile);
  $('file-input').addEventListener('change', event => { browserFile(event.target.files[0]); event.target.value = ''; });
  $('welcome-button').addEventListener('click', welcome);
  $('clear-recent').addEventListener('click', () => { state.recent = []; renderRecent(); persist(); toast('已清空最近阅读记录'); });
  $('theme-toggle').addEventListener('click', () => { state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyPreferences(); });
  for (const name of ['light', 'dark', 'system']) $(`theme-${name}`).addEventListener('click', () => { state.theme = name; applyPreferences(); });
  media.addEventListener('change', applyPreferences);
  $('font-decrease').addEventListener('click', () => changeFont(-1)); $('font-increase').addEventListener('click', () => changeFont(1));
  $('width-select').addEventListener('change', event => { state.width = event.target.value; applyPreferences(); });
  $('settings-toggle').addEventListener('click', () => toggleSettings());
  $('focus-toggle').addEventListener('click', toggleFocus);
  $('source-toggle').addEventListener('click', toggleSource);
  $('sidebar-toggle').addEventListener('click', () => {
    if (innerWidth < 900) document.body.classList.toggle('sidebar-open');
    else document.body.classList.toggle('sidebar-collapsed');
  });
  $('outline-toggle').addEventListener('click', () => setOutlineHidden(!document.body.classList.contains('outline-hidden')));
  $('search-toggle').addEventListener('click', () => $('search-bar').hidden ? openSearch() : closeSearch());
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); } });
  $('search-prev').addEventListener('click', () => navigateSearch(-1)); $('search-next').addEventListener('click', () => navigateSearch(1));
  $('reader-scroll').addEventListener('scroll', () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(updateProgress);
    clearTimeout(saveTimer); saveTimer = setTimeout(rememberPosition, 250);
  }, { passive: true });
  addEventListener('resize', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateProgress); });
  addEventListener('pagehide', rememberPosition);
  function scrollToHash(hash) {
    let id; try { id = decodeURIComponent(hash.replace(/^#/, '')); } catch { return; }
    const target = document.getElementById(state.anchors?.get(id) || id);
    if (target && $('article').contains(target)) target.scrollIntoView({ behavior: 'smooth' });
  }
  function handleDocumentLink(event) {
    if (event.type === 'auxclick' && event.button !== 1) return;
    if (!event.target.closest('#settings-panel,#settings-toggle')) toggleSettings(false);
    if (!event.target.closest('.sidebar,#sidebar-toggle')) document.body.classList.remove('sidebar-open');
    const anchor = event.target.closest('#article a');
    if (!anchor) return;
    event.preventDefault(); const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      scrollToHash(href);
    } else if (/^https?:\/\//i.test(href)) {
      if (native) invoke('open_external', { url: href }).catch(e => toast(String(e)));
      else window.open(href, '_blank', 'noopener,noreferrer');
    } else if (native && state.doc && !state.doc.path.startsWith('paper:') && /\.(md|markdown|mdown|txt)(?:#.*)?$/i.test(href)) {
      let relative; try { relative = decodeURIComponent(href.split('#')[0]); } catch { toast('链接路径无效'); return; }
      const path = state.doc.path, end = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      if (path.includes('\\')) relative = relative.replace(/\//g, '\\');
      loadPath(`${path.slice(0, end + 1)}${relative}`, href.includes('#') ? href.slice(href.indexOf('#')) : '');
    } else toast('此链接无法在阅读器中打开');
  }
  document.addEventListener('click', handleDocumentLink);
  document.addEventListener('auxclick', handleDocumentLink);
  document.addEventListener('keydown', event => {
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (mod && key === 'o') { event.preventDefault(); openFile(); }
    else if (mod && key === 'f') { event.preventDefault(); event.shiftKey ? toggleFocus() : openSearch(); }
    else if (mod && ['+', '=', '-', '0'].includes(key)) {
      event.preventDefault(); if (key === '0') { state.fontSize = 17; applyPreferences(); } else changeFont(key === '-' ? -1 : 1);
    } else if (key === 'escape') {
      closeSearch(); toggleSettings(false); document.body.classList.remove('sidebar-open');
      if (document.body.classList.contains('focus-mode')) toggleFocus();
    }
  });
  let dragDepth = 0;
  if (!native) {
    document.addEventListener('dragenter', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
    document.addEventListener('dragover', event => { event.preventDefault(); });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
    document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; browserFile(event.dataTransfer.files[0]); });
  }
  async function init() {
    setOutlineHidden(compactOutline.matches);
    applyPreferences(); renderRecent();
    $('runtime-label').textContent = native ? '本地阅读 · Rust 驱动' : '浏览器预览';
    await welcome();
    if (native) {
      try {
        await window.__TAURI__.event.listen('tauri://drag-enter', () => { $('drop-overlay').hidden = false; });
        await window.__TAURI__.event.listen('tauri://drag-leave', () => { $('drop-overlay').hidden = true; });
        await window.__TAURI__.event.listen('tauri://drag-drop', event => { $('drop-overlay').hidden = true; if (event.payload.paths?.[0]) loadPath(event.payload.paths[0]); });
        const startupId = state.loadId;
        const doc = await invoke('get_startup_document'); if (doc && state.loadId === startupId) await showDocument(doc, ++state.loadId);
      } catch (e) { toast(String(e)); }
    }
  }
  init().catch(e => toast(`启动失败：${e.message || e}`));
})();
