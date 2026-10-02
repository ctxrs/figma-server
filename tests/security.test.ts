import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bearerMatches, checkHttpBoundary, fileUrl, httpsUrl, permittedNavigation, redact, safeHtml } from '../src/security.js';
import { privateDirectory, privateFile, State } from '../src/state.js';
import { parseTool } from '../src/tools.js';

test('exact navigation policy rejects schemes, lookalikes, IPv4/IPv6, credentials and alternate origins', () => {
  const bad = ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'blob:https://www.figma.com/id',
    'http://www.figma.com/design/abcdef', 'https://figma.com/design/abcdef', 'https://www.figma.com.evil.test/design/abcdef',
    'https://user:pass@www.figma.com/design/abcdef', 'https://127.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'https://www.figma.com:444/design/abcdef', 'https://www.figma.com./design/abcdef', 'https://www.figma.com\\@evil.test/design/abcdef'];
  for (const url of bad) assert.equal(permittedNavigation(url), false, url);
  for (const ip of ['https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://2130706433', 'https://0x7f000001']) assert.throws(() => httpsUrl(ip));
  const file = fileUrl('https://www.figma.com/design/abcdef123/Name?node-id=1-2&page-id=0%3A1&access_token=secret');
  assert.equal(file.fileKey, 'abcdef123');
  assert.equal(file.url, 'https://www.figma.com/design/abcdef123?node-id=1-2&page-id=0%3A1');
  assert.throws(() => fileUrl('https://www.figma.com/design/abcdef123?node-id=../../secret'));
  assert.equal(permittedNavigation('https://login.example.test', ['https://login.example.test']), true);
  assert.equal(permittedNavigation('https://evil.login.example.test', ['https://login.example.test']), false);
});

test('auth is required on loopback and exact Host/Origin validated', () => {
  const token = 'a'.repeat(64);
  assert.equal(bearerMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerMatches(`Bearer ${'b'.repeat(64)}`, token), false);
  for (const [host, origin, auth] of [
    ['127.0.0.1:4317', undefined, undefined], ['evil.test:4317', undefined, `Bearer ${token}`],
    ['127.0.0.1:4317', 'null', `Bearer ${token}`], ['127.0.0.1:4317', 'http://evil.test', `Bearer ${token}`],
  ]) assert.throws(() => checkHttpBoundary(host, origin, '127.0.0.1:4317', auth, token));
  checkHttpBoundary('127.0.0.1:4317', undefined, '127.0.0.1:4317', `Bearer ${token}`, token);
});

test('inert HTML allowlist denies media, attributes, obfuscated CSS and malformed tags', () => {
  safeHtml('<div><h1>Title</h1><p><b>Hello</b> &amp; world<br></p></div>');
  for (const html of ['<video poster=https://attacker.invalid/pixel>', '<span style="background:u\\72l(https://attacker.invalid)">a</span>',
    '<div style="background:image-set(\'https://evil.test\')">a</div>', '<img src=x>', '<style>body{color:red}</style>',
    '<script>x</script>', '<svg/>', '<div onclick="x()">a</div>', '<!--comment-->', '<p attr=x>', '<<p>>', '<p']) {
    assert.throws(() => safeHtml(html), html);
  }
});

test('redaction removes short synthetic secrets, structured fields and complete credential headers', () => {
  for (const input of ['{"password":"shortsyntheticsecret","safe":"hello"}', "{password:'shortsyntheticsecret'}",
    'access_token=shortsyntheticsecret', 'Authorization: Basic shortsyntheticsecret',
    'Cookie: first=ok; second=shortsyntheticsecret', 'Set-Cookie: shortsyntheticsecret; SameSite=Lax',
    '{"nested":{"refresh_token":"shortsyntheticsecret"}}']) {
    assert.equal(redact(input).includes('shortsyntheticsecret'), false, input);
  }
  assert.match(redact('{"safe":"hello","password":"p"}'), /hello/);
});

test('raw CDP accepts arbitrary protocol methods while strict envelopes and input bounds remain', () => {
  const lease = 'a66028b1-1369-49a5-b1a3-bbdf60c6e714';
  for (const command of ['Runtime.evaluate', 'Debugger.resume', 'Browser.close', 'Page.navigate', 'DOM.getDocument', 'UnknownDomain.customMethod']) {
    assert.equal(parseTool('figma.cdp', { lease, command, params: { arbitrary: { nested: true } } }).name, 'figma.cdp');
  }
  assert.throws(() => parseTool('figma.cdp', { lease, command: 'invalid method' }));
  assert.throws(() => parseTool('figma.cdp', { lease, command: 'Runtime.evaluate', expression: '42' }));
  assert.throws(() => parseTool('figma.evaluate', { lease, expression: 'x'.repeat(65537) }));
  assert.throws(() => parseTool('figma.pointer_click', { lease, point: { x: -1, y: 10 } }));
  assert.throws(() => parseTool('figma.type_text', { lease, text: 'x'.repeat(5000) }));
  assert.throws(() => parseTool('figma.open', { file_url: 'x', parallel: true }));
});

test('private state denies symlinks, hard links, unsafe ancestors and traversal', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-security-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new State(root);
  assert.throws(() => state.path('../other'));
  const link = join(root, 'link');
  await symlink(root, link, 'dir');
  await assert.rejects(privateDirectory(join(link, 'profile')));
  const unsafe = join(root, 'unsafe');
  await mkdir(unsafe, { mode: 0o700 }); await chmod(unsafe, 0o777);
  if (process.platform !== 'win32') await assert.rejects(privateDirectory(join(unsafe, 'account', 'profile')), /ancestry/);
  await writeFile(join(root, 'secret'), 'test', { mode: 0o644 });
  if (process.platform !== 'win32') await assert.rejects(privateFile(join(root, 'secret')), /0600/);
});
