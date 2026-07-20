"""E2E coverage for the focus-aware held-modifier gate.

The canvas cursor reflects modifier state for registered click filters.
Without filtering, a Shift press inside a focused Mantine `<TextInput>`
would flip the canvas cursor to "pointer" mid-typing. The keydown
listener in `App.tsx` checks both the event's target *and*
`document.activeElement` and skips the update when either is a form
control.

These tests assert the observable behavior: `canvas.style.cursor`.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser


def test_keydown_with_input_target_is_ignored(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A keydown whose ``target`` is an ``<input>`` must not update the
    held modifier. Without a registered click filter the cursor stays
    "auto" regardless; this test asserts the filter-active case below."""

    @viser_server.scene.on_click(modifier="shift")
    def _(event: viser.SceneClickEvent) -> None:
        del event

    # Wait for the click-filter BINDING to reach the client, not just for the
    # pointer API to exist (it exists from page load): the assertions below
    # depend on the registered filter, and evaluating before the server->
    # client binding message lands made this flake by machine timing.
    viser_page.wait_for_function(
        "() => window.__viserPointer != null"
        " && window.__viserPointer.hasSceneClickFilter()",
        timeout=10_000,
    )
    out = viser_page.evaluate(
        """
        () => {
            window.__viserPointer.setHeldModifier(null);
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
                return window.__viserMutable.canvas.style.cursor || "auto";
            } finally {
                input.remove();
            }
        }
        """
    )
    # Shift press while input is focused: held modifier stays null,
    # shift-only filter doesn't match, cursor stays "auto".
    assert out == "auto"


def test_keydown_outside_form_control_updates_modifier(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Keydowns outside form controls must update held modifier. With
    a shift-filtered click registered, pressing shift flips the cursor
    to "pointer"."""

    @viser_server.scene.on_click(modifier="shift")
    def _(event: viser.SceneClickEvent) -> None:
        del event

    # Wait for the click-filter BINDING to reach the client, not just for the
    # pointer API to exist (it exists from page load): the assertions below
    # depend on the registered filter, and evaluating before the server->
    # client binding message lands made this flake by machine timing.
    viser_page.wait_for_function(
        "() => window.__viserPointer != null"
        " && window.__viserPointer.hasSceneClickFilter()",
        timeout=10_000,
    )
    out = viser_page.evaluate(
        """
        () => {
            window.__viserPointer.setHeldModifier(null);
            document.body.focus();
            const canvas = window.__viserMutable.canvas;
            const before = canvas.style.cursor || "auto";
            window.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Shift",
                shiftKey: true,
                bubbles: true,
            }));
            const after = canvas.style.cursor || "auto";
            return { before, after };
        }
        """
    )
    assert out["before"] == "auto"
    assert out["after"] == "pointer"


def test_focused_textarea_blocks_modifier_update(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """`<textarea>` is also gated (via the `document.activeElement`
    check on listeners without an explicit target)."""

    @viser_server.scene.on_click(modifier="shift")
    def _(event: viser.SceneClickEvent) -> None:
        del event

    # Wait for the click-filter BINDING to reach the client, not just for the
    # pointer API to exist (it exists from page load): the assertions below
    # depend on the registered filter, and evaluating before the server->
    # client binding message lands made this flake by machine timing.
    viser_page.wait_for_function(
        "() => window.__viserPointer != null"
        " && window.__viserPointer.hasSceneClickFilter()",
        timeout=10_000,
    )
    out = viser_page.evaluate(
        """
        () => {
            window.__viserPointer.setHeldModifier(null);
            const textarea = document.createElement("textarea");
            document.body.appendChild(textarea);
            textarea.focus();
            try {
                window.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Shift",
                    shiftKey: true,
                    bubbles: true,
                }));
                return window.__viserMutable.canvas.style.cursor || "auto";
            } finally {
                textarea.remove();
            }
        }
        """
    )
    assert out == "auto"
