Lighting and shadows
====================

Add directional lights and ambient lighting to illuminate 3D meshes with realistic shadows.

**Features:**

* :meth:`viser.SceneApi.set_ambient_light` for global illumination
* :meth:`viser.SceneApi.add_directional_light` for sun-like directional lighting
* :meth:`viser.SceneApi.configure_default_lights` for quick setup
* :attr:`viser.SceneNodeHandle.cast_shadow` to enable shadow casting
* Dynamic light control with GUI sliders

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 01_scene/06_lighting.py  # With viser installed.

**Source:** ``examples/01_scene/06_lighting.py``

.. figure:: ../../_static/examples/01_scene_06_lighting.png
   :width: 100%
   :alt: Lighting and shadows

Code
----

.. code-block:: python
   :linenos:

   import time
   from pathlib import Path
   
   import numpy as np
   import trimesh
   
   import viser
   import viser.transforms as tf
   
   
   def main() -> None:
       # Load mesh.
       mesh = trimesh.load_mesh(str(Path(__file__).parent / "../assets/dragon.obj"))
       assert isinstance(mesh, trimesh.Trimesh)
       mesh.apply_scale(0.05)
       vertices = mesh.vertices
       faces = mesh.faces
       print(f"Loaded mesh with {vertices.shape} vertices, {faces.shape} faces")
       print(mesh)
   
       # Start Viser server with mesh.
       server = viser.ViserServer()
   
       server.scene.add_mesh_simple(
           name="/simple",
           vertices=vertices,
           faces=faces,
           wxyz=tf.SO3.from_x_radians(np.pi / 2).wxyz,
           position=(0.0, 2.0, 0.0),
       )
       server.scene.add_mesh_trimesh(
           name="/trimesh",
           mesh=mesh,
           wxyz=tf.SO3.from_x_radians(np.pi / 2).wxyz,
           position=(0.0, -2.0, 0.0),
       )
       grid = server.scene.add_grid(
           "grid",
           width=20.0,
           height=20.0,
           position=np.array([0.0, 0.0, -2.0]),
       )
   
       # adding controls to custom lights in the scene
       server.scene.add_transform_controls(
           "/control0", position=(0.0, 10.0, 5.0), scale=2.0
       )
       server.scene.add_label("/control0/label", "Directional")
       server.scene.add_transform_controls(
           "/control1", position=(0.0, -5.0, 5.0), scale=2.0
       )
       server.scene.add_label("/control1/label", "Point")
   
       directional_light = server.scene.add_light_directional(
           name="/control0/directional_light",
           color=(186, 219, 173),
           cast_shadow=True,
       )
       point_light = server.scene.add_light_point(
           name="/control1/point_light",
           color=(192, 255, 238),
           intensity=30.0,
           cast_shadow=True,
       )
   
       with server.gui.add_folder("Grid Shadows"):
           # Create grid shadows toggle
           grid_shadows = server.gui.add_slider(
               "Intensity",
               min=0.0,
               max=1.0,
               step=0.01,
               initial_value=grid.shadow_opacity,
           )
   
           @grid_shadows.on_update
           def _(_) -> None:
               grid.shadow_opacity = grid_shadows.value
   
       # Create default light toggle.
       gui_default_lights = server.gui.add_checkbox("Default lights", initial_value=True)
       gui_default_shadows = server.gui.add_checkbox(
           "Default shadows", initial_value=False
       )
   
       gui_default_lights.on_update(
           lambda _: server.scene.configure_default_lights(
               gui_default_lights.value, gui_default_shadows.value
           )
       )
       gui_default_shadows.on_update(
           lambda _: server.scene.configure_default_lights(
               gui_default_lights.value, gui_default_shadows.value
           )
       )
   
       # Create light control inputs.
       with server.gui.add_folder("Directional light"):
           gui_directional_color = server.gui.add_rgb(
               "Color", initial_value=directional_light.color
           )
           gui_directional_intensity = server.gui.add_slider(
               "Intensity",
               min=0.0,
               max=20.0,
               step=0.01,
               initial_value=directional_light.intensity,
           )
           gui_directional_shadows = server.gui.add_checkbox("Shadows", True)
   
           @gui_directional_color.on_update
           def _(_) -> None:
               directional_light.color = gui_directional_color.value
   
           @gui_directional_intensity.on_update
           def _(_) -> None:
               directional_light.intensity = gui_directional_intensity.value
   
           @gui_directional_shadows.on_update
           def _(_) -> None:
               directional_light.cast_shadow = gui_directional_shadows.value
   
       with server.gui.add_folder("Point light"):
           gui_point_color = server.gui.add_rgb("Color", initial_value=point_light.color)
           gui_point_intensity = server.gui.add_slider(
               "Intensity",
               min=0.0,
               max=200.0,
               step=0.01,
               initial_value=point_light.intensity,
           )
           gui_point_shadows = server.gui.add_checkbox("Shadows", True)
   
           @gui_point_color.on_update
           def _(_) -> None:
               point_light.color = gui_point_color.value
   
           @gui_point_intensity.on_update
           def _(_) -> None:
               point_light.intensity = gui_point_intensity.value
   
           @gui_point_shadows.on_update
           def _(_) -> None:
               point_light.cast_shadow = gui_point_shadows.value
   
       # Create GUI elements for controlling environment map.
       with server.gui.add_folder("Environment map"):
           gui_env_preset = server.gui.add_dropdown(
               "Preset",
               (
                   "None",
                   "apartment",
                   "city",
                   "dawn",
                   "forest",
                   "lobby",
                   "night",
                   "park",
                   "studio",
                   "sunset",
                   "warehouse",
               ),
               initial_value="city",
           )
           gui_background = server.gui.add_checkbox("Background", False)
           gui_bg_blurriness = server.gui.add_slider(
               "Bg Blurriness",
               min=0.0,
               max=1.0,
               step=0.01,
               initial_value=0.0,
           )
           gui_bg_intensity = server.gui.add_slider(
               "Bg Intensity",
               min=0.0,
               max=1.0,
               step=0.01,
               initial_value=1.0,
           )
           gui_env_intensity = server.gui.add_slider(
               "Env Intensity",
               min=0.0,
               max=1.0,
               step=0.01,
               initial_value=0.3,
           )
   
       def update_environment_map(_) -> None:
           server.scene.configure_environment_map(
               gui_env_preset.value if gui_env_preset.value != "None" else None,
               background=gui_background.value,
               background_blurriness=gui_bg_blurriness.value,
               background_intensity=gui_bg_intensity.value,
               environment_intensity=gui_env_intensity.value,
           )
   
       update_environment_map(None)
       gui_env_preset.on_update(update_environment_map)
       gui_background.on_update(update_environment_map)
       gui_bg_blurriness.on_update(update_environment_map)
       gui_bg_intensity.on_update(update_environment_map)
       gui_env_intensity.on_update(update_environment_map)
   
       while True:
           time.sleep(10.0)
   
   
   if __name__ == "__main__":
       main()
   
