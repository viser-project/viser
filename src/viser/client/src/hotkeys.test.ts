import { describe, it, expect } from "vitest";
import { eventMatchesHotkey, hotkeyFromEvent } from "./hotkeys";

function ev(
  key: string,
  code: string,
  mods: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

describe("hotkeyFromEvent", () => {
  it("resolves letters by typed character, case-insensitively", () => {
    expect(hotkeyFromEvent(ev("w", "KeyW"))).toBe("W");
    expect(hotkeyFromEvent(ev("W", "KeyW"))).toBe("W");
    // AZERTY: the key labeled A sits at the US "Q" position.
    expect(hotkeyFromEvent(ev("a", "KeyQ"))).toBe("A");
    // AZERTY: the key labeled M sits at the US ";" position.
    expect(hotkeyFromEvent(ev("m", "Semicolon"))).toBe("M");
  });

  it("falls back to the physical key for non-Latin letter output", () => {
    // macOS Option+A types "å".
    expect(hotkeyFromEvent(ev("å", "KeyA"))).toBe("A");
    // macOS Option+E is a dead key.
    expect(hotkeyFromEvent(ev("Dead", "KeyE"))).toBe("E");
    // Cyrillic layout.
    expect(hotkeyFromEvent(ev("ф", "KeyA"))).toBe("A");
  });

  it("doesn't double-bind a letter key that types ASCII punctuation", () => {
    // AZERTY: the US "M" position types ","; the real "m" key binds M.
    expect(hotkeyFromEvent(ev(",", "KeyM"))).toBeNull();
  });

  it("resolves digits physically, regardless of shift", () => {
    expect(hotkeyFromEvent(ev("1", "Digit1"))).toBe("1");
    expect(hotkeyFromEvent(ev("!", "Digit1"))).toBe("1");
    expect(hotkeyFromEvent(ev(")", "Digit0"))).toBe("0");
    // AZERTY's unshifted digit row types symbols.
    expect(hotkeyFromEvent(ev("&", "Digit1"))).toBe("1");
    expect(hotkeyFromEvent(ev("5", "Numpad5"))).toBe("5");
  });

  it("resolves punctuation physically", () => {
    expect(hotkeyFromEvent(ev("[", "BracketLeft"))).toBe("[");
    expect(hotkeyFromEvent(ev("{", "BracketLeft"))).toBe("[");
    expect(hotkeyFromEvent(ev("]", "BracketRight"))).toBe("]");
    expect(hotkeyFromEvent(ev("-", "Minus"))).toBe("-");
    expect(hotkeyFromEvent(ev("_", "Minus"))).toBe("-");
    expect(hotkeyFromEvent(ev("=", "Equal"))).toBe("=");
    expect(hotkeyFromEvent(ev("+", "Equal"))).toBe("=");
    expect(hotkeyFromEvent(ev("\\", "Backslash"))).toBe("\\");
  });

  it("resolves named keys and function keys", () => {
    expect(hotkeyFromEvent(ev("F6", "F6"))).toBe("F6");
    expect(hotkeyFromEvent(ev("F12", "F12"))).toBe("F12");
    expect(hotkeyFromEvent(ev("ArrowLeft", "ArrowLeft"))).toBe("arrowleft");
    expect(hotkeyFromEvent(ev(" ", "Space"))).toBe("space");
    expect(hotkeyFromEvent(ev("Enter", "NumpadEnter"))).toBe("enter");
    expect(hotkeyFromEvent(ev("Escape", "Escape"))).toBe("escape");
  });

  it("returns null for bare modifiers and unknown keys", () => {
    expect(hotkeyFromEvent(ev("Shift", "ShiftLeft"))).toBeNull();
    expect(hotkeyFromEvent(ev("Meta", "MetaLeft"))).toBeNull();
    expect(hotkeyFromEvent(ev("CapsLock", "CapsLock"))).toBeNull();
  });
});

describe("eventMatchesHotkey", () => {
  it("matches shift+digit even though the typed character is a symbol", () => {
    const e = ev("!", "Digit1", { shiftKey: true });
    expect(eventMatchesHotkey(e, "1", "shift")).toBe(true);
    expect(eventMatchesHotkey(e, "1", null)).toBe(false);
  });

  it("matches macOS Option+letter", () => {
    expect(
      eventMatchesHotkey(ev("å", "KeyA", { altKey: true }), "A", "alt"),
    ).toBe(true);
  });

  it("requires an exact modifier match", () => {
    expect(eventMatchesHotkey(ev("w", "KeyW"), "W", null)).toBe(true);
    expect(
      eventMatchesHotkey(ev("W", "KeyW", { shiftKey: true }), "W", null),
    ).toBe(false);
    expect(
      eventMatchesHotkey(
        ev("k", "KeyK", { metaKey: true, shiftKey: true }),
        "K",
        "cmd/ctrl",
      ),
    ).toBe(false);
  });

  it("treats Cmd and Ctrl as the same cmd/ctrl modifier", () => {
    expect(
      eventMatchesHotkey(ev("k", "KeyK", { metaKey: true }), "K", "cmd/ctrl"),
    ).toBe(true);
    expect(
      eventMatchesHotkey(ev("k", "KeyK", { ctrlKey: true }), "K", "cmd/ctrl"),
    ).toBe(true);
  });
});
