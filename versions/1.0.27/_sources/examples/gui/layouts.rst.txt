GUI layouts
===========

Organize GUI controls using folders, forms, tabs, and nested structures for better user experience.

**Features:**

* :meth:`viser.GuiApi.add_folder` for grouping related controls
* :meth:`viser.GuiApi.add_form` for groups that commit together on submit
* :meth:`viser.GuiApi.add_tab_group` and :meth:`viser.GuiTabGroupHandle.add_tab` for tabbed interfaces
* :meth:`viser.GuiApi.add_divider` for separating sections with a horizontal line
* Nested folder hierarchies for complex layouts
* Context managers for automatic grouping

**Source:** ``examples/02_gui/02_layouts.py``

.. figure:: ../../_static/examples/02_gui_02_layouts.png
   :width: 100%
   :alt: GUI layouts

Code
----

.. code-block:: python
   :linenos:

   import time
   
   import viser
   
   
   def main() -> None:
       server = viser.ViserServer()
   
       # A form groups inputs that are committed together. on_update callbacks on
       # child inputs still fire per-keystroke, but on_submit only fires when the
       # user presses Enter or clicks the button. A dirty indicator (*) appears
       # next to the label whenever any input has been edited since the last submit.
       with server.gui.add_form("Camera Controls") as camera_form:
           cam_x = server.gui.add_number("X", initial_value=3.0, step=0.01)
           cam_y = server.gui.add_number("Y", initial_value=3.0, step=0.01)
           cam_z = server.gui.add_number("Z", initial_value=3.0, step=0.01)
           go_button = server.gui.add_button("Go")
   
       go_button.on_click(lambda _: camera_form.submit())
   
       @camera_form.on_submit
       def _(_) -> None:
           for client in server.get_clients().values():
               client.camera.position = (cam_x.value, cam_y.value, cam_z.value)
               client.camera.look_at = (0.0, 0.0, 0.0)
   
       # Example 2: Scene objects organization
       with server.gui.add_folder("Scene Objects"):
           server.gui.add_checkbox("Enable Lighting", initial_value=True)
           server.gui.add_slider(
               "Intensity", min=0.0, max=2.0, step=0.1, initial_value=1.0
           )
           server.gui.add_rgb("Color", initial_value=(255, 255, 255))
   
           server.gui.add_divider()
   
           show_axes = server.gui.add_checkbox("Show Coordinate Axes", initial_value=True)
           server.gui.add_checkbox("Show Grid", initial_value=False)
   
           with server.gui.add_folder("Sphere"):
               sphere_radius = server.gui.add_slider(
                   "Radius", min=0.1, max=2.0, step=0.1, initial_value=0.5
               )
               sphere_color = server.gui.add_rgb("Color", initial_value=(255, 0, 0))
               sphere_visible = server.gui.add_checkbox("Visible", initial_value=True)
   
       # Example 3: Settings and preferences
       with server.gui.add_folder("Settings"):
           server.gui.add_rgb("Background", initial_value=(40, 40, 40))
           server.gui.add_checkbox("Wireframe Mode", initial_value=False)
   
           server.gui.add_divider()
   
           server.gui.add_slider("FPS Limit", min=30, max=120, step=10, initial_value=60)
           server.gui.add_dropdown(
               "Quality", options=["Low", "Medium", "High"], initial_value="Medium"
           )
   
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
   
       while True:
           time.sleep(0.1)
   
   
   if __name__ == "__main__":
       main()
   
