import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4175';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let browser, server;

before(async () => {
  server = spawn(process.execPath, ['scripts/preview.mjs'], {
    env: { ...process.env, PORT: '4175' }, stdio: 'pipe', windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview server did not start')), 15000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview server exited: ${code}`)); });
  });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => { await browser?.close(); server?.kill(); });

async function newPage(t, native = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  if (native) {
    await page.addInitScript(() => {
      const doc = {
        path: 'C:\\notes\\images.md', name: 'images.md', source: '# Images', wordCount: 1, readingMinutes: 1,
        html: '<h1>Images</h1><p><a href="missing.md">Missing document</a></p><img src="one.png"><img src="two.png"><img src="three.png">',
      };
      window.nativeTest = { images: [], openResult: null };
      window.__TAURI__ = {
        core: {
          invoke: async (command, args) => {
            if (command === 'render_markdown') return { html: '<h1>Welcome</h1>', wordCount: 1, readingMinutes: 1 };
            if (command === 'take_pending_documents') return [doc.path];
            if (command === 'open_document') { window.nativeTest.openCalls = (window.nativeTest.openCalls || 0) + 1; return window.nativeTest.openResult; }
            if (command === 'read_document') { if (args.path === doc.path) return doc; throw new Error('Missing test document'); }
            if (command === 'read_local_image') return new Promise(resolve => {
              window.nativeTest.images.push({ path: args.imagePath, resolve });
            });
            throw new Error(`Unexpected native command: ${command}`);
          },
        },
        event: { listen: async () => () => {} },
      };
    });
  }
  await page.goto(base);
  await page.locator('#article h1').waitFor();
  if (native) await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === 'Images' && window.nativeTest.images.length === 2);
  return page;
}

for (const action of ['Enter', 'next', 'previous']) {
  test(`search ${action} flushes an edited query before navigating`, async t => {
    const page = await newPage(t);
    await page.locator('#file-input').setInputFiles({
      name: 'search.md', mimeType: 'text/markdown', buffer: Buffer.from('# Search\n\nalpha alpha beta'),
    });
    await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === 'Search');
    await page.click('#search-toggle');
    await page.fill('#search-input', 'alpha');
    await page.waitForFunction(() => document.querySelector('#search-count').textContent === '1 / 2');
    // Dispatch in one browser task, before the 160 ms debounce can run.
    await page.evaluate(action => {
      const input = document.getElementById('search-input');
      input.value = 'beta';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (action === 'Enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      else document.getElementById(action === 'next' ? 'search-next' : 'search-prev').click();
    }, action);
    assert.deepEqual(await page.locator('#article mark.search-hit').allTextContents(), ['beta']);
    assert.equal(await page.locator('#search-count').innerText(), '1 / 1');
  });
}

