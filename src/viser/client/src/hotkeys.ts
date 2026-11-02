/** Keyboard-event -> ``HotkeyKey`` resolution for command hotkeys.
 *
 * Split from ``CommandPalette.tsx`` so it can be unit-tested and so the
 * Fast Refresh module boundary only contains components.
 *
 * Matching rules (mirrors the ``HotkeyKey`` docstring in
 * ``src/viser/_messages.py``):
 *
 * - **Letters** match the *typed* character, so they follow the user's
 *   layout (``"W"`` is the key labeled W on AZERTY/Dvorak too).
 * - **Named keys** (arrows, Enter, F1-F12 as ``"f1"``-``"f12"``, ...) match
 *   ``event.key``.
 * - Everything else -- **digits and punctuation** -- matches the
 *   *physical* key (``event.code``) at that position on a US layout. The
 *   typed character for these depends on held modifiers (Shift+1 types
 *   ``"!"``, Option+letter on macOS types ``"å"``), so comparing characters
 *   would make modifier combos unmatchable.
 * - Letters fall back to the physical key when the typed character isn't a
 *   plain Latin letter or ASCII punctuation (Option+A types ``"å"``; a dead
 *   key reports ``"Dead"``; a Cyrillic layout types ``"ф"``).
 */

import { RegisterCommandMessage } from "./WebsocketMessages";
import { KeyModifier, keyModifierFromEvent } from "./dragUtils";

export type HotkeyKey = NonNullable<RegisterCommandMessage["props"]["hotkey"]>;

const NAMED_KEYS: { [key: string]: HotkeyKey } = {
  " ": "space",
  Enter: "enter",
  Escape: "escape",
  Esc: "escape",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
};

const PHYSICAL_KEYS: { [code: string]: HotkeyKey } = {
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  Space: "space",
  NumpadEnter: "enter",
};
for (let i = 0; i <= 9; i++) {
  const digit = String(i) as HotkeyKey;
  PHYSICAL_KEYS[`Digit${i}`] = digit;
  PHYSICAL_KEYS[`Numpad${i}`] = digit;
}
for (let c = 65; c <= 90; c++) {
  const letter = String.fromCharCode(c) as HotkeyKey;
  PHYSICAL_KEYS[`Key${letter}`] = letter;
}

/** Resolve the ``HotkeyKey`` a keyboard event corresponds to, or ``null``
 * if it isn't a bindable key (e.g. a bare modifier press). */
export function hotkeyFromEvent(event: {
  key: string;
  code: string;
}): HotkeyKey | null {
  const { key, code } = event;
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
    return key.toUpperCase() as HotkeyKey;
  }
  const named = NAMED_KEYS[key];
  if (named !== undefined) return named;
  const physical = PHYSICAL_KEYS[code];
  if (physical === undefined) return null;
  // A letter key that types printable ASCII punctuation belongs to a
  // non-US layout (AZERTY's "M" position types ","). The layout's real
  // letter key already resolves via the typed character above, so falling
  // back here would bind one letter to two keys.
  if (code.startsWith("Key") && /^[\x21-\x7e]$/.test(key)) return null;
  return physical;
}

/** True when ``event`` triggers a hotkey bound to ``key`` + ``modifier``.
 * Modifier matching is exact (listed modifiers held, others not), with
 * Cmd and Ctrl collapsed to ``"cmd/ctrl"`` -- same semantics as drag and
 * click bindings. */
export function eventMatchesHotkey(
  event: {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  key: HotkeyKey,
  modifier: KeyModifier | null,
): boolean {
  return (
    hotkeyFromEvent(event) === key && keyModifierFromEvent(event) === modifier
  );
}
