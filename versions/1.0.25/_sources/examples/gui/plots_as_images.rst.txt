Plots as images
===============

Display OpenCV-generated plots as images in the GUI.

**Features:**

* :meth:`viser.GuiApi.add_image` for displaying plot images
* OpenCV-based plot generation and visualization
* Real-time plot updates with image streaming

**Source:** ``examples/02_gui/09_plots_as_images.py``

.. figure:: ../../_static/examples/02_gui_09_plots_as_images.png
   :width: 100%
   :alt: Plots as images

Code
----

.. code-block:: python
   :linenos:

   from __future__ import annotations
   
   import colorsys
   import time
   
   import cv2
   import numpy as np
   import tyro
   
   import viser
   import viser.transforms as vtf
   
   
   def get_line_plot(
       xs: np.ndarray,
       ys: np.ndarray,
       height: int,
       width: int,
       *,
       x_bounds: tuple[float, float] | None = None,
       y_bounds: tuple[float, float] | None = None,
       title: str | None = None,
       line_thickness: int = 2,
       grid_x_lines: int = 8,
       grid_y_lines: int = 5,
       font_scale: float = 0.4,
       background_color: tuple[int, int, int] = (0, 0, 0),
       plot_area_color: tuple[int, int, int] = (0, 0, 0),
       grid_color: tuple[int, int, int] = (60, 60, 60),
       axes_color: tuple[int, int, int] = (100, 100, 100),
       line_color: tuple[int, int, int] = (255, 255, 255),
       text_color: tuple[int, int, int] = (200, 200, 200),
   ) -> np.ndarray:
   
       if x_bounds is None:
           x_bounds = (np.min(xs), np.max(xs.round(decimals=4)))
       if y_bounds is None:
           y_bounds = (np.min(ys), np.max(ys))
   
       # Calculate text sizes for padding.
       font = cv2.FONT_HERSHEY_DUPLEX
       sample_y_label = f"{max(abs(y_bounds[0]), abs(y_bounds[1])):.1f}"
       y_text_size = cv2.getTextSize(sample_y_label, font, font_scale, 1)[0]
   
       sample_x_label = f"{max(abs(x_bounds[0]), abs(x_bounds[1])):.1f}"
       x_text_size = cv2.getTextSize(sample_x_label, font, font_scale, 1)[0]
   
       # Define padding based on font scale.
       extra_padding = 8
       left_pad = int(y_text_size[0] * 1.5) + extra_padding  # Space for y-axis labels
       right_pad = int(10 * font_scale) + extra_padding
   
       # Calculate top padding, accounting for title if present
       top_pad = int(10 * font_scale) + extra_padding
       title_font_scale = font_scale * 1.5  # Make title slightly larger
       if title is not None:
           title_size = cv2.getTextSize(title, font, title_font_scale, 1)[0]
           top_pad += title_size[1] + int(10 * font_scale)
   
       bottom_pad = int(x_text_size[1] * 2.0) + extra_padding  # Space for x-axis labels
   
       # Create larger image to accommodate padding.
       total_height = height
       total_width = width
       plot_width = width - left_pad - right_pad
       plot_height = height - top_pad - bottom_pad
       assert plot_width > 0 and plot_height > 0
   
       # Create image with specified background color
       img = np.ones((total_height, total_width, 3), dtype=np.uint8)
       img[:] = background_color
   
       # Create plot area with specified color
       plot_area = np.ones((plot_height, plot_width, 3), dtype=np.uint8)
       plot_area[:] = plot_area_color
       img[top_pad : top_pad + plot_height, left_pad : left_pad + plot_width] = plot_area
   
       def scale_to_pixels(values, bounds, pixels):
           min_val, max_val = bounds
           normalized = (values - min_val) / (max_val - min_val)
           return (normalized * (pixels - 1)).astype(np.int32)
   
       # Vertical grid lines.
       for i in range(grid_x_lines):
           x_pos = left_pad + int(plot_width * i / (grid_x_lines - 1))
           cv2.line(img, (x_pos, top_pad), (x_pos, top_pad + plot_height), grid_color, 1)
   
       # Horizontal grid lines.
       for i in range(grid_y_lines):
           y_pos = top_pad + int(plot_height * i / (grid_y_lines - 1))
           cv2.line(img, (left_pad, y_pos), (left_pad + plot_width, y_pos), grid_color, 1)
   
       # Draw axes.
       cv2.line(
           img,
           (left_pad, top_pad + plot_height),
           (left_pad + plot_width, top_pad + plot_height),
           axes_color,
           1,
       )  # x-axis
       cv2.line(
           img, (left_pad, top_pad), (left_pad, top_pad + plot_height), axes_color, 1
       )  # y-axis
   
       # Scale and plot the data.
       x_scaled = scale_to_pixels(xs, x_bounds, plot_width) + left_pad
       y_scaled = top_pad + plot_height - 1 - scale_to_pixels(ys, y_bounds, plot_height)
       pts = np.column_stack((x_scaled, y_scaled)).reshape((-1, 1, 2))
   
       # Draw the main plot line.
       cv2.polylines(
           img, [pts], False, line_color, thickness=line_thickness, lineType=cv2.LINE_AA
       )
   
       # Draw title if specified
       if title is not None:
           title_size = cv2.getTextSize(title, font, title_font_scale, 1)[0]
           title_x = left_pad + (plot_width - title_size[0]) // 2
           title_y = int(top_pad / 2) + title_size[1] // 2 - 1
           cv2.putText(
               img,
               title,
               (title_x, title_y),
               font,
               title_font_scale,
               text_color,
               1,
               cv2.LINE_AA,
           )
   
       # X-axis labels.
       for i in range(grid_x_lines):
           x_val = x_bounds[0] + (x_bounds[1] - x_bounds[0]) * i / (grid_x_lines - 1)
           x_pos = left_pad + int(plot_width * i / (grid_x_lines - 1))
           label = f"{x_val:.1f}"
           if label == "-0.0":
               label = "0.0"
           text_size = cv2.getTextSize(label, font, font_scale, 1)[0]
           cv2.putText(
               img,
               label,
               (x_pos - text_size[0] // 2, top_pad + plot_height + text_size[1] + 10),
               font,
               font_scale,
               text_color,
               1,
               cv2.LINE_AA,
           )
   
       # Y-axis labels.
       for i in range(grid_y_lines):
           y_val = y_bounds[0] + (y_bounds[1] - y_bounds[0]) * (grid_y_lines - 1 - i) / (
               grid_y_lines - 1
           )
           y_pos = top_pad + int(plot_height * i / (grid_y_lines - 1))
           label = f"{y_val:.1f}"
           if label == "-0.0":
               label = "0.0"
           text_size = cv2.getTextSize(label, font, font_scale, 1)[0]
           cv2.putText(
               img,
               label,
               (left_pad - text_size[0] - 5, y_pos + 5),
               font,
               font_scale,
               text_color,
               1,
               cv2.LINE_AA,
           )
   
       return img
   
   
   def create_sine_plot(title: str, counter: int) -> np.ndarray:
       xs = np.linspace(0, 2 * np.pi, 20)
       rgb = colorsys.hsv_to_rgb(counter / 4000 % 1, 1, 1)
       return get_line_plot(
           xs=xs,
           ys=np.sin(xs + counter / 20),
           title=title,
           line_color=(int(rgb[0] * 255), int(rgb[1] * 255), int(rgb[2] * 255)),
           height=150,
           width=350,
       )
   
   
   def main(num_plots: int = 8) -> None:
       server = viser.ViserServer()
   
       # Create GUI elements for display runtimes.
       with server.gui.add_folder("Runtime"):
           draw_time = server.gui.add_text("Draw / plot (ms)", "0.00", disabled=True)
           send_gui_time = server.gui.add_text(
               "Gui update / plot (ms)", "0.00", disabled=True
           )
           send_scene_time = server.gui.add_text(
               "Scene update / plot (ms)", "0.00", disabled=True
           )
   
       # Add 2D plots to the GUI.
       with server.gui.add_folder("Plots"):
           plots_cb = server.gui.add_checkbox("Update plots", True)
           gui_image_handles = [
               server.gui.add_image(
                   create_sine_plot(f"Plot {i}", counter=0),
                   label=f"Image {i}",
                   format="jpeg",
               )
               for i in range(num_plots)
           ]
   
       # Add 2D plots to the scene. We flip them with a parent coordinate frame.
       server.scene.add_frame(
           "/images", wxyz=vtf.SO3.from_y_radians(np.pi).wxyz, show_axes=False
       )
       scene_image_handles = [
           server.scene.add_image(
               f"/images/plot{i}",
               image=gui_image_handles[i].image,
               render_width=3.5,
               render_height=1.5,
               format="jpeg",
               position=(
                   (i % 2 - 0.5) * 3.5,
                   (i // 2 - (num_plots - 1) / 4) * 1.5,
                   0,
               ),
           )
           for i in range(num_plots)
       ]
   
       counter = 0
   
       while True:
           if plots_cb.value:
               # Create and time the plot generation.
               start = time.time()
               images = [
                   create_sine_plot(f"Plot {i}", counter=counter * (i + 1))
                   for i in range(num_plots)
               ]
               draw_time.value = f"{0.98 * float(draw_time.value) + 0.02 * (time.time() - start) / num_plots * 1000:.2f}"
   
               # Update all plot images.
               start = time.time()
               for i, handle in enumerate(gui_image_handles):
                   handle.image = images[i]
               send_gui_time.value = f"{0.98 * float(send_gui_time.value) + 0.02 * (time.time() - start) / num_plots * 1000:.2f}"
   
               # Update all scene images.
               start = time.time()
               for i, handle in enumerate(scene_image_handles):
                   handle.image = gui_image_handles[i].image
               send_scene_time.value = f"{0.98 * float(send_scene_time.value) + 0.02 * (time.time() - start) / num_plots * 1000:.2f}"
   
           # Sleep a bit before continuing.
           time.sleep(0.02)
           counter += 1
   
   
   if __name__ == "__main__":
       tyro.cli(main)
   