test('raw picture and background cannot bypass click-to-load remote images', async t => {
  const page = await newPage(t);
  const requests = [];
  // All attempted remote requests are intercepted, never transmitted.
  await page.route('https://paper-test.invalid/**', route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(pixel.split(',')[1], 'base64') });
  });
  const source = '# Privacy\n\n' +
    `<picture><source srcset="https://paper-test.invalid/source.png"><img src="${pixel}" alt="inline"></picture>\n\n` +
    '<table background="https://paper-test.invalid/background.png"><tr><td>table</td></tr></table>\n\n' +
    '![click](https://paper-test.invalid/click.png)';
  await page.locator('#file-input').setInputFiles({ name: 'privacy.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === 'Privacy');
  assert.equal(await page.locator('#article source, #article [srcset], #article [background]').count(), 0);
  assert.equal(await page.locator('#article .image-placeholder').count(), 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(requests, []);
  const response = page.waitForResponse('https://paper-test.invalid/click.png');
  await page.locator('#article .image-placeholder').click();
  await response;
  assert.deepEqual(requests, ['https://paper-test.invalid/click.png']);
});

for (const outcome of ['cancelled dialog', 'failed document']) {
  test(`current image queue survives a ${outcome}`, async t => {
    const page = await newPage(t, true);
    if (outcome === 'cancelled dialog') {
      await page.click('#open-file');
      await page.waitForFunction(() => window.nativeTest.openCalls === 1);
    } else {
      await page.locator('#article a').click();
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Missing test document'));
    }
    await page.evaluate(pixel => window.nativeTest.images[0].resolve(pixel), pixel);
    await page.waitForFunction(() => document.querySelector('#article img')?.getAttribute('src')?.startsWith('data:image/png'));
    // The third image was queued behind the first two. It must still start.
    await page.waitForFunction(() => window.nativeTest.images.length === 3);
    await page.evaluate(pixel => window.nativeTest.images.slice(1).forEach(image => image.resolve(pixel)), pixel);
    await page.waitForFunction(() => [...document.querySelectorAll('#article img')].every(image => image.getAttribute('src')?.startsWith('data:image/png')));
    assert.equal(await page.locator('#article h1').innerText(), 'Images');
  });
}

test('replacing the document discards the old image queue', async t => {
  const page = await newPage(t, true);
  await page.evaluate(() => {
    window.nativeTest.openResult = {
      path: 'C:\\notes\\next.md', name: 'next.md', source: '# Replacement',
      html: '<h1>Replacement</h1><img src="new.png">', wordCount: 1, readingMinutes: 1,
    };
  });
  await page.click('#open-file');
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === 'Replacement' && window.nativeTest.images.some(image => image.path === 'new.png'));
  await page.evaluate(pixel => window.nativeTest.images.filter(image => image.path !== 'new.png').forEach(image => image.resolve(pixel)), pixel);
  assert.equal(await page.locator('#article img').getAttribute('src'), null);
  await page.evaluate(pixel => window.nativeTest.images.find(image => image.path === 'new.png').resolve(pixel), pixel);
  await page.waitForFunction(() => document.querySelector('#article img')?.getAttribute('src')?.startsWith('data:image/png'));
  assert.deepEqual(await page.evaluate(() => window.nativeTest.images.map(image => image.path)), ['one.png', 'two.png', 'new.png']);
});


test('native file launches survive startup and newer/repeated requests win', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    const handlers = {};
    const pending = ['C:\\阅读 笔记\\初次.md'];
    const delayed = {};
    window.launchTest = {
      handlers, delayed,
      send(path) { pending.push(path); handlers['paper://open-documents']?.({}); },
    };
    window.__TAURI__ = {
      event: { listen: async (name, callback) => { handlers[name] = callback; return () => {}; } },
      core: { invoke: async (command, args) => {
        if (command === 'render_markdown') return { html: '<h1>Welcome</h1>', wordCount: 1, readingMinutes: 1 };
        if (command === 'take_pending_documents') return pending.splice(0);
        if (command === 'read_document') {
          const name = args.path.split('\\').pop();
          if (name === 'missing.md') throw new Error('Missing document');
          const doc = { path: args.path, name, source: `# ${name}`, html: `<h1>${name}</h1>`, wordCount: 1, readingMinutes: 1 };
          if (name === 'slow.md') return new Promise(resolve => { delayed.slow = () => resolve(doc); });
          return doc;
        }
        throw new Error(`Unexpected command ${command}`);
      } },
    };
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '初次.md');
  await page.evaluate(() => window.launchTest.send('C:\\阅读 笔记\\slow.md'));
  await page.waitForFunction(() => !!window.launchTest.delayed.slow);
  await page.evaluate(() => window.launchTest.send('C:\\阅读 笔记\\第二 次.md'));
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第二 次.md');
  await page.evaluate(() => window.launchTest.delayed.slow());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#article h1').innerText(), '第二 次.md');
  await page.click('#welcome-button');
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === 'Welcome');
  await page.evaluate(() => window.launchTest.send('C:\\阅读 笔记\\第二 次.md'));
  await page.waitForFunction(() => document.querySelector('#article h1')?.textContent === '第二 次.md');
  await page.evaluate(() => window.launchTest.send('C:\\阅读 笔记\\missing.md'));
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Missing document'));
  assert.equal(await page.locator('#article h1').innerText(), '第二 次.md');
});
