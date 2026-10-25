// Optional smoke test against the actual Rust + WebView2 executable.
// Run after cargo build, with Playwright installed. No system configuration changes.
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const exe = path.resolve(process.argv[2] || 'src-tauri/target/release/paper-reader.exe');
const port = 9223;
const profile = path.resolve(`test-results/native-profile-${process.pid}`);
await mkdir(profile, { recursive: true });
const app = spawn(exe, [path.resolve('README.md')], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} ${process.env.PAPER_BROWSER_ARGS || ''}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
  },
  stdio: 'pipe',
});
let launchError, browser;
app.on('error', e => { launchError = e; });
app.stderr.on('data', data => process.stderr.write(data));
try {
  for (let tries = 0; tries < 80; tries++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`App exited: ${app.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '纸页 Paper', null, { timeout: 20000 });
  assert.equal(await page.locator('#runtime-label').innerText(), '本地阅读 · Rust 驱动');
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
  const memory = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', memoryScript], { windowsHide: true });
  console.log(`Native process-tree memory snapshot (not a benchmark): ${memory.stdout.trim()}`);
  console.log('PASS: native startup file, Rust IPC rendering, sanitization, GFM, theme, document search.');
  console.log(`Native process id: ${app.pid}`);
} finally {
  await browser?.close().catch(() => {});
  app.kill();
}
