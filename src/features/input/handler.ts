import type { Core } from '../../extension/background/core.ts';
import { clickablePoint, type ClickPoint } from '../../extension/background/geometry.ts';
import type { RefEntry } from '../../extension/background/refs.ts';
import type { CallContext, Feature } from '../../extension/background/types.ts';
import { ToolError, sleep } from '../../extension/background/util.ts';
import { MODIFIER_BITS, editingCommand, keyDef } from './keys.ts';

type Button = 'left' | 'right' | 'middle';

function modifierMask(mods?: string[]): number {
  return (mods ?? []).reduce((m, k) => m | (MODIFIER_BITS[k] ?? 0), 0);
}

/** Input commands may block until a dialog they opened is closed, so stop waiting once one opens. */
async function send(core: Core, tabId: number, method: string, params: Record<string, unknown>): Promise<void> {
  if (core.life.dialog(tabId)) return;
  await core.life.raceDialog(tabId, core.cdp.send(tabId, method, params));
}

/** True when the tab is in the background (another tab is shown, or the window is minimized). */
async function pageHidden(core: Core, tabId: number): Promise<boolean> {
  return core.page.evaluate<string>(tabId, () => document.visibilityState).then((v) => v === 'hidden', () => false);
}

/**
 * Hidden tabs only deliver mouse moves with the next frame, which never comes, so the CDP call waits ~5 s.
 * There the move is sent without waiting: the press or release that follows flushes it, in order.
 */
function moveMouse(core: Core, tabId: number, params: Record<string, unknown>, hidden: boolean): Promise<void> {
  const sent = send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...params });
  if (!hidden) return sent;
  sent.catch(() => {});
  return Promise.resolve();
}

function describeTarget(entry: RefEntry | undefined, point: ClickPoint): string {
  const what = entry ? `${entry.role ?? 'element'}${entry.name ? ` "${entry.name.slice(0, 60)}"` : ''} [${entry.ref}]` : 'point';
  return `${what} at (${Math.round(point.x)},${Math.round(point.y)})`;
}

async function pointFor(core: Core, ctx: CallContext, args: { ref?: string; x?: number; y?: number }): Promise<{ point: ClickPoint; entry?: RefEntry }> {
  if (core.life.dialog(ctx.tabId)) throw new ToolError(`A ${core.life.dialog(ctx.tabId)!.type} dialog is open ("${core.life.dialog(ctx.tabId)!.message}"). Use the dialog tool first.`);
  if (args.ref) {
    const entry = core.refs.get(ctx.tabId, args.ref);
    return { point: await clickablePoint(core.cdp, entry), entry };
  }
  if (typeof args.x === 'number' && typeof args.y === 'number') return { point: { x: args.x, y: args.y } };
  throw new ToolError('Give a ref, or both x and y.');
}

/**
 * Moves the mouse onto the element and re-measures it until it stops moving:
 * hover effects (tooltips, menus closing on mouseleave) often shift the layout
 * between measuring and pressing, which would make the click miss.
 */
async function settlePoint(core: Core, tabId: number, entry: RefEntry, point: ClickPoint, hidden: boolean): Promise<ClickPoint> {
  if (hidden) return point; // nothing moves before the press flushes the hover
  let current = point;
  for (let attempt = 0; attempt < 4; attempt++) {
    await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: current.x, y: current.y });
    await sleep(60);
    const next = await clickablePoint(core.cdp, entry);
    if (Math.abs(next.x - current.x) < 2 && Math.abs(next.y - current.y) < 2) return next;
    current = next;
  }
  return current;
}

async function mouseClick(core: Core, tabId: number, x: number, y: number, hidden: boolean, button: Button = 'left', clickCount = 1, modifiers = 0): Promise<void> {
  await moveMouse(core, tabId, { x, y, modifiers }, hidden);
  for (let i = 1; i <= clickCount; i++) {
    await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
    await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
  }
}

