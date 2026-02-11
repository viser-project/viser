Batched mesh rendering
======================

Efficiently render many instances of the same mesh with different transforms and colors.

This example demonstrates batched mesh rendering, which is essential for visualizing large numbers of similar objects like particles, forest scenes, or crowd simulations. Batched rendering is dramatically more efficient than creating individual scene objects.

**Key features:**

* :meth:`viser.SceneApi.add_batched_meshes_simple` for instanced mesh rendering
* :meth:`viser.SceneApi.add_batched_axes` for coordinate frame instances
* Per-instance transforms (position, rotation, scale)
* Per-instance colors with the `batched_colors` parameter (supports both per-instance and shared colors)
* Level-of-detail (LOD) optimization for performance
* Real-time animation of instance properties

Batched meshes have some limitations: GLB animations are not supported, hierarchy is flattened, and each mesh in a GLB is instanced separately. However, they excel at rendering thousands of objects efficiently.

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 01_scene/05_meshes_batched.py  # With viser installed.

.. note::
    For loading GLB files directly, see :meth:`~viser.SceneApi.add_batched_glb`.
    For working with trimesh objects, see :meth:`~viser.SceneApi.add_batched_meshes_trimesh`.

**Source:** ``examples/01_scene/05_meshes_batched.py``

.. figure:: ../../_static/examples/01_scene_05_meshes_batched.png
   :width: 100%
   :alt: Batched mesh rendering

Code
----

