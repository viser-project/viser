"""E2E coverage for the focus-aware ``heldModifier`` gate.

The CursorController's ``heldModifier`` is fed by window-level
``keydown`` / ``keyup`` listeners in ``App.tsx``. Without filtering,
a Shift press inside a focused Mantine ``<TextInput>`` would flip
the canvas cursor to pointer mid-typing whenever a click filter is
registered.

These tests assert the gate is honoured: keydowns dispatched while a
form control is focused (or whose target is a form control) do NOT
update the cursor controller's ``heldModifier``.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser


def test_keydown_with_input_target_is_ignored(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A keydown whose ``target`` is an ``<input>`` should not update
    the cursor controller's held modifier, even if dispatched on
    ``window`` (the listener is window-level)."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cursorController;
            // Reset to a known state.
            owner.setHeldModifier(null);
            const input = document.createElement("input");
            document.body.appendChild(input);
            input.focus();
            try {
                window.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Shift",
                    shiftKey: true,
                    bubbles: true,
                    target: input,
                }));
                // Shift press while input is focused: the gate should
                // skip this update.
                return owner.derive();
            } finally {
                input.remove();
            }
        }
        """
    )
    # No registered click filter, no hover, no held modifier => "auto".
    assert out == "auto"


def test_keydown_outside_form_control_updates_modifier(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Keydowns dispatched while no form control is focused must
    still update the controller, otherwise the cursor never reflects
    held modifiers at all. With a click filter registered for shift,
    pressing shift should flip ``derive()`` to ``"pointer"``."""

    @viser_server.scene.on_click(modifier="shift")
    def _(event: viser.SceneClickEvent) -> None:
        del event

    viser_page.wait_for_timeout(300)
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cursorController;
            owner.setHeldModifier(null);
            // Make sure no form control is focused; clicking the
            // canvas dispatches focus there but our keydown is
            // dispatched directly on window, with no element target.
            document.body.focus();
            const before = owner.derive();
            window.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Shift",
                shiftKey: true,
                bubbles: true,
            }));
            const after = owner.derive();
            return { before, after };
        }
        """
    )
    # Before: no modifier held; shift-only filter doesn't match null;
    # rect-select isn't registered -> "auto".
    assert out["before"] == "auto"
    # After shift press: filter matches shift -> "pointer".
    assert out["after"] == "pointer"


def test_focused_textarea_blocks_modifier_update(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Same gate but for a ``<textarea>`` (Mantine multiline input
    renders as one). The gate also checks ``document.activeElement``,
    so a keydown without an explicit target still bypasses the
    update when a form control has focus."""

    @viser_server.scene.on_click(modifier="shift")
    def _(event: viser.SceneClickEvent) -> None:
        del event

    viser_page.wait_for_timeout(300)
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cursorController;
            owner.setHeldModifier(null);
            const textarea = document.createElement("textarea");
            document.body.appendChild(textarea);
            textarea.focus();
            try {
                // Dispatch on window with no target -- gate should
                // still skip via document.activeElement check.
                window.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Shift",
                    shiftKey: true,
                    bubbles: true,
                }));
                return owner.derive();
            } finally {
                textarea.remove();
            }
        }
        """
    )
    # Modifier wasn't updated; shift-only filter doesn't match null
    # -> "auto".
    assert out == "auto"
