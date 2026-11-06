// End-to-end check of the main editing loop against a running server, using a
// locally installed Chrome or Edge (playwright-core; no browser download).
//
//   npm run serve            # in one terminal
//   npm run e2e              # in another (LOCALLEAF_URL defaults to http://localhost:4000)
//
// Creates a throwaway project, edits it, triggers a LaTeX error, jumps to it
// from the log, fixes it, checks SyncTeX both ways, then deletes the project.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.LOCALLEAF_URL || 'http://localhost:4000';
const SHOTS = process.env.LOCALLEAF_SHOTS || '';
const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; set BROWSER_PATH');

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'X-Localleaf': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()).data;
};

const step = (msg) => console.log(`  ✓ ${msg}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const browser = await chromium.launch({ executablePath, headless: true });
const project = await api('POST', '/api/projects', { name: 'e2e scratch' });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto(`${BASE}/#/`);
  await page.getByText('e2e scratch').waitFor();
  step('project list shows the new project');

  await page.getByText('e2e scratch').click();
  await page.locator('.cm-content').waitFor();
  assert.match(await page.locator('.cm-content').innerText(), /\\documentclass/);
  step('editor opens main.tex');

  // Introduce an undefined control sequence on a known line, then compile.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('\\undefinedmacro');
  await page.keyboard.press('Escape'); // close any completion popup
  await page.keyboard.press('Enter');
  await page.getByText('All changes saved').waitFor({ timeout: 10000 });
  step('autosave');

  await page.keyboard.press('Control+s');
  await page.locator('.log-entry.level-error').first().waitFor({ timeout: 180000 });
  const errText = await page.locator('.log-entry.level-error').first().innerText();
  assert.match(errText, /Undefined control sequence/);
  assert.match(errText, /main\.tex:16/);
  await shot(page, 'error-log');
  step('compile reports "Undefined control sequence" at main.tex:16');

  await page.locator('.cm-lint-marker-error').first().waitFor();
  step('error marker shown in the editor gutter');

  await page.locator('.log-entry.level-error').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type('Fixed line.');
  await page.getByText('All changes saved').waitFor({ timeout: 10000 });
  await page.keyboard.press('Control+Enter');
  await page.locator('.log-status.status-success').waitFor({ state: 'attached', timeout: 180000 });
  await page.locator('.pdf-page canvas').first().waitFor({ timeout: 30000 });
  // Regression: one keypress must trigger exactly one compile (no queued duplicate).
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.compile-btn.busy').count(), 0, 'a second compile was queued by a single shortcut');
  await shot(page, 'fixed');
  step('jump-to-error, fix and recompile renders the PDF');

  // Cursor helpers using only the keyboard and the active-line gutter (no test hooks in app code).
  const cursorLine = async () => Number(await page.locator('.cm-activeLineGutter').first().innerText());
  const setCursorLine = async (line) => {
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    for (let i = 1; i < line; i += 1) await page.keyboard.press('ArrowDown');
    assert.equal(await cursorLine(), line);
  };
  // Toasts vanish after a few seconds, so record every one that appears.
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (n.classList?.contains('toast')) window.__toasts.push(n.textContent);
    }))).observe(document.body, { childList: true, subtree: true });
  });
  const toasts = () => page.evaluate(() => window.__toasts.join(' | '));

  await setCursorLine(1);
  // Ask SyncTeX where line 16 ("Fixed line.") is drawn, then double-click exactly there.
  const [target] = await api('GET', `/api/projects/${project.id}/synctex/view?file=main.tex&line=16&column=0`);
  assert.ok(target, 'SyncTeX view returned no box for main.tex:16');
  const pageEl = page.locator('.pdf-page').nth(target.page - 1);
  const pageBox = await pageEl.boundingBox();
  const scale = pageBox.width / 612; // article default: US letter, 612pt wide
  await pageEl.dblclick({ position: { x: (target.h + 10) * scale, y: (target.v - 3) * scale } });
  await page.waitForFunction(() => Number(document.querySelector('.cm-activeLineGutter')?.textContent) > 1, null, { timeout: 15000 }).catch(async () => {
    throw new Error(`SyncTeX edit did not move the cursor (line ${await cursorLine()}); toasts: ${await toasts()}`);
  });
  assert.equal(await cursorLine(), 16);
  step('double-click in PDF moves the editor cursor to main.tex:16 (SyncTeX edit)');

  await setCursorLine(14); // "Start writing here…" paragraph
  await page.locator('button[title^="Show this line in the PDF"]').click();
  await page.locator('.sync-highlight').waitFor({ timeout: 15000 }).catch(async () => {
    throw new Error(`no SyncTeX highlight; toasts: ${await toasts()}`);
  });
  step('editor → PDF highlight (SyncTeX view)');

  // Regression: after renaming the open file, edits must keep autosaving under the new name.
  const row = page.locator('.tree-row', { hasText: 'main.tex' });
  await row.hover();
  await row.locator('button[title="Rename / move"]').click();
  await page.locator('dialog .input').fill('paper.tex');
  await page.locator('dialog button[value="ok"]').click();
  await page.locator('.editor-path', { hasText: 'paper.tex' }).waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% after rename');
  await page.getByText('All changes saved').waitFor({ timeout: 10000 });
  const renamed = await (await fetch(`${BASE}/api/projects/${project.id}/file?path=paper.tex`)).json();
  assert.match(renamed.data.content, /% after rename/);
  const meta = await (await fetch(`${BASE}/api/projects/${project.id}`)).json();
  assert.equal(meta.data.mainFile, 'paper.tex');
  step('rename keeps autosave working and updates the main document');

  assert.deepEqual(consoleErrors, []);
  step('no uncaught page errors');
} finally {
  await api('DELETE', `/api/projects/${project.id}`);
  await browser.close();
}
console.log('e2e passed');
