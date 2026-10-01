import type { Locator, Page } from 'playwright';
import { fault } from './errors.js';
import { figmaOrigin, fileUrl, sameFile, redact, type Expectation, type LocatorSpec, safeHtml } from './security.js';

export type Readiness = 'ready' | 'authenticated_unverified' | 'needs_login' | 'permission_denied' | 'consent_required' | 'ui_unsupported' | 'site_blocked' | 'network_error' | 'crashed';
export type Verification = { status: 'verified' | 'unverified'; saveState: 'saved' | 'unknown'; checks: string[] };

export function locate(page: Page, spec: LocatorSpec): Locator {
  if (spec.by === 'role') return page.getByRole(spec.role, { name: spec.name, exact: true });
  if (spec.by === 'label') return page.getByLabel(spec.name, { exact: true });
  return page.getByText(spec.name, { exact: true });
}

export async function probe(page: Page, expectedKey?: string): Promise<Readiness> {
  if (page.isClosed()) return 'crashed';
  const url = page.url();
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'ui_unsupported'; }
  if (parsed.origin !== figmaOrigin || /\/(?:login|signup|auth)(?:\/|$)/.test(parsed.pathname)) return 'needs_login';
  if (await page.getByRole('textbox', { name: /email|password/i }).count() > 0) return 'needs_login';
  if (await page.getByText(/request access|you don.t have access|permission denied/i).count() > 0) return 'permission_denied';
  if (await page.getByText(/accept.*terms|consent required/i).count() > 0) return 'consent_required';
  if (!expectedKey) {
    const dashboard = /^(?:\/files(?:\/|$)|\/team(?:\/|$))/.test(parsed.pathname);
    const recent = await page.getByRole('heading', { name: /recents|recent files|drafts/i }).count()
      + await page.getByRole('button', { name: /new design file|new file|create new/i }).count();
    const navigation = await page.getByRole('link', { name: /recents|drafts|all projects/i }).count()
      + await page.getByRole('button', { name: /recents|drafts/i }).count();
    return dashboard && recent > 0 && navigation > 0 ? 'authenticated_unverified' : 'ui_unsupported';
  }
  if (!sameFile(url, expectedKey)) return 'ui_unsupported';
  // These are capability probes, not claims that Figma's undocumented canvas has a node API.
  const canvas = await page.locator('canvas').count();
  const editor = await page.getByRole('toolbar').count() + await page.getByRole('treeitem').count();
  return canvas > 0 && editor > 0 ? 'ready' : 'ui_unsupported';
}

export async function requireEditor(page: Page, key: string): Promise<void> {
  const state = await probe(page, key);
  if (state !== 'ready') fault(state, 'The leased Figma editor is no longer ready.', 409);
}

export async function requireEditing(page: Page): Promise<void> {
  const readOnly = page.getByText(/^(?:View only|You can only view this file|Request edit access)$/i);
  for (let i = 0; i < await readOnly.count(); i++) {
    if (await readOnly.nth(i).isVisible()) fault('read_only', 'This editor reports read-only access.', 403);
  }
  const tools = page.getByRole('toolbar').getByRole('button', { name: /^(?:Frame|Text|Draw|Shape)(?: tool)?$/i });
  for (let i = 0; i < await tools.count(); i++) if (await tools.nth(i).isVisible() && await tools.nth(i).isEnabled()) return;
  fault('editing_unsupported', 'The visible editor does not expose a verified editing toolbar capability.', 409);
}

