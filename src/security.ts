import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { fault } from './errors.js';

export const LIMITS = Object.freeze({
  bodyBytes: 128 * 1024, artifactBytes: 8 * 1024 * 1024,
  artifactTotalBytes: 128 * 1024 * 1024, retentionMs: 60 * 60 * 1000,
  sessions: 32, tabs: 8, queue: 32, artifactJobs: 256, operationMs: 30_000,
  leaseMs: 120_000, loginMs: 10 * 60_000, text: 4096,
});
export const accountName = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
export const figmaOrigin = 'https://www.figma.com';
const fileTypes = new Set(['file', 'design', 'board', 'slides', 'proto']);

export function httpsUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { return fault('invalid_url', 'An absolute HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname) || /[\[\]:]/.test(url.hostname)
      || url.hostname.endsWith('.') || /[\\\u0000-\u0020]/.test(input)) {
    fault('invalid_url', 'Only HTTPS URLs with an exact permitted origin are allowed.');
  }
  return url;
}

export function fileUrl(input: string): { url: string; fileKey: string } {
  const url = httpsUrl(input);
  const [, kind, key] = url.pathname.split('/');
  if (url.origin !== figmaOrigin || !kind || !fileTypes.has(kind) || !key || !/^[a-zA-Z0-9]{6,128}$/.test(key)) {
    fault('invalid_file', 'Use a https://www.figma.com file, design, board, slides or proto URL.');
  }
  // Preserve editor selection without carrying credential-shaped queries.
  const selection = new URLSearchParams();
  for (const field of ['node-id', 'page-id']) {
    const value = url.searchParams.get(field);
    if (value !== null) {
      if (!/^[0-9]{1,16}[:-][0-9]{1,16}$/.test(value) || url.searchParams.getAll(field).length !== 1) fault('invalid_selection', 'Figma selection IDs must be numeric node/page IDs.');
      selection.set(field, value);
    }
  }
  const query = selection.size ? `?${selection}` : '';
  return { url: `${figmaOrigin}/${kind}/${key}${query}`, fileKey: key };
}

export function permittedNavigation(input: string, extraOrigins: readonly string[] = []): boolean {
  try {
    const url = httpsUrl(input);
    return url.origin === figmaOrigin || extraOrigins.includes(url.origin);
  } catch { return false; }
}

export function sameFile(input: string, key: string): boolean {
  try { return fileUrl(input).fileKey === key; } catch { return false; }
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkHttpBoundary(host: string | undefined, origin: string | undefined,
  expectedHost: string, authorization: string | undefined, token: string): void {
  if (host !== expectedHost) fault('host_denied', 'Host header is not permitted.', 403);
  // Browser clients must be same-origin. Missing Origin is normal for native MCP clients.
  if (origin !== undefined && origin !== `http://${expectedHost}`) fault('origin_denied', 'Origin is not permitted.', 403);
  if (!bearerMatches(authorization, token)) fault('unauthorized', 'A valid bearer token is required.', 401);
}

export function redact(input: string): string {
  const sensitive = /(?:password|secret|token|cookie|authorization|authcode|authorization_code|session|^code$)/i;
  const structured = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(structured);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitive.test(key) ? '[REDACTED]' : structured(item)]));
    return typeof value === 'string' ? redactText(value) : value;
  };
  const redactText = (value: string): string => value
    .replace(/\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]*/gi, '[REDACTED HEADER]')
    .replace(/(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[REDACTED]')
    .replace(/(["']?\b(?:[\w-]*token[\w-]*|[\w-]*secret[\w-]*|password|cookie|authorization|code|session)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}<>]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '[REDACTED]');
  try { return JSON.stringify(structured(JSON.parse(input) as unknown)).slice(0, LIMITS.text); }
  catch { return redactText(input).slice(0, LIMITS.text); }
}

/* Deliberately inert HTML subset: no attributes, media, SVG, CSS, links or entities
 * in tag syntax. The browser parses only approved structural/text tags. */
export function safeHtml(html: string): void {
  if (Buffer.byteLength(html) > 64 * 1024) fault('unsafe_html', 'HTML paste exceeds its size limit.');
  const tags = new Set(['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code']);
  let last = 0;
  const matcher = /<[^>]*>/g;
  for (const match of html.matchAll(matcher)) {
    if (html.slice(last, match.index).includes('<')) fault('unsafe_html', 'Malformed HTML is denied.');
    const tag = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\s*\/?>$/.exec(match[0]);
    if (!tag?.[1] || !tags.has(tag[1].toLowerCase())) fault('unsafe_html', 'Paste allows inert text markup without attributes or CSS only.');
    last = match.index + match[0].length;
  }
  if (html.slice(last).includes('<')) fault('unsafe_html', 'Malformed HTML is denied.');
}

export const locatorSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('role'), role: z.enum(['button', 'textbox', 'treeitem', 'tab', 'menuitem', 'checkbox', 'combobox']), name: z.string().min(1).max(200) }).strict(),
  z.object({ by: z.literal('label'), name: z.string().min(1).max(200) }).strict(),
  z.object({ by: z.literal('text'), name: z.string().min(1).max(200) }).strict(),
]);
export type LocatorSpec = z.infer<typeof locatorSchema>;
export const pointSchema = z.object({ x: z.number().min(0).max(1920), y: z.number().min(0).max(1200) }).strict();
export const expectationSchema = z.object({
  locator: locatorSchema.optional(), visible: z.boolean().optional(),
  text: z.string().min(1).max(200).optional(), saved: z.boolean().optional(),
}).strict().refine(value => Boolean(value.locator || value.saved), 'Specify a locator or saved state.')
  .refine(value => !value.text || Boolean(value.locator), 'Text requires a locator.');
export type Expectation = z.infer<typeof expectationSchema>;