async function pressCombo(core: Core, tabId: number, combo: string): Promise<void> {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (combo.endsWith('++')) parts.push('+');
  const keyName = parts.pop();
  if (!keyName) throw new ToolError(`Cannot parse keys "${combo}".`);
  let modifiers = 0;
  const held: string[] = [];
  for (const m of parts) {
    const def = keyDef(m);
    const bit = def ? MODIFIER_BITS[def.key] : undefined;
    if (!def || bit === undefined) throw new ToolError(`"${m}" is not a modifier key (use Control, Shift, Alt, Meta).`);
    modifiers |= bit;
    held.push(def.key);
    await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers, location: def.location });
  }
  const def = keyDef(keyName);
  if (!def) throw new ToolError(`Unknown key "${keyName}".`);
  const shifted = modifiers & MODIFIER_BITS.Shift! && def.shiftKey ? def.shiftKey : undefined;
  const key = shifted ?? def.key;
  const printable = !(modifiers & (MODIFIER_BITS.Control! | MODIFIER_BITS.Alt! | MODIFIER_BITS.Meta!));
  const text = printable ? (shifted ?? def.text) : undefined;
  const commands = editingCommand(modifiers, def.key);
  await send(core, tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    text,
    unmodifiedText: text,
    modifiers,
    location: def.location,
    ...(commands ? { commands } : {}),
  });
  await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers, location: def.location });
  for (const k of held.reverse()) {
    const d = keyDef(k)!;
    modifiers &= ~(MODIFIER_BITS[d.key] ?? 0);
    await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers, location: d.location });
  }
}

/** Longer text is inserted in one go, like a paste: key by key it would take seconds. */
const KEY_BY_KEY_MAX = 200;

async function typeKeys(core: Core, tabId: number, text: string, pauseMs: number): Promise<void> {
  for (const ch of text) {
    if (ch === '\n') {
      // A line break, not the Enter key: Enter would submit forms or send chat messages (that is what submit is for).
      await send(core, tabId, 'Input.insertText', { text: '\n' });
      continue;
    }
    const def = keyDef(ch);
    if (def && def.text === ch) {
      await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, text: ch, unmodifiedText: ch });
      await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode });
    } else if (def?.shiftKey === ch || (def && /[A-Z]/.test(ch))) {
      await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode, text: ch, unmodifiedText: ch, modifiers: MODIFIER_BITS.Shift });
      await send(core, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: MODIFIER_BITS.Shift });
    } else {
      // Characters without a US key (accents, emoji, CJK) are committed like an IME would.
      await send(core, tabId, 'Input.insertText', { text: ch });
    }
    if (pauseMs) await sleep(pauseMs);
  }
}