.. code-block:: python
   :linenos:

   from __future__ import annotations
   
   import time
   from pathlib import Path
   
   import numpy as np
   import trimesh
   
   import viser
   
   
   def create_grid_transforms(
       num_instances: int,
   ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
       grid_size = int(np.ceil(np.sqrt(num_instances)))
   
       # Create grid positions.
       x = np.arange(grid_size) - (grid_size - 1) / 2
       y = np.arange(grid_size) - (grid_size - 1) / 2
       xx, yy = np.meshgrid(x, y)
   
       positions = np.zeros((grid_size * grid_size, 3), dtype=np.float32)
       positions[:, 0] = xx.flatten()
       positions[:, 1] = yy.flatten()
       positions[:, 2] = 1.0
       positions = positions[:num_instances]
   
       # All instances have identity rotation.
       rotations = np.zeros((num_instances, 4), dtype=np.float32)
       rotations[:, 0] = 1.0  # w component = 1
   
       # Initial scales.
       scales = np.linalg.norm(positions, axis=-1)
       scales = np.sin(scales * 1.5) * 0.5 + 1.0
       return positions, rotations, scales.astype(np.float32)
   
   
   def generate_per_instance_colors(
       positions: np.ndarray, color_mode: str = "rainbow"
   ) -> np.ndarray:
       n = positions.shape[0]
   
       if color_mode == "rainbow":
           # Rainbow colors based on instance index.
           hues = np.linspace(0, 1, n, endpoint=False)
           colors = np.zeros((n, 3))
           for i, hue in enumerate(hues):
               # Convert HSV to RGB (simplified).
               c = 1.0  # Saturation.
               x = c * (1 - abs((hue * 6) % 2 - 1))
   
               if hue < 1 / 6:
                   colors[i] = [c, x, 0]
               elif hue < 2 / 6:
                   colors[i] = [x, c, 0]
               elif hue < 3 / 6:
                   colors[i] = [0, c, x]
               elif hue < 4 / 6:
                   colors[i] = [0, x, c]
               elif hue < 5 / 6:
                   colors[i] = [x, 0, c]
               else:
                   colors[i] = [c, 0, x]
           return (colors * 255).astype(np.uint8)
   
       elif color_mode == "position":
           # Colors based on position (cosine of position for smooth gradients).
           colors = (np.cos(positions) * 0.5 + 0.5) * 255
           return colors.astype(np.uint8)
   
       else:
           # Default to white.
           return np.full((n, 3), 255, dtype=np.uint8)
   
   
   def generate_shared_color(color_rgb: tuple[int, int, int]) -> np.ndarray:
       return np.array(color_rgb, dtype=np.uint8)
   
   
   def generate_animated_colors(
       positions: np.ndarray, t: float, animation_mode: str = "wave"
   ) -> np.ndarray:
       n = positions.shape[0]
   
       if animation_mode == "wave":
           # Wave pattern based on distance from center.
           distances = np.linalg.norm(positions[:, :2], axis=1)
           wave = np.sin(distances * 2) * 0.5 + 0.5
           colors = np.zeros((n, 3))
           colors[:, 0] = wave  # Red channel.
           colors[:, 1] = np.sin(distances * 2 + np.pi / 3) * 0.5 + 0.5  # Green.
           colors[:, 2] = np.sin(distances * 2 + 2 * np.pi / 3) * 0.5 + 0.5  # Blue.
           return (colors * 255).astype(np.uint8)
   
       elif animation_mode == "pulse":
           # Pulsing color based on position.
           pulse = np.sin(t * 2) * 0.5 + 0.5
           colors = (np.cos(positions) * 0.5 + 0.5) * pulse
           return (colors * 255).astype(np.uint8)
   
       elif animation_mode == "cycle":
           # Cycling through hues over time.
           hue_shift = (t * 0.5) % 1.0
           hues = (np.linspace(0, 1, n, endpoint=False) + hue_shift) % 1.0
           colors = np.zeros((n, 3))
           for i, hue in enumerate(hues):
               # Convert HSV to RGB (simplified).
               c = 1.0  # Saturation.
               x = c * (1 - abs((hue * 6) % 2 - 1))
   
               if hue < 1 / 6:
                   colors[i] = [c, x, 0]
               elif hue < 2 / 6:
                   colors[i] = [x, c, 0]
               elif hue < 3 / 6:
                   colors[i] = [0, c, x]
               elif hue < 4 / 6:
                   colors[i] = [0, x, c]
               elif hue < 5 / 6:
                   colors[i] = [x, 0, c]
               else:
                   colors[i] = [c, 0, x]
           return (colors * 255).astype(np.uint8)
   
       else:
           # Default to white.
           return np.full((n, 3), 255, dtype=np.uint8)
   
   
   def main():
       # Load and prepare mesh data.
       dragon_mesh = trimesh.load_mesh(str(Path(__file__).parent / "../assets/dragon.obj"))
       assert isinstance(dragon_mesh, trimesh.Trimesh)
       dragon_mesh.apply_scale(0.005)
       dragon_mesh.vertices -= dragon_mesh.centroid
   
       dragon_mesh.apply_transform(
           trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
       )
       dragon_mesh.apply_translation(-dragon_mesh.centroid)
   
       server = viser.ViserServer()
       server.scene.configure_default_lights()
       grid_handle = server.scene.add_grid(name="/grid", width=12, height=12)
   
       # Add GUI controls.
       instance_count_slider = server.gui.add_slider(
           "# of instances", min=1, max=1000, step=1, initial_value=100
       )
   
       animate_checkbox = server.gui.add_checkbox("Animate", initial_value=True)
       per_axis_scale_checkbox = server.gui.add_checkbox(
           "Per-axis scale during animation", initial_value=True
       )
       lod_checkbox = server.gui.add_checkbox("Enable LOD", initial_value=True)
       cast_shadow_checkbox = server.gui.add_checkbox("Cast shadow", initial_value=True)
   
       # Color controls.
       color_mode_dropdown = server.gui.add_dropdown(
           "Color mode",
           options=("Per-instance", "Shared", "Animated"),
           initial_value="Per-instance",
       )
   
       # Per-instance color controls.
       per_instance_color_dropdown = server.gui.add_dropdown(
           "Per-instance style",
           options=("Rainbow", "Position"),
           initial_value="Rainbow",
       )
   
       # Shared color controls.
       shared_color_rgb = server.gui.add_rgb("Shared color", initial_value=(255, 0, 255))
   
       # Animated color controls.
       animated_color_dropdown = server.gui.add_dropdown(
           "Animation style",
           options=("Wave", "Pulse", "Cycle"),
           initial_value="Wave",
       )
   
       # Initialize transforms.
       positions, rotations, scales = create_grid_transforms(instance_count_slider.value)
       positions_orig = positions.copy()
   
       # Create batched mesh visualization.
       axes_handle = server.scene.add_batched_axes(
           name="/axes",
           batched_positions=positions,
           batched_wxyzs=rotations,
           batched_scales=scales,
       )
   
       # Create initial colors based on default mode.
       initial_colors = generate_per_instance_colors(positions, color_mode="rainbow")
   
       mesh_handle = server.scene.add_batched_meshes_simple(
           name="/dragon",
           vertices=dragon_mesh.vertices,
           faces=dragon_mesh.faces,
           batched_positions=positions,
           batched_wxyzs=rotations,
           batched_scales=scales,
           batched_colors=initial_colors,
           lod="auto",
       )
   
       # Track previous color mode to avoid redundant disabled state updates.
       prev_color_mode = color_mode_dropdown.value
   
       # Animation loop.
       while True:
           n = instance_count_slider.value
   
           # Update props based on GUI controls.
           mesh_handle.lod = "auto" if lod_checkbox.value else "off"
           mesh_handle.cast_shadow = cast_shadow_checkbox.value
   
           # Recreate transforms if instance count changed.
           if positions.shape[0] != n:
               positions, rotations, scales = create_grid_transforms(n)
               positions_orig = positions.copy()
               grid_size = int(np.ceil(np.sqrt(n)))
   
               with server.atomic():
                   # Update grid size.
                   grid_handle.width = grid_handle.height = grid_size + 2
   
                   # Update all transforms.
                   mesh_handle.batched_positions = axes_handle.batched_positions = (
                       positions
                   )
                   mesh_handle.batched_wxyzs = axes_handle.batched_wxyzs = rotations
                   mesh_handle.batched_scales = axes_handle.batched_scales = scales
   
                   # Colors will be overwritten below; we'll just put them in a valid state.
                   mesh_handle.batched_colors = np.zeros(3, dtype=np.uint8)
   
           # Generate colors based on current mode.
           color_mode = color_mode_dropdown.value
   
           # Update disabled state for color controls only when mode changes.
           if color_mode != prev_color_mode:
               per_instance_color_dropdown.disabled = color_mode != "Per-instance"
               shared_color_rgb.disabled = color_mode != "Shared"
               animated_color_dropdown.disabled = color_mode != "Animated"
               prev_color_mode = color_mode
   
           if color_mode == "Per-instance":
               # Per-instance colors with different styles.
               per_instance_style = per_instance_color_dropdown.value.lower()
               colors = generate_per_instance_colors(
                   positions, color_mode=per_instance_style
               )
           elif color_mode == "Shared":
               # Single shared color for all instances.
               colors = generate_shared_color(shared_color_rgb.value)
           elif color_mode == "Animated":
               # Animated colors with time-based effects.
               t = time.perf_counter()
               animation_style = animated_color_dropdown.value.lower()
               colors = generate_animated_colors(
                   positions, t, animation_mode=animation_style
               )
           else:
               # Default fallback.
               colors = generate_per_instance_colors(positions, color_mode="rainbow")
   
           # Animate if enabled.
           if animate_checkbox.value:
               # Animate positions.
               t = time.time() * 2.0
               positions[:] = positions_orig
               positions[:, 0] += np.cos(t * 0.5)
               positions[:, 1] += np.sin(t * 0.5)
   
               # Animate scales with wave effect.
               if per_axis_scale_checkbox.value:
                   scales = np.linalg.norm(positions, axis=-1)
                   scales = np.stack(
                       [
                           np.sin(scales * 1.5) * 0.5 + 1.0,
                           np.sin(scales * 1.5 + np.pi / 2.0) * 0.5 + 1.0,
                           np.sin(scales * 1.5 + np.pi) * 0.5 + 1.0,
                       ],
                       axis=-1,
                   )
                   assert scales.shape == (n, 3)
               else:
                   scales = np.linalg.norm(positions, axis=-1)
                   scales = np.sin(scales * 1.5 - t) * 0.5 + 1.0
                   assert scales.shape == (n,)
   
               # Update colors for animated mode during animation.
               if color_mode == "Animated":
                   animation_style = animated_color_dropdown.value.lower()
                   colors = generate_animated_colors(
                       positions, t, animation_mode=animation_style
                   )
   
           # Update mesh properties.
           with server.atomic():
               mesh_handle.batched_positions = positions
               mesh_handle.batched_scales = scales
               mesh_handle.batched_colors = colors
   
               axes_handle.batched_positions = positions
               axes_handle.batched_scales = scales
   
           time.sleep(1.0 / 60.0)
   
   
   if __name__ == "__main__":
       main()
   
