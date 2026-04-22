"""Commands

Register commands that users can discover and trigger from a command palette.

Press **Ctrl/Cmd+K** to open the palette, then search for commands by name.
(**Ctrl/Cmd+Shift+P** also works on browsers that don't reserve it, e.g.
everything except Firefox.) Commands can also be bound to keyboard hotkeys.

**Key methods:**

* :meth:`viser.GuiApi.add_command` to register a named command
* :meth:`viser.CommandHandle.on_trigger` to attach a callback
* :meth:`viser.CommandHandle.remove` to unregister a command

**Features demonstrated:**

* Registering commands with labels, descriptions, icons, and hotkeys
* Fuzzy search filtering in the palette
* Dynamic command updates (label, description, icon changes)
* Removing commands at runtime
"""

import time

import viser


def main() -> None:
    server = viser.ViserServer()

    # Basic command.
    hello_cmd = server.gui.add_command(
        "Say Hello",
        description="Show a greeting notification",
        icon=viser.Icon.MESSAGE,
    )

    @hello_cmd.on_trigger
    def _(event: viser.CommandEvent) -> None:
        assert event.client is not None
        event.client.add_notification(
            title="Hello!",
            body="You triggered the Say Hello command.",
            color="teal",
        )

    # Command with a hotkey.
    reset_cmd = server.gui.add_command(
        "Reset Camera",
        description="Move the camera back to the default view",
        hotkey=("mod", "shift", "R"),
        icon=viser.Icon.REFRESH,
    )

    @reset_cmd.on_trigger
    def _(event: viser.CommandEvent) -> None:
        assert event.client is not None
        event.client.camera.position = (3.0, 3.0, 3.0)
        event.client.camera.look_at = (0.0, 0.0, 0.0)
        event.client.add_notification(
            title="Camera Reset",
            body="Camera position has been reset.",
            color="blue",
        )

    # Toggle command (changes label/icon on each trigger).
    grid_visible = True
    grid_handle = server.scene.add_grid("/grid", width=10.0, height=10.0)

    toggle_cmd = server.gui.add_command(
        "Hide Grid",
        description="Toggle grid visibility",
        icon=viser.Icon.EYE_OFF,
    )

    @toggle_cmd.on_trigger
    def _(event: viser.CommandEvent) -> None:
        nonlocal grid_visible
        grid_visible = not grid_visible
        grid_handle.visible = grid_visible

        if grid_visible:
            toggle_cmd.label = "Hide Grid"
            toggle_cmd.icon = viser.Icon.EYE_OFF
        else:
            toggle_cmd.label = "Show Grid"
            toggle_cmd.icon = viser.Icon.EYE

    # Removable command.
    counter = 0
    removable_cmd = server.gui.add_command(
        "Self-Destruct",
        description="This command removes itself after being triggered",
        icon=viser.Icon.BOMB,
    )

    @removable_cmd.on_trigger
    def _(event: viser.CommandEvent) -> None:
        nonlocal counter
        counter += 1
        assert event.client is not None
        event.client.add_notification(
            title="Boom!",
            body=f"Triggered {counter} time(s). Removing command...",
            color="red",
        )
        removable_cmd.remove()

    server.scene.add_frame("/frame", show_axes=True, axes_length=2.0)
    toggle_cmd_disabled = server.gui.add_button("Toggle grid command disabled")

    @toggle_cmd_disabled.on_click
    def _(_) -> None:
        toggle_cmd.disabled = not toggle_cmd.disabled

    while True:
        time.sleep(1.0)


if __name__ == "__main__":
    main()
