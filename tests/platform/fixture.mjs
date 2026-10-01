import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { packageRoot } from './runtime.mjs';

const require = createRequire(join(packageRoot, 'package.json'));
const { chromium } = require('playwright');

export const firstKey = 'FixtureAlpha01';
export const secondKey = 'FixtureBeta02';
export const file = key => `https://www.figma.com/design/${key}`;
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function editor(key) {
  return `<!doctype html><html lang="en"><head><title>Credential-free fixture</title></head>
    <body style="font:20px sans-serif;background:${key === firstKey ? '#def' : '#fed'}">
    <div role="toolbar" aria-label="Editor"><button>Frame</button><button>Text</button><button id="add">Add layer</button>
    <button id="unknown">Unobservable action</button></div>
    <label>Description <input aria-label="Description" id="description"></label>
    <div role="treeitem">${key}</div><div role="treeitem" id="note">Initial note</div>
    <div role="treeitem" id="revision"></div><canvas width="640" height="180"></canvas>
    <p role="status" id="save">All changes saved</p>
    <script>
      const key = '${key}';
      const storageKey = 'fixture-revision-' + key;
      let revision = Number(localStorage.getItem(storageKey) || 0);
      const show = () => document.getElementById('revision').textContent = 'Revision ' + revision;
      show();
      document.getElementById('description').addEventListener('input', event => {
        document.getElementById('note').textContent = event.target.value;
      });
      document.getElementById('add').addEventListener('click', () => {
        revision++; localStorage.setItem(storageKey, String(revision)); show();
        const layer = document.createElement('div'); layer.setAttribute('role', 'treeitem');
        layer.textContent = key + ' layer ' + revision; document.body.append(layer);
        document.getElementById('save').textContent = 'Saving';
        setTimeout(() => document.getElementById('save').textContent = 'All changes saved', 30);
      });
      const context = document.querySelector('canvas').getContext('2d');
      context.fillStyle = '#246'; context.fillRect(5, 5, 160, 80);
    </script></body></html>`;
}

async function fixtureRoute(route) {
    const url = new URL(route.request().url());
    const key = url.pathname.split('/')[2];
    if (key === firstKey || key === secondKey) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: editor(key) });
    }
    if (url.pathname === '/design/PermissionDenied01') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Permission denied</p>' });
    }
    if (url.pathname === '/design/NeedsLogin01' || url.pathname === '/files/recents' || url.pathname === '/login') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<label>Email<input aria-label="Email"></label>' });
    }
    // Unexpected Figma requests never access the network or a real account.
    return route.abort('blockedbyclient');
}

export async function launchFixture(profile, options) {
  let context;
  try { context = await chromium.launchPersistentContext(profile, options); }
  catch (error) {
    if (String(error.message).includes('No usable sandbox')) {
      process.stderr.write('Playwright reported "No usable sandbox" for this host. Keep sandboxing enabled; explicitly qualify a working system Chrome with --system-browser /usr/bin/google-chrome.\n');
    }
    throw error;
  }
  // Install per-page interception before the supervisor's startup dashboard.
  // Only exact Figma fixture requests are fulfilled; external requests still
  // reach the production navigation guard. No real Figma server is contacted.
  context.on('page', page => { void page.route('https://www.figma.com/**', fixtureRoute); });
  for (const page of context.pages()) await page.route('https://www.figma.com/**', fixtureRoute);
  return context;
}

export async function attachFixture(supervisor) {
  const worker = supervisor.workers.get('default');
  assert.ok(worker, 'Production supervisor must own the real Chromium context.');
  return worker;
}
