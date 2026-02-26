COLMAP
======

Visualize COLMAP sparse reconstruction outputs. To get demo data, see `../assets/download_assets.sh`.

**Features:**

* COLMAP sparse reconstruction file parsing
* Camera frustum visualization with :meth:`viser.SceneApi.add_camera_frustum`
* 3D point cloud display from structure-from-motion
* Interactive camera and point visibility controls

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 04_demos/01_colmap_visualizer.py  # With viser installed.

**Source:** ``examples/04_demos/01_colmap_visualizer.py``

.. figure:: ../../_static/examples/04_demos_01_colmap_visualizer.png
   :width: 100%
   :alt: COLMAP

Code
----

.. code-block:: python
   :linenos:

   import random
   import time
   from pathlib import Path
   from typing import List
   
   import imageio.v3 as iio
   import numpy as np
   import tyro
   from tqdm.auto import tqdm
   
   import viser
   import viser.transforms as vtf
   from viser.extras.colmap import (
       read_cameras_binary,
       read_images_binary,
       read_points3d_binary,
   )
   
   
   def main(
       colmap_path: Path = Path(__file__).parent / "../assets/colmap_garden/sparse/0",
       images_path: Path = Path(__file__).parent / "../assets/colmap_garden/images_8",
       downsample_factor: int = 2,
       reorient_scene: bool = True,
   ) -> None:
       server = viser.ViserServer()
       server.gui.configure_theme(titlebar_content=None, control_layout="collapsible")
   
       # Load the colmap info.
       cameras = read_cameras_binary(colmap_path / "cameras.bin")
       images = read_images_binary(colmap_path / "images.bin")
       points3d = read_points3d_binary(colmap_path / "points3D.bin")
   
       points = np.array([points3d[p_id].xyz for p_id in points3d])
       colors = np.array([points3d[p_id].rgb for p_id in points3d])
   
       gui_reset_up = server.gui.add_button(
           "Reset up direction",
           hint="Set the camera control 'up' direction to the current camera's 'up'.",
       )
   
       # Let's rotate the scene so the average camera direction is pointing up.
       if reorient_scene:
           average_up = (
               # `qvec` corresponds to T_camera_world; we convert to T_world_camera.
               vtf.SO3(np.array([img.qvec for img in images.values()])).inverse()
               @ np.array([0.0, -1.0, 0.0])  # -y is up in the local frame!
           ).mean(axis=0)
           average_up /= np.linalg.norm(average_up)
           server.scene.set_up_direction((average_up[0], average_up[1], average_up[2]))
   
       @gui_reset_up.on_click
       def _(event: viser.GuiEvent) -> None:
           client = event.client
           assert client is not None
           client.camera.up_direction = vtf.SO3(client.camera.wxyz) @ np.array(
               [0.0, -1.0, 0.0]
           )
   
       gui_points = server.gui.add_slider(
           "Max points",
           min=1,
           max=len(points3d),
           step=1,
           initial_value=min(len(points3d), 50_000),
       )
       gui_frames = server.gui.add_slider(
           "Max frames",
           min=1,
           max=len(images),
           step=1,
           initial_value=min(len(images), 50),
       )
       gui_point_size = server.gui.add_slider(
           "Point size", min=0.01, max=0.1, step=0.001, initial_value=0.02
       )
   
       point_mask = np.random.choice(points.shape[0], gui_points.value, replace=False)
       point_cloud = server.scene.add_point_cloud(
           name="/colmap/pcd",
           points=points[point_mask],
           colors=colors[point_mask],
           point_size=gui_point_size.value,
       )
       frames: List[viser.FrameHandle] = []
   
       def visualize_frames() -> None:
   
           # Remove existing image frames.
           for frame in frames:
               frame.remove()
           frames.clear()
   
           # Interpret the images and cameras.
           img_ids = [im.id for im in images.values()]
           random.shuffle(img_ids)
           img_ids = sorted(img_ids[: gui_frames.value])
   
           for img_id in tqdm(img_ids):
               img = images[img_id]
               cam = cameras[img.camera_id]
   
               # Skip images that don't exist.
               image_filename = images_path / img.name
               if not image_filename.exists():
                   continue
   
               T_world_camera = vtf.SE3.from_rotation_and_translation(
                   vtf.SO3(img.qvec), img.tvec
               ).inverse()
               frame = server.scene.add_frame(
                   f"/colmap/frame_{img_id}",
                   wxyz=T_world_camera.rotation().wxyz,
                   position=T_world_camera.translation(),
                   axes_length=0.1,
                   axes_radius=0.005,
               )
               frames.append(frame)
   
               # For pinhole cameras, cam.params will be (fx, fy, cx, cy).
               if cam.model != "PINHOLE":
                   print(f"Expected pinhole camera, but got {cam.model}")
   
               H, W = cam.height, cam.width
               fy = cam.params[1]
               image = iio.imread(image_filename)
               image = image[::downsample_factor, ::downsample_factor]
               frustum = server.scene.add_camera_frustum(
                   f"/colmap/frame_{img_id}/frustum",
                   fov=2 * np.arctan2(H / 2, fy),
                   aspect=W / H,
                   scale=0.15,
                   image=image,
               )
   
               @frustum.on_click
               def _(_, frame=frame) -> None:
                   for client in server.get_clients().values():
                       client.camera.wxyz = frame.wxyz
                       client.camera.position = frame.position
   
       need_update = True
   
       @gui_points.on_update
       def _(_) -> None:
           point_mask = np.random.choice(points.shape[0], gui_points.value, replace=False)
           with server.atomic():
               point_cloud.points = points[point_mask]
               point_cloud.colors = colors[point_mask]
   
       @gui_frames.on_update
       def _(_) -> None:
           nonlocal need_update
           need_update = True
   
       @gui_point_size.on_update
       def _(_) -> None:
           point_cloud.point_size = gui_point_size.value
   
       while True:
           if need_update:
               need_update = False
               visualize_frames()
   
           time.sleep(1e-3)
   
   
   if __name__ == "__main__":
       tyro.cli(main)
   
