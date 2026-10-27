// Optional smoke test against the actual Rust + WebView2 executable.
// Run after cargo build, with Playwright installed. No system configuration changes.
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const exe = path.resolve(process.argv[2] || 'src-tauri/target/release/paper-reader.exe');
if (process.platform !== 'win32') throw new Error('Native smoke requires Windows + WebView2.');
const port = 9223;
await mkdir('test-results', { recursive: true });
const fixtureDir = await mkdtemp(path.resolve('test-results/关联 smoke '));
const first = path.join(fixtureDir, '第一篇 有空格.md');
const second = path.join(fixtureDir, '第二篇 文档.MD');
const slow = path.join(fixtureDir, '较长 文档.md');
await writeFile(first, '# 第一篇阅读\n\n冷启动文件关联。', 'utf8');
await writeFile(second, '# 第二篇阅读\n\n已运行实例中的新文件。', 'utf8');
await writeFile(slow, '# 较长阅读\n\n' + '重复文字 '.repeat(200000), 'utf8');
const children = new Set();
// Each warm-launch process must hand off its arguments and exit, not leave a
// second reader running. Wait for exit before issuing the next ordered request.
async function launchFile(file, cwd = fixtureDir) {
  const child = spawn(exe, [file], { cwd, windowsHide: true, stdio: 'ignore' });
  children.add(child);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Warm launch timed out: ${file}`)); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Warm launch failed (${code}, ${signal}): ${file}`));
      });
    });
  } finally { children.delete(child); }
}
const profile = path.resolve(`test-results/native-profile-${process.pid}`);
await mkdir(profile, { recursive: true });
const app = spawn(exe, [first], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} ${process.env.PAPER_BROWSER_ARGS || ''}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let launchError, browser;
app.on('error', e => { launchError = e; });
app.stderr.on('data', data => process.stderr.write(data));
try {
  for (let tries = 0; tries < 80; tries++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`App exited: ${app.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第一篇阅读', null, { timeout: 20000 });
  assert.equal(await page.locator('#runtime-label').innerText(), '本地阅读 · Rust 驱动');
  assert.equal(await page.locator('#breadcrumb-name').innerText(), path.basename(first));
  // Relative Unicode paths must resolve against the second process's cwd.
  await launchFile(path.basename(second));
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第二篇阅读');
  assert.equal(await page.locator('#breadcrumb-name').innerText(), path.basename(second));
  await page.locator('#welcome-button').click();
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent.includes('让阅读'));
  await launchFile(second);
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第二篇阅读');
  // A slower earlier read must not replace the newest request once it finishes.
  await launchFile(slow);
  await launchFile(first);
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第一篇阅读');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#article h1').innerText(), '第一篇阅读');
  await launchFile(path.join(fixtureDir, '不存在 文件.md'));
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast');
    return !toast.hidden && toast.textContent.includes('无法打开文件');
  });
  assert.equal(await page.locator('#article h1').innerText(), '第一篇阅读');
  assert.equal(app.exitCode, null, 'the original reader must remain running');
  const rendered = await page.evaluate(() => window.__TAURI__.core.invoke('render_markdown', { source: '# 测试\n\n<script>evil()</script>\n\n- [x] done' }));
  assert.match(rendered.html, /<h1>测试<\/h1>/);
  assert.ok(!rendered.html.includes('<script'));
  assert.match(rendered.html, /checkbox/);
  await page.locator('#welcome-button').click();
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent.includes('让阅读'));
  await page.screenshot({ path: 'test-results/paper-native.png' });
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('阅读');
  await page.waitForFunction(() => document.querySelectorAll('#article mark.search-hit').length > 0);
  assert.deepEqual(errors, []);
  const memoryScript = `$items = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add(${app.pid}); for ($i=0; $i -lt $ids.Count; $i++) { foreach ($child in $items | Where-Object ParentProcessId -eq $ids[$i]) { $ids.Add([int]$child.ProcessId) } }; $processes = Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue; [PSCustomObject]@{Processes=$processes.Count; WorkingSetMiB=[math]::Round(($processes | Measure-Object WorkingSet64 -Sum).Sum / 1MB,1); PrivateMiB=[math]::Round(($processes | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB,1)} | ConvertTo-Json -Compress`;
  const memory = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', memoryScript], { windowsHide: true, timeout: 15000 });
  console.log(`Native process-tree memory snapshot (not a benchmark): ${memory.stdout.trim()}`);
  console.log('PASS: Unicode/spaced cold launch, relative warm launch, repeated file, latest request wins, missing file recovery, Rust IPC rendering, sanitization, GFM, theme, document search.');
  console.log(`Native process id: ${app.pid}`);
} finally {
  for (const child of children) child.kill();
  await browser?.close().catch(() => {});
  if (app.pid) await promisify(execFile)('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {});
  await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch(() => {});
}

