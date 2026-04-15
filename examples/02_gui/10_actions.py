"""Actions

Register actions that users can discover and trigger from a command palette.

Press **Ctrl+K** (or **Cmd+K** on macOS) to open the palette, then search for
actions by name. Actions can also be bound to keyboard hotkeys.

**Key methods:**

* :meth:`viser.GuiApi.add_action` to register a named action
* :meth:`viser.ActionHandle.on_trigger` to attach a callback
* :meth:`viser.ActionHandle.remove` to unregister an action

**Features demonstrated:**

* Registering actions with labels, descriptions, icons, and hotkeys
* Fuzzy search filtering in the palette
* Dynamic action updates (label, description, icon changes)
* Removing actions at runtime
"""

import time

import viser


def main() -> None:
    server = viser.ViserServer()

    # --- Basic action ---
    hello_action = server.gui.add_action(
        "Say Hello",
        description="Show a greeting notification",
        icon=viser.Icon.MESSAGE,
    )

    @hello_action.on_trigger
    def _(event: viser.ActionEvent) -> None:
        assert event.client is not None
        event.client.add_notification(
            title="Hello!",
            body="You triggered the Say Hello action.",
            color="teal",
        )

    # --- Action with a hotkey ---
    reset_action = server.gui.add_action(
        "Reset Camera",
        description="Move the camera back to the default view",
        hotkey=("mod", "shift", "R"),
        icon=viser.Icon.REFRESH,
    )

    @reset_action.on_trigger
    def _(event: viser.ActionEvent) -> None:
        assert event.client is not None
        event.client.camera.position = (3.0, 3.0, 3.0)
        event.client.camera.look_at = (0.0, 0.0, 0.0)
        event.client.add_notification(
            title="Camera Reset",
            body="Camera position has been reset.",
            color="blue",
        )

    # --- Toggle action (changes label/icon on each trigger) ---
    grid_visible = True
    grid_handle = server.scene.add_grid("/grid", width=10.0, height=10.0)

    toggle_action = server.gui.add_action(
        "Hide Grid",
        description="Toggle grid visibility",
        icon=viser.Icon.EYE_OFF,
    )

    @toggle_action.on_trigger
    def _(event: viser.ActionEvent) -> None:
        nonlocal grid_visible
        grid_visible = not grid_visible
        grid_handle.visible = grid_visible

        if grid_visible:
            toggle_action.label = "Hide Grid"
            toggle_action.icon = viser.Icon.EYE_OFF
        else:
            toggle_action.label = "Show Grid"
            toggle_action.icon = viser.Icon.EYE

    # --- Removable action ---
    counter = 0
    removable = server.gui.add_action(
        "Self-Destruct",
        description="This action removes itself after being triggered",
        icon=viser.Icon.BOMB,
    )

    @removable.on_trigger
    def _(event: viser.ActionEvent) -> None:
        nonlocal counter
        counter += 1
        assert event.client is not None
        event.client.add_notification(
            title="Boom!",
            body=f"Triggered {counter} time(s). Removing action...",
            color="red",
        )
        removable.remove()

    server.scene.add_frame("/frame", show_axes=True, axes_length=2.0)
    toggle_action_disabled = server.gui.add_button("Toggle grid action disabled")

    @toggle_action_disabled.on_click
    def _(_) -> None:
        toggle_action.disabled = not toggle_action.disabled

    while True:
        time.sleep(1.0)


if __name__ == "__main__":
    main()
