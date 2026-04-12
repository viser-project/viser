"""GUI layouts

Organize GUI controls using folders, forms, tabs, and nested structures for better user experience.

**Features:**

* :meth:`viser.GuiApi.add_folder` for grouping related controls
* :meth:`viser.GuiApi.add_form` for groups that commit together on submit
* :meth:`viser.GuiApi.add_tab_group` and :meth:`viser.GuiTabGroupHandle.add_tab` for tabbed interfaces
* Nested folder hierarchies for complex layouts
* Context managers for automatic grouping
"""

import time

import viser


def main() -> None:
    server = viser.ViserServer()

    # Example 1: Organizing with folders
    with server.gui.add_folder("Camera Controls"):
        with server.gui.add_folder("Position"):
            server.gui.add_slider("X", min=-5.0, max=5.0, step=0.1, initial_value=0.0)
            server.gui.add_slider("Y", min=-5.0, max=5.0, step=0.1, initial_value=2.0)
            server.gui.add_slider("Z", min=-5.0, max=5.0, step=0.1, initial_value=3.0)

        with server.gui.add_folder("Rotation"):
            server.gui.add_slider("Pitch", min=-180, max=180, step=1, initial_value=0)
            server.gui.add_slider("Yaw", min=-180, max=180, step=1, initial_value=0)
            server.gui.add_slider("Roll", min=-180, max=180, step=1, initial_value=0)

    # Example 2: Scene objects organization
    with server.gui.add_folder("Scene Objects"):
        with server.gui.add_folder("Lighting"):
            server.gui.add_checkbox("Enable Lighting", initial_value=True)
            server.gui.add_slider(
                "Intensity", min=0.0, max=2.0, step=0.1, initial_value=1.0
            )
            server.gui.add_rgb("Color", initial_value=(255, 255, 255))

        with server.gui.add_folder("Objects"):  # GUI objects folder
            show_axes = server.gui.add_checkbox(
                "Show Coordinate Axes", initial_value=True
            )
            server.gui.add_checkbox("Show Grid", initial_value=False)

            with server.gui.add_folder("Sphere"):
                sphere_radius = server.gui.add_slider(
                    "Radius", min=0.1, max=2.0, step=0.1, initial_value=0.5
                )
                sphere_color = server.gui.add_rgb("Color", initial_value=(255, 0, 0))
                sphere_visible = server.gui.add_checkbox("Visible", initial_value=True)

    # Example 3: Settings and preferences
    with server.gui.add_folder("Settings"):
        with server.gui.add_folder("Display"):
            server.gui.add_rgb("Background", initial_value=(40, 40, 40))
            server.gui.add_checkbox("Wireframe Mode", initial_value=False)

        with server.gui.add_folder("Performance"):
            server.gui.add_slider(
                "FPS Limit", min=30, max=120, step=10, initial_value=60
            )
            server.gui.add_dropdown(
                "Quality", options=["Low", "Medium", "High"], initial_value="Medium"
            )

    # Example 4: A form, which is a folder whose contents are committed
    # together. on_update callbacks on child inputs still fire per-keystroke,
    # but the form's on_submit only fires when the user commits the form,
    # either via form.submit() (typically from a button) or by pressing Enter
    # in a single-line input. A dirty indicator is shown next to the form
    # label whenever any descendant has been edited since the last submit.
    with server.gui.add_form("Profile") as profile_form:
        name = server.gui.add_text("Name", initial_value="")
        age = server.gui.add_number("Age", initial_value=0)
        role = server.gui.add_dropdown(
            "Role", options=("guest", "user", "admin"), initial_value="user"
        )
        save_button = server.gui.add_button("Save")

    # Buttons inside a form are just normal buttons. Wire one to submit().
    save_button.on_click(lambda _: profile_form.submit())

    @profile_form.on_submit
    def _(_) -> None:
        print(f"Profile saved: name={name.value!r}, age={age.value}, role={role.value}")

    # Add some visual objects to demonstrate the controls
    server.scene.add_icosphere(
        name="demo_sphere",
        radius=sphere_radius.value,
        color=(
            sphere_color.value[0] / 255.0,
            sphere_color.value[1] / 255.0,
            sphere_color.value[2] / 255.0,
        ),
        position=(0.0, 0.0, 0.0),
        visible=sphere_visible.value,
    )

    if show_axes.value:
        server.scene.add_frame("axes", axes_length=1.0, axes_radius=0.02)

    print("This example shows GUI organization with folders.")
    print("The sphere demonstrates some interactive controls.")

    print("Explore the organized GUI controls!")
    print("Notice how folders help group related functionality.")

    while True:
        time.sleep(0.1)


if __name__ == "__main__":
    main()