export async function inspection(page: Page): Promise<Record<string, unknown>> {
  const layers = page.getByRole('treeitem');
  const count = await layers.count();
  const names: string[] = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    // Only visible layer labels, never outerHTML, inputs, cookies or storage.
    if (await layers.nth(i).isVisible()) names.push(redact((await layers.nth(i).innerText({ timeout: 1000 })).slice(0, 200)));
  }
  const controls: { role: string; name: string; enabled: boolean; locator: LocatorSpec }[] = [];
  for (const role of ['button', 'textbox', 'tab', 'menuitem', 'checkbox', 'combobox'] as const) {
    const candidates = page.getByRole(role);
    for (let i = 0; i < Math.min(await candidates.count(), 50) && controls.length < 80; i++) {
      const element = candidates.nth(i);
      if (!await element.isVisible()) continue;
      const name = redact((await element.getAttribute('aria-label') ?? (role === 'textbox' ? '' : await element.innerText({ timeout: 1000 }))).slice(0, 200));
      if (name) controls.push({ role, name, enabled: await element.isEnabled(), locator: { by: 'role', role, name } });
    }
  }
  return { layers: names, controls, truncated: count > 100 || controls.length === 80, accessibility: {
    treeitems: count, toolbars: await page.getByRole('toolbar').count(),
    buttons: await page.getByRole('button').count(),
  }, capabilities: { canvas: await page.locator('canvas').count() > 0, nativeNodeApi: false } };
}

export async function readValue(page: Page, spec: LocatorSpec): Promise<string> {
  if (/password|token|secret|cookie|authorization|one.?time|verification code/i.test(spec.name)) fault('credential_field_denied', 'Credential fields cannot be read.', 403);
  const element = locate(page, spec);
  if (await element.count() !== 1) fault('ambiguous_locator', 'Readback requires one exact editor field.', 409);
  if (!await element.isVisible() || await element.getAttribute('type') === 'password'
    || /password|one-time-code/.test(await element.getAttribute('autocomplete') ?? '')) fault('credential_field_denied', 'Hidden or credential fields cannot be read.', 403);
  // Fixed implementation; no caller-controlled JavaScript or raw DOM is returned.
  const kind = await element.evaluate(node => ({ tag: node.tagName, editable: (node as HTMLElement).isContentEditable }));
  const value = ['INPUT', 'TEXTAREA', 'SELECT'].includes(kind.tag) ? await element.inputValue()
    : kind.editable ? await element.innerText() : fault('unsupported_readback', 'This locator is not an editable value field.', 409);
  return redact(value);
}

export async function verify(page: Page, expected?: Expectation): Promise<Verification> {
  const statuses = page.getByRole('status').filter({ hasText: /^(?:All changes saved|Saved to Figma|All changes have been saved)$/i });
  let saved = false;
  for (let i = 0; i < await statuses.count(); i++) if (await statuses.nth(i).isVisible()) saved = true;
  const checks: string[] = [];
  let passed = Boolean(expected);
  if (expected?.locator) {
    const locator = locate(page, expected.locator);
    const matches = await locator.count();
    const visible = matches === 1 && await locator.isVisible();
    if (matches > 1) return { status: 'unverified', saveState: saved ? 'saved' : 'unknown', checks: ['ambiguous_locator'] };
    if (visible === (expected.visible ?? true)) checks.push('visibility'); else passed = false;
    if (expected.text) {
      // Compare internally and never return form values or the requested text.
      if (visible && (await locator.innerText({ timeout: 1000 })).includes(expected.text)) checks.push('text'); else passed = false;
    }
  }
  if (expected?.saved !== undefined) {
    // Absence of a saved label is unknown, never proof of an unsaved state.
    if (expected.saved && saved) checks.push('saved'); else passed = false;
  }
  return { status: passed ? 'verified' : 'unverified', saveState: saved ? 'saved' : 'unknown', checks };
}

export async function pasteHtml(page: Page, html: string, target?: LocatorSpec): Promise<void> {
  safeHtml(html);
  if (target) await locate(page, target).click();
  // Fixed implementation, not agent-supplied JavaScript. Clipboard data is transient.
  // Figma may reject synthetic paste; the receipt remains unverified unless an expectation is observed.
  await page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/html', value);
    data.setData('text/plain', new DOMParser().parseFromString(value, 'text/html').body.textContent ?? '');
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
}

export function expectedKey(url: string): string { return fileUrl(url).fileKey; }