/** Page function: element facts needed to fill it the right way. */
function elementKind(this: Element) {
  const el = this as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') ?? '';
  const type = tag === 'input' ? (el.type || 'text').toLowerCase() : '';
  const checkable = type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox';
  const checked = checkable ? (type ? el.checked : el.getAttribute('aria-checked') === 'true') : undefined;
  return { tag, type, role, checkable, checked, editable: (el as HTMLElement).isContentEditable, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', multiple: !!(el as unknown as HTMLSelectElement).multiple };
}

/** Page function: select the current content so the next keystroke replaces it. */
function selectContent(this: Element): void {
  const el = this as HTMLInputElement;
  el.focus();
  if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    el.select();
    return;
  }
  const sel = getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Page function: put the caret at the end so typing appends instead of inserting where the click landed. */
function caretToEnd(this: Element): void {
  const el = this as HTMLInputElement;
  try {
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.setSelectionRange === 'function') {
      const n = el.value.length;
      el.setSelectionRange(n, n);
      return;
    }
  } catch {
    return; // input types without selection support (email, number) keep the caret where it is
  }
  if ((el as HTMLElement).isContentEditable) {
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

/** Page function: pick <select> options by value or label and fire input/change like a user would. */
function selectOptions(this: Element, values: string[]): string[] {
  const select = this as HTMLSelectElement;
  if (select.tagName !== 'SELECT') throw new Error('The element is not a <select>; click it and pick the option instead.');
  const options = Array.from(select.options);
  const picked: HTMLOptionElement[] = [];
  for (const v of values) {
    const lv = v.trim().toLowerCase();
    const o =
      options.find((x) => x.value === v) ??
      options.find((x) => x.label.trim() === v.trim()) ??
      options.find((x) => x.label.trim().toLowerCase() === lv) ??
      options.find((x) => x.label.toLowerCase().includes(lv));
    if (!o) throw new Error(`No option "${v}". Options: ${options.map((x) => x.label.trim()).join(', ')}`);
    picked.push(o);
  }
  if (!select.multiple && picked.length > 1) throw new Error('This <select> accepts a single option.');
  for (const o of options) o.selected = picked.includes(o);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return picked.map((o) => o.label.trim());
}

function scrollState() {
  return { x: Math.round(scrollX), y: Math.round(scrollY), maxY: document.documentElement.scrollHeight - innerHeight };
}

/** What a wheel turn at (x, y) would scroll: the nearest scrollable ancestor of the element there, else the page. */
function scrollAt(x: number, y: number, dx: number, dy: number): void {
  for (let el = document.elementFromPoint(x, y); el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const canY = dy !== 0 && /auto|scroll|overlay/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const canX = dx !== 0 && /auto|scroll|overlay/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (canY || canX) {
      el.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
      return;
    }
  }
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
}

async function focusFor(core: Core, ctx: CallContext, entry: RefEntry, hidden: boolean): Promise<string | undefined> {
  // A real click places the caret and activates custom inputs; fall back to focus() when covered.
  let point = await clickablePoint(core.cdp, entry);
  if (point.coveredBy) {
    await core.cdp.send(ctx.tabId, 'DOM.focus', { backendNodeId: entry.backendNodeId }, entry.sessionId).catch(() => {});
    return point.coveredBy;
  }
  point = await settlePoint(core, ctx.tabId, entry, point, hidden);
  await mouseClick(core, ctx.tabId, point.x, point.y, hidden);
  return undefined;
}

function report(head: string, notes: string[], warnings: string[] = []): string {
  return [head, ...warnings, ...notes].join('\n');
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on', 'checked', 'x']);

export const inputFeature: Feature = {
  name: 'input',
  handlers: {
    async click(args: { ref?: string; x?: number; y?: number; button?: Button; clickCount?: number; modifiers?: string[] }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const found = await pointFor(core, ctx, args);
      const entry = found.entry;
      let point = found.point;
      const hidden = await pageHidden(core, tabId);
      const { notes } = await core.observeAction(ctx, async () => {
        if (entry) point = await settlePoint(core, tabId, entry, point, hidden);
        await mouseClick(core, tabId, point.x, point.y, hidden, args.button ?? 'left', args.clickCount ?? 1, modifierMask(args.modifiers));
      });
      const warnings = point.coveredBy ? [`Warning: ${point.coveredBy} covers the element at that point, so the click may have hit it instead.`] : [];
      return report(`${args.clickCount === 2 ? 'Double-clicked' : 'Clicked'} ${describeTarget(entry, point)}.`, notes, warnings);
    },

    async hover(args: { ref?: string; x?: number; y?: number }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const { point, entry } = await pointFor(core, ctx, args);
      await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await sleep(200, ctx.signal);
      return `Hovering over ${describeTarget(entry, point)}.`;
    },

    async type(args: { ref?: string; text: string; clear?: boolean; submit?: boolean; slowly?: boolean }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      if (core.life.dialog(tabId)) throw new ToolError('A dialog is open; use the dialog tool first.');
      const warnings: string[] = [];
      let entry: RefEntry | undefined;
      if (args.ref) {
        entry = core.refs.get(tabId, args.ref);
        const kind = await core.page.callOn<ReturnType<typeof elementKind>>(entry, elementKind);
        if (kind.disabled) warnings.push('Warning: the element is disabled.');
        if (kind.type === 'file') throw new ToolError('This is a file input; use upload_file.');
        const covered = await focusFor(core, ctx, entry, await pageHidden(core, tabId));
        if (covered) warnings.push(`Note: ${covered} covers the element, so it was focused programmatically.`);
        if (!args.clear) {
          await core.page.callOn(entry, caretToEnd);
          // input types like email/number expose no selection API: End moves the caret there.
          if (kind.tag === 'input' && ['email', 'number', 'url', 'tel', 'search', 'text', 'password', ''].includes(kind.type)) await pressCombo(core, tabId, 'End');
        }
      }
      const { notes } = await core.observeAction(ctx, async () => {
        if (args.clear) {
          if (entry) await core.page.callOn(entry, selectContent);
          else await pressCombo(core, tabId, 'Control+A');
          await pressCombo(core, tabId, 'Backspace');
        }
        if (args.slowly) await typeKeys(core, tabId, args.text, 15);
        else if (args.text.length <= KEY_BY_KEY_MAX) await typeKeys(core, tabId, args.text, 0);
        else await send(core, tabId, 'Input.insertText', { text: args.text });
        if (args.submit) await pressCombo(core, tabId, 'Enter');
      });
      const target = entry ? `${entry.role ?? 'element'}${entry.name ? ` "${entry.name.slice(0, 60)}"` : ''} [${entry.ref}]` : 'the focused element';
      const how = args.slowly || args.text.length <= KEY_BY_KEY_MAX ? 'key by key' : `in one go like a paste (longer than ${KEY_BY_KEY_MAX} characters)`;
      return report(`Typed ${args.text.length} characters ${how} into ${target}${args.submit ? ' and pressed Enter' : ''}.`, notes, warnings);
    },

    async press_key(args: { keys: string; repeat?: number }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const { notes } = await core.observeAction(ctx, async () => {
        for (let i = 0; i < (args.repeat ?? 1); i++) await pressCombo(core, tabId, args.keys);
      });
      return report(`Pressed ${args.keys}${(args.repeat ?? 1) > 1 ? ` ×${args.repeat}` : ''}.`, notes);
    },

    async fill_form(args: { fields: Array<{ ref: string; value: string }> }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const done: string[] = [];
      const hidden = await pageHidden(core, tabId);
      const { notes } = await core.observeAction(ctx, async () => {
        for (const field of args.fields) {
          const entry = core.refs.get(tabId, field.ref);
          const kind = await core.page.callOn<ReturnType<typeof elementKind>>(entry, elementKind);
          const label = `${entry.role ?? kind.tag}${entry.name ? ` "${entry.name.slice(0, 40)}"` : ''} [${entry.ref}]`;
          if (kind.type === 'file') throw new ToolError(`${label} is a file input; use upload_file.`);
          if (kind.tag === 'select') {
            const picked = await core.page.callOn<string[]>(entry, selectOptions, [kind.multiple ? field.value.split(',').map((s) => s.trim()) : [field.value]]);
            done.push(`${label} = ${picked.join(', ')}`);
          } else if (kind.checkable) {
            const want = TRUE_VALUES.has(field.value.trim().toLowerCase());
            if (kind.checked !== want) {
              const point = await clickablePoint(core.cdp, entry);
              await mouseClick(core, tabId, point.x, point.y, hidden);
            }
            const after = await core.page.callOn<ReturnType<typeof elementKind>>(entry, elementKind);
            done.push(`${label} ${after.checked ? 'checked' : 'unchecked'}${after.checked !== want ? ' (did not change!)' : ''}`);
          } else {
            await focusFor(core, ctx, entry, hidden);
            await core.page.callOn(entry, selectContent);
            await pressCombo(core, tabId, 'Backspace');
            if (field.value) await send(core, tabId, 'Input.insertText', { text: field.value });
            done.push(`${label} = ${JSON.stringify(field.value.length > 40 ? `${field.value.slice(0, 39)}…` : field.value)}`);
          }
        }
      });
      return report(`Filled ${done.length} field${done.length === 1 ? '' : 's'}:\n${done.map((d) => `- ${d}`).join('\n')}`, notes);
    },

    async select_option(args: { ref: string; values: string[] }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const entry = core.refs.get(tabId, args.ref);
      const { value, notes } = await core.observeAction(ctx, () => core.page.callOn<string[]>(entry, selectOptions, [args.values]));
      return report(`Selected ${value.map((v) => JSON.stringify(v)).join(', ')} in [${entry.ref}].`, notes);
    },

    async scroll(args: { ref?: string; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; x?: number; y?: number; toEdge?: 'top' | 'bottom' }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      let how = '';
      if (args.ref) {
        const entry = core.refs.get(tabId, args.ref);
        await core.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, entry.sessionId);
      } else if (args.toEdge) {
        await core.page.evaluate(tabId, (edge: string) => window.scrollTo({ top: edge === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior }), [args.toEdge]);
      } else {
        const { cssLayoutViewport: vp } = await core.cdp.send(tabId, 'Page.getLayoutMetrics');
        const dir = args.direction ?? 'down';
        const amount = args.amount ?? Math.round((dir === 'up' || dir === 'down' ? vp.clientHeight : vp.clientWidth) * 0.8);
        const deltaX = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
        const deltaY = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
        const x = args.x ?? vp.clientWidth / 2;
        const y = args.y ?? vp.clientHeight / 2;
        if (await pageHidden(core, tabId)) {
          // Background tabs never process wheel events (the CDP call would hang): scroll what the wheel would have.
          await core.page.evaluate(tabId, scrollAt, [x, y, deltaX, deltaY]);
          how = ' The tab is in the background, where Chrome ignores mouse-wheel events, so it was scrolled with script.';
        } else await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
      }
      await sleep(250, ctx.signal);
      const s = await core.page.evaluate<ReturnType<typeof scrollState>>(tabId, scrollState);
      return `Scrolled. Page scroll position is now ${s.x},${s.y} (max ${Math.max(0, s.maxY)}).${how}`;
    },

    async drag(args: { fromRef?: string; toRef?: string; from?: { x: number; y: number }; to?: { x: number; y: number } }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const start = args.fromRef ? await clickablePoint(core.cdp, core.refs.get(tabId, args.fromRef)) : args.from;
      if (!start) throw new ToolError('Give fromRef or from.');
      const end = args.toRef ? await clickablePoint(core.cdp, core.refs.get(tabId, args.toRef)) : args.to;
      if (!end) throw new ToolError('Give toRef or to.');
      let dragData: unknown;
      const off = core.cdp.on((t, _s, method, params) => {
        if (t === tabId && method === 'Input.dragIntercepted') dragData = params.data;
      });
      let mode = 'mouse';
      const { notes } = await core.observeAction(ctx, async () => {
        await core.cdp.send(tabId, 'Input.setInterceptDrags', { enabled: true });
        try {
          await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
          await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
          const steps = 8;
          for (let i = 1; i <= steps; i++) {
            const x = start.x + ((end.x - start.x) * i) / steps;
            const y = start.y + ((end.y - start.y) * i) / steps;
            await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
            if (dragData) break;
          }
          if (dragData) {
            mode = 'HTML5';
            for (const type of ['dragEnter', 'dragOver', 'drop']) await core.cdp.send(tabId, 'Input.dispatchDragEvent', { type, x: end.x, y: end.y, data: dragData });
          } else {
            await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1 });
          }
          await send(core, tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 });
        } finally {
          off();
          await core.cdp.send(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
        }
      });
      return report(`Dragged from (${Math.round(start.x)},${Math.round(start.y)}) to (${Math.round(end.x)},${Math.round(end.y)}) using ${mode} drag events.`, notes);
    },

    async upload_file(args: { ref: string; paths: string[] }, ctx) {
      const { core, tabId } = ctx;
      await core.cdp.ensure(tabId);
      const entry = core.refs.get(tabId, args.ref);
      const kind = await core.page.callOn<ReturnType<typeof elementKind>>(entry, elementKind);
      if (kind.type !== 'file') throw new ToolError(`[${entry.ref}] is not an <input type="file"> (it is <${kind.tag}${kind.type ? ` type=${kind.type}` : ''}>). Find the file input with find(selector="input[type=file]").`);
      const { notes } = await core.observeAction(ctx, () => core.cdp.send(tabId, 'DOM.setFileInputFiles', { files: args.paths, backendNodeId: entry.backendNodeId }, entry.sessionId));
      const names = await core.page.callOn<string[]>(entry, function (this: HTMLInputElement) {
        return Array.from(this.files ?? []).map((f) => `${f.name} (${f.size} bytes)`);
      });
      return report(`Attached ${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`, notes);
    },

    async dialog(args: { action: 'accept' | 'dismiss'; promptText?: string }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      const open = core.life.dialog(tabId);
      if (!open) throw new ToolError('No JavaScript dialog is open in this tab.');
      await core.cdp.send(tabId, 'Page.handleJavaScriptDialog', { accept: args.action === 'accept', promptText: args.promptText });
      return `${args.action === 'accept' ? 'Accepted' : 'Dismissed'} the ${open.type} dialog "${open.message}"${args.promptText !== undefined ? ` with text ${JSON.stringify(args.promptText)}` : ''}.`;
    },
  },
};
