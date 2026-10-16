/** US keyboard definitions for CDP Input.dispatchKeyEvent. */
export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shiftKey?: string;
  location?: number;
}

const DEFS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
};
for (let i = 1; i <= 12; i++) DEFS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = lower.toUpperCase();
  DEFS[lower] = { key: lower, code: `Key${upper}`, keyCode: 65 + i, text: lower, shiftKey: upper };
  DEFS[upper] = { key: upper, code: `Key${upper}`, keyCode: 65 + i, text: upper };
}
const DIGIT_SHIFT = ')!@#$%^&*(';
for (let i = 0; i < 10; i++) DEFS[String(i)] = { key: String(i), code: `Digit${i}`, keyCode: 48 + i, text: String(i), shiftKey: DIGIT_SHIFT[i] };
const PUNCT: Array<[string, string, number, string]> = [
  ['-', 'Minus', 189, '_'], ['=', 'Equal', 187, '+'], ['[', 'BracketLeft', 219, '{'], [']', 'BracketRight', 221, '}'], ['\\', 'Backslash', 220, '|'],
  [';', 'Semicolon', 186, ':'], ["'", 'Quote', 222, '"'], [',', 'Comma', 188, '<'], ['.', 'Period', 190, '>'], ['/', 'Slash', 191, '?'], ['`', 'Backquote', 192, '~'],
];
for (const [key, code, keyCode, shifted] of PUNCT) DEFS[key] = { key, code, keyCode, text: key, shiftKey: shifted };

const ALIASES: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', super: 'Meta', option: 'Alt', alt: 'Alt',
  shift: 'Shift', esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', del: 'Delete', delete: 'Delete', backspace: 'Backspace',
  space: 'Space', ' ': 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', tab: 'Tab',
  home: 'Home', end: 'End', insert: 'Insert', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown',
};

export const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function keyDef(name: string): KeyDef | undefined {
  if (DEFS[name]) return DEFS[name];
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return DEFS[alias];
  return DEFS[name.toLowerCase()] ?? Object.values(DEFS).find((d) => d.key.toLowerCase() === name.toLowerCase());
}

/** Editing commands Chrome needs explicitly for shortcuts to act like on a real keyboard. */
export function editingCommand(modifiers: number, key: string): string[] | undefined {
  if (!(modifiers & (MODIFIER_BITS.Control! | MODIFIER_BITS.Meta!))) return undefined;
  const k = key.toLowerCase();
  if (k === 'a') return ['selectAll'];
  if (k === 'c') return ['copy'];
  if (k === 'x') return ['cut'];
  if (k === 'v') return ['paste'];
  if (k === 'z') return modifiers & MODIFIER_BITS.Shift! ? ['redo'] : ['undo'];
  if (k === 'y') return ['redo'];
  return undefined;
}
