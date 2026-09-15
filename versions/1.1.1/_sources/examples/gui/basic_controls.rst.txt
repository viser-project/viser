Basic GUI controls
==================

Create interactive controls like sliders, buttons, and text inputs.

This example demonstrates the full range of GUI controls available in viser, including:

**Input Controls:**

* :meth:`viser.GuiApi.add_number` for numeric input
* :meth:`viser.GuiApi.add_slider` for range selection
* :meth:`viser.GuiApi.add_vector2` and :meth:`viser.GuiApi.add_vector3` for coordinate input
* :meth:`viser.GuiApi.add_text` for text input
* :meth:`viser.GuiApi.add_rgb` for color selection

**Interactive Elements:**

* :meth:`viser.GuiApi.add_button` with custom icons from :class:`viser.Icon`
* :meth:`viser.GuiButtonHandle.on_hold` for continuous actions while a button is held
* :meth:`viser.GuiApi.add_checkbox` for boolean toggles
* :meth:`viser.GuiApi.add_multi_slider` for multi-handle range controls
* :meth:`viser.GuiApi.add_upload_button` for file uploads

**Layout & Organization:**

* :meth:`viser.GuiApi.add_folder` to group related controls
* :meth:`viser.GuiApi.add_progress_bar` for status indication

The example shows how to read control values with ``.value``, manage visibility with ``.visible``, and disable controls with ``.disabled``. GUI state automatically synchronizes with all connected clients.

**Source:** ``examples/02_gui/00_basic_controls.py``

.. figure:: ../../_static/examples/02_gui_00_basic_controls.png
   :width: 100%
   :alt: Basic GUI controls

Code
----

.. code-block:: python
   :linenos:

   import time
   
   import numpy as np
   
   import viser
   
   
   def main() -> None:
       server = viser.ViserServer()
   
       # Add some common GUI elements: number inputs, sliders, vectors, checkboxes.
       with server.gui.add_folder("Read-only"):
           gui_counter = server.gui.add_number(
               "Counter",
               initial_value=0,
               disabled=True,
           )
           gui_slider = server.gui.add_slider(
               "Slider",
               min=0,
               max=100,
               step=1,
               initial_value=0,
               disabled=True,
           )
           gui_progress = server.gui.add_progress_bar(25, animated=True)
   
       with server.gui.add_folder("Editable"):
           gui_vector2 = server.gui.add_vector2(
               "Position",
               initial_value=(0.0, 0.0),
               step=0.1,
           )
           gui_vector3 = server.gui.add_vector3(
               "Size",
               initial_value=(1.0, 1.0, 1.0),
               step=0.25,
           )
   
           # Buttons with on_hold for continuous size adjustment while held.
           gui_grow = server.gui.add_button("Grow (hold)", icon=viser.Icon.PLUS)
           gui_shrink = server.gui.add_button("Shrink (hold)", icon=viser.Icon.MINUS)
   
           @gui_grow.on_hold(callback_hz=10.0)
           def _(_: viser.GuiEvent[viser.GuiButtonHandle]) -> None:
               x, y, z = gui_vector3.value
               gui_vector3.value = (x + 0.05, y + 0.05, z + 0.05)
   
           @gui_shrink.on_hold(callback_hz=10.0)
           def _(_: viser.GuiEvent[viser.GuiButtonHandle]) -> None:
               x, y, z = gui_vector3.value
               gui_vector3.value = (
                   max(0.1, x - 0.05),
                   max(0.1, y - 0.05),
                   max(0.1, z - 0.05),
               )
   
           with server.gui.add_folder("Text toggle"):
               gui_checkbox_hide = server.gui.add_checkbox(
                   "Hide",
                   initial_value=False,
               )
               gui_text = server.gui.add_text(
                   "Text",
                   initial_value="Hello world",
               )
               gui_button = server.gui.add_button("Button", icon=viser.Icon.MOUSE)
               gui_checkbox_disable = server.gui.add_checkbox(
                   "Disable",
                   initial_value=False,
               )
               gui_rgb = server.gui.add_rgb(
                   "Color",
                   initial_value=(255, 255, 0),
               )
               gui_multi_slider = server.gui.add_multi_slider(
                   "Multi slider",
                   min=0,
                   max=100,
                   step=1,
                   initial_value=(0, 30, 100),
                   marks=((0, "0"), (50, "5"), (70, "7"), 99),
               )
               gui_slider_positions = server.gui.add_slider(
                   "# sliders",
                   min=0,
                   max=10,
                   step=1,
                   initial_value=3,
                   marks=((0, "0"), (5, "5"), (7, "7"), 10),
               )
               gui_upload_button = server.gui.add_upload_button(
                   "Upload", icon=viser.Icon.UPLOAD
               )
   
       @gui_upload_button.on_upload
       def _(_) -> None:
           file = gui_upload_button.value
           print(file.name, len(file.content), "bytes")
   
       # Pre-generate a point cloud to send.
       point_positions = np.random.uniform(low=-1.0, high=1.0, size=(5000, 3))
       color_coeffs = np.random.uniform(0.4, 1.0, size=(point_positions.shape[0]))
   
       counter = 0
       while True:
           # We can set the value of an input to a particular value. Changes are
           # automatically reflected in connected clients.
           gui_counter.value = counter
           gui_slider.value = counter % 100
   
           # We can set the position of a scene node with `.position`, and read the value
           # of a gui element with `.value`. Changes are automatically reflected in
           # connected clients.
           server.scene.add_point_cloud(
               "/point_cloud",
               points=point_positions * np.array(gui_vector3.value, dtype=np.float32),
               colors=(np.array(gui_rgb.value) * color_coeffs[:, None]).astype(np.uint8),
               position=gui_vector2.value + (0,),
               point_shape="circle",
           )
           gui_button.color = gui_rgb.value
   
           gui_progress.value = float((counter % 100))
   
           # We can use `.visible` and `.disabled` to toggle GUI elements.
           gui_text.visible = not gui_checkbox_hide.value
           gui_button.visible = not gui_checkbox_hide.value
           gui_rgb.disabled = gui_checkbox_disable.value
           gui_multi_slider.disabled = gui_checkbox_disable.value
           gui_slider_positions.disabled = gui_checkbox_disable.value
           gui_button.disabled = gui_checkbox_disable.value
           gui_upload_button.disabled = gui_checkbox_disable.value
   
           # Update the number of handles in the multi-slider.
           if gui_slider_positions.value != len(gui_multi_slider.value):
               gui_multi_slider.value = np.linspace(
                   0, 100, gui_slider_positions.value, dtype=np.int64
               )
   
           counter += 1
           time.sleep(0.01)
   
   
   if __name__ == "__main__":
       main()
   
