import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)('playwright');
let browser, page, server;
const errors = [];
const base = 'http://127.0.0.1:4174';
const fixture = `# 中文测试文档\n\n一份用于验证的文档。\n\n## 重复章节\n\n搜索目标在这里。\n\n## 重复章节\n\n第二个搜索目标。\n\n| 名称 | 内容 |\n| --- | --- |\n| Paper | Rust |\n\n- [x] 完成任务\n\n\`\`\`rust\nfn main() { println!("hello"); }\n\`\`\`\n\n<script>window.pwned = true</script>\n<img src="x" onerror="window.pwned = true">\n<a href="javascript:alert(1)">恶意链接</a>\n\n![远程图片](https://example.invalid/test.png)\n\n[重复章节](#重复章节)\n\n${Array.from({ length: 30 }, (_, i) => `## 段落 ${i}\n\n安静阅读。`.repeat(3)).join('\n\n')}`;
before(async () => {
  server = spawn(process.execPath, ['scripts/preview.mjs'], { env: { ...process.env, PORT: '4174' }, stdio: 'pipe', windowsHide: true });
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Preview server exited: ${code}`)));
  });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('#article h1').waitFor();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/中文笔记.md', fixture + '\n\n<div id="source-view">isolated</div>\n<div id="status-words">isolated stats</div>');
});
after(async () => { await browser?.close(); server?.kill(); });

test('welcome, offline rendering and desktop layout', async () => {
  assert.match(await page.locator('#article h1').innerText(), /让阅读/);
  assert.ok(await page.locator('#outline-list button').count() >= 4);
  assert.ok(await page.locator('#article input:checked:disabled').count() > 0);
  await page.click('#sidebar-toggle');
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.click('#sidebar-toggle');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/paper-light.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('settings change typography and survive reload', async () => {
  await page.click('#settings-toggle');
  await page.click('#font-increase');
  assert.equal((await page.locator('#font-size').innerText()).trim(), '18');
  await page.click('#theme-dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.reload(); await page.locator('#article h1').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal((await page.locator('#font-size').innerText()).trim(), '18');
  await page.screenshot({ path: 'test-results/paper-dark.png' });
  await page.click('#theme-toggle');
});

test('open UTF-8 Markdown, GFM, duplicate headings and untrusted HTML', async () => {
  await page.locator('#file-input').setInputFiles('test-results/中文笔记.md');
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '中文测试文档');
  assert.ok(await page.locator('#article table').count());
  assert.ok(await page.locator('#article input:checked:disabled').count());
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#article [onerror], #article script, #article [href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('#article .image-placeholder').count(), 1);
  const ids = await page.locator('#article h1,#article h2,#article h3').evaluateAll(nodes => nodes.map(n => n.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.match(await page.locator('#recent-list').innerText(), /中文笔记/);
  assert.equal(await page.locator('#article #md-source-view').innerText(), 'isolated');
  assert.match(await page.locator('#status-words').innerText(), /字/);
});

test('document search moves between matches and clears cleanly', async () => {
  await page.keyboard.press('Control+f');
  await page.fill('#search-input', '搜索目标');
  await page.waitForFunction(() => document.querySelector('#search-count').textContent === '1 / 2');
  await page.click('#search-next');
  assert.equal(await page.locator('#search-count').innerText(), '2 / 2');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#article mark.search-hit').count(), 0);
  assert.equal(await page.locator('#search-bar').isVisible(), false);
});

test('source mode and focus mode remain reversible', async () => {
  await page.click('#source-toggle');
  assert.match(await page.locator('#source-view').innerText(), /# 中文测试文档/);
  assert.equal(await page.locator('#article').isVisible(), false);
  await page.click('#source-toggle');
  await page.keyboard.press('Control+Shift+f');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('focus-mode')), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('focus-mode')), false);
});

test('reading progress restores when reopening same file', async () => {
  await page.locator('#reader-scroll').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.6; });
  await page.waitForFunction(() => document.querySelector('#status-progress').textContent === '60%');
  await page.click('#welcome-button');
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent.includes('让阅读'));
  await page.locator('#file-input').setInputFiles('test-results/中文笔记.md');
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '中文测试文档');
  await page.waitForFunction(() => document.querySelector('#status-progress').textContent === '60%');
});

test('reject unsupported file and adapt to small viewports', async () => {
  await page.locator('#file-input').setInputFiles({ name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('bad') });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('请选择'));
  assert.equal(await page.locator('#article h1').innerText(), '中文测试文档');
  await page.setViewportSize({ width: 800, height: 700 });
  assert.equal(await page.locator('#outline-panel').isVisible(), false);
  await page.click('#outline-toggle');
  assert.equal(await page.locator('#outline-panel').isVisible(), true);
  await page.locator('#outline-list button').first().click();
  assert.equal(await page.locator('#outline-panel').isVisible(), false);
  await page.click('#sidebar-toggle');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.screenshot({ path: 'test-results/paper-compact.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
