import { z } from 'zod';
import { accountName, expectationSchema, locatorSchema, pointSchema, modifiersSchema, LIMITS } from './security.js';
import { fault } from './errors.js';

const lease = z.string().uuid();
const expectation = expectationSchema.optional();
const cdpScope = z.enum(['tab', 'browser']).default('tab');
function sharedClipboardShortcut(keys: string): boolean {
  const parts = keys.toLowerCase().split('+').map(part => part.replace(/(?:left|right)$/, ''));
  const physical = parts.at(-1)?.replace(/^key/, '');
  const key = physical === 'numpad0' ? 'insert' : physical === 'numpaddecimal' ? 'delete' : physical;
  const control = parts.some(part => /^(?:control|meta|controlormeta|ctrl|cmd|command)$/.test(part));
  const shift = parts.includes('shift');
  return ['copy', 'cut', 'paste'].includes(key ?? '')
    || (control && ['c', 'x', 'v', 'insert'].includes(key ?? ''))
    || (shift && ['insert', 'delete'].includes(key ?? ''))
    || (control && shift && key === 'r'); // Figma Paste to replace.
}
export const toolSchemas = {
  'figma.account_status': z.object({ account: accountName.default('default') }).strict(),
  'figma.open': z.object({ file_url: z.string().max(2048), account: accountName.default('default'), mode: z.enum(['read', 'write']).default('write') }).strict(),
  'figma.release': z.object({ lease }).strict(),
  'figma.heartbeat': z.object({ lease }).strict(),
  'figma.inspect': z.object({ lease }).strict(),
  'figma.read_value': z.object({ lease, locator: locatorSchema }).strict(),
  'figma.reload': z.object({ lease }).strict(),
  'figma.screenshot': z.object({ lease, scope: locatorSchema.optional() }).strict(),
  'figma.artifact_read': z.object({ job_id: z.string().regex(/^job_[a-f0-9-]{36}$/), file: z.enum(['before.png', 'after.png', 'screenshot.png', 'export.png']) }).strict(),
  'figma.click': z.object({ lease, locator: locatorSchema, modifiers: modifiersSchema, expectation }).strict(),
  'figma.pointer_click': z.object({ lease, point: pointSchema, clicks: z.union([z.literal(1), z.literal(2)]).default(1), button: z.enum(['left', 'right']).default('left'), modifiers: modifiersSchema, expectation }).strict(),
  'figma.type_text': z.object({ lease, text: z.string().min(1).max(LIMITS.text), expectation }).strict(),
  'figma.wheel': z.object({ lease, point: pointSchema, delta_x: z.number().min(-1200).max(1200).default(0), delta_y: z.number().min(-1200).max(1200), expectation }).strict(),
  'figma.fill': z.object({ lease, locator: locatorSchema, text: z.string().max(LIMITS.text), expectation }).strict(),
  'figma.keypress': z.object({ lease, keys: z.string().min(1).max(80).regex(/^[A-Za-z0-9+_-]+$/), expectation }).strict(),
  'figma.drag': z.object({ lease, from: pointSchema, to: pointSchema, modifiers: modifiersSchema, expectation }).strict(),
  'figma.upload_image': z.object({ lease, filename: z.string().min(1).max(105), data_base64: z.string().min(1).max(LIMITS.imageBase64Chars), trigger: locatorSchema, expectation }).strict(),
  'figma.paste_html': z.object({ lease, html: z.string().max(64 * 1024), target: locatorSchema.optional(), expectation }).strict(),
  // V1 export is an explicit rendered PNG, not a native Figma node export.
  'figma.export': z.object({ lease, format: z.literal('png'), node: locatorSchema.optional() }).strict(),
  'figma.wait_for': z.object({ lease, predicate: expectationSchema, timeout: z.number().int().min(1).max(20_000).default(10_000) }).strict(),
  'figma.verify': z.object({ lease, expectation: expectationSchema }).strict(),
  'figma.evaluate': z.object({ lease, expression: z.string().min(1).max(64 * 1024),
    await_promise: z.boolean().default(true), timeout_ms: z.number().int().min(1).max(LIMITS.operationMs).default(LIMITS.operationMs) }).strict(),
  'figma.cdp': z.object({ lease, command: z.string().max(200).regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/),
    params: z.record(z.string(), z.unknown()).default({}), scope: cdpScope }).strict(),
  'figma.cdp_events': z.object({ lease, scope: cdpScope, after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(100), wait_ms: z.number().int().min(0).max(10_000).default(0) }).strict(),
  'figma.cdp_close': z.object({ lease, scope: cdpScope }).strict(),
} as const;
export type ToolName = keyof typeof toolSchemas;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolSchemas)[N]>;
export const toolDescriptions: Record<ToolName, string> = {
  'figma.account_status': 'Report browser account readiness without exposing credentials.',
  'figma.open': 'Open an exact HTTPS Figma file in a private tab and acquire a short-lived lease.',
  'figma.release': 'Invalidate a lease and close its tab.',
  'figma.heartbeat': 'Renew an owned lease for two minutes.',
  'figma.inspect': 'Inspect bounded visible layer names and editor capability counts; no raw DOM.',
  'figma.read_value': 'Read a bounded value from one exact editor field, with credential-field denial and redaction.',
  'figma.reload': 'Reload only this leased file and recheck readiness without releasing its file lease.',
  'figma.screenshot': 'Save a private bounded screenshot; returns an artifact reference.',
  'figma.artifact_read': 'Read a bounded image artifact owned by this session as MCP image content.',
  'figma.click': 'Click an exact accessible locator; edits are unverified without an observed postcondition.',
  'figma.pointer_click': 'Click or double-click bounded screenshot coordinates within the owned canvas tab.',
  'figma.type_text': 'Insert text into the focused native editor control or canvas text editor.',
  'figma.wheel': 'Position the pointer and scroll bounded deltas within the owned canvas tab.',
  'figma.fill': 'Fill an exact editor locator; no login forms.',
  'figma.keypress': 'Send one key with optional Control/Meta/Alt/Shift/ControlOrMeta modifiers. Use separate calls for multiple keys. Native clipboard shortcuts are disabled; use type_text/fill or Control/Meta+D for Duplicate. UI clipboard menus are unsupported across concurrent jobs.',
  'figma.drag': 'Drag between coordinates within the fixed viewport.',
  'figma.upload_image': 'Upload supplied bounded PNG/JPEG bytes through one exact file-chooser trigger in the owned editor. No local file paths or URL fetching. Input dispatch alone does not prove a saved native image edit.',
  'figma.paste_html': 'Dispatch offline HTML clipboard data. Native Figma insertion is not guaranteed.',
  'figma.export': 'Capture a rendered PNG viewport or accessible element. This is not a native node export.',
  'figma.wait_for': 'Wait for a bounded typed visible or saved-state predicate.',
  'figma.verify': 'Record a receipt for an observed typed postcondition, or mark it unverified.',
  'figma.evaluate': 'Run arbitrary JavaScript in an owned writer tab. Returns the Runtime remote object and exception details; not a saved-edit guarantee. Trusted operators can bypass UI and credential restrictions.',
  'figma.cdp': 'Send any CDP method/parameters on a persistent lease+scope connection. Default tab; browser scope shares the account worker and can affect other agents or bypass file locks. Use non-flattened Target sessions and Target.sendMessageToTarget for nested messages. Raw results are unredacted and bounded to 1 MiB.',
  'figma.cdp_events': 'Read all CDP events from this lease+scope connection by cursor, optionally waiting up to 10 seconds. Reports buffer loss explicitly. Commands must enable their protocol domains. At most 512 events/1 MiB retained.',
  'figma.cdp_close': 'Detach only this lease+scope CDP connection. Reopening creates a new connection and event cursor. Raw-created targets remain until explicitly closed or browser shutdown; trusted raw navigation lasts for this worker generation.',
};
export function parseTool(name: string, input: unknown): { name: ToolName; input: unknown } {
  if (!Object.hasOwn(toolSchemas, name)) fault('unknown_tool', 'Unknown tool.', 404);
  const toolName = name as ToolName;
  const parsed = toolSchemas[toolName].safeParse(input);
  if (!parsed.success) fault('invalid_arguments', 'Tool arguments do not match the strict schema.');
  if (toolName === 'figma.keypress') {
    const keys = (parsed.data as ToolInput<'figma.keypress'>).keys;
    const parts = keys.split('+');
    if (!parts.at(-1) || parts.slice(0, -1).some(part => !/^(?:(?:Control|Meta|Alt|Shift)(?:Left|Right)?|ControlOrMeta)$/.test(part))) {
      fault('invalid_keypress', 'Use one final key preceded only by Control, Meta, Alt, Shift, ControlOrMeta, or physical Left/Right modifiers. Send multiple keys in separate figma.keypress calls.');
    }
    if (sharedClipboardShortcut(keys)) {
      fault('shared_clipboard', 'Native clipboard shortcuts share state across jobs and are unsupported. Use figma.type_text or figma.fill, or Control/Meta+D for native Duplicate.');
    }
  }
  return { name: toolName, input: parsed.data };
}
