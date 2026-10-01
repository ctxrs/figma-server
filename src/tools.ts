import { z } from 'zod';
import { accountName, expectationSchema, locatorSchema, pointSchema, LIMITS } from './security.js';
import { fault } from './errors.js';

const lease = z.string().uuid();
const expectation = expectationSchema.optional();
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
  'figma.click': z.object({ lease, locator: locatorSchema, expectation }).strict(),
  'figma.pointer_click': z.object({ lease, point: pointSchema, clicks: z.union([z.literal(1), z.literal(2)]).default(1), button: z.enum(['left', 'right']).default('left'), expectation }).strict(),
  'figma.type_text': z.object({ lease, text: z.string().min(1).max(LIMITS.text), expectation }).strict(),
  'figma.wheel': z.object({ lease, point: pointSchema, delta_x: z.number().min(-1200).max(1200).default(0), delta_y: z.number().min(-1200).max(1200), expectation }).strict(),
  'figma.fill': z.object({ lease, locator: locatorSchema, text: z.string().max(LIMITS.text), expectation }).strict(),
  'figma.keypress': z.object({ lease, keys: z.string().min(1).max(80).regex(/^[A-Za-z0-9+_-]+$/), expectation }).strict(),
  'figma.drag': z.object({ lease, from: pointSchema, to: pointSchema, expectation }).strict(),
  'figma.paste_html': z.object({ lease, html: z.string().max(64 * 1024), target: locatorSchema.optional(), expectation }).strict(),
  // V1 export is an explicit rendered PNG, not a native Figma node export.
  'figma.export': z.object({ lease, format: z.literal('png'), node: locatorSchema.optional() }).strict(),
  'figma.wait_for': z.object({ lease, predicate: expectationSchema, timeout: z.number().int().min(1).max(20_000).default(10_000) }).strict(),
  'figma.verify': z.object({ lease, expectation: expectationSchema }).strict(),
  // No arbitrary method, expression, parameters, DOM or network return values.
  'figma.cdp': z.object({ lease, command: z.literal('Page.getLayoutMetrics') }).strict(),
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
  'figma.paste_html': 'Dispatch offline HTML clipboard data. Native Figma insertion is not guaranteed.',
  'figma.export': 'Capture a rendered PNG viewport or accessible element. This is not a native node export.',
  'figma.wait_for': 'Wait for a bounded typed visible or saved-state predicate.',
  'figma.verify': 'Record a receipt for an observed typed postcondition, or mark it unverified.',
  'figma.cdp': 'Read numeric page layout metrics only. Runtime evaluation and all other CDP commands are disabled.',
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
