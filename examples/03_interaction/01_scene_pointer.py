"""Scene pointer events

Capture mouse pointer events to create rays for 3D scene interaction and ray-mesh intersections.

**Features:**

* :meth:`viser.ViserServer.on_scene_pointer` for mouse ray events
* Ray-mesh intersection calculations with trimesh
* Dynamic mesh highlighting based on ray hits
* Real-time pointer coordinate display

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 03_interaction/01_scene_pointer.py  # With viser installed.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import cast

import numpy as np
import trimesh
import trimesh.creation
import trimesh.ray

import viser
import viser.transforms as tf


def main() -> None:
    server = viser.ViserServer()
    server.gui.configure_theme(brand_color=(130, 0, 150))
    server.scene.set_up_direction("+y")

    mesh = cast(
        trimesh.Trimesh,
        trimesh.load_mesh(str(Path(__file__).parent / "../assets/dragon.obj")),
    )
    mesh.apply_scale(0.05)

    mesh_handle = server.scene.add_mesh_trimesh(
        name="/mesh",
        mesh=mesh,
        position=(0.0, 0.0, 0.0),
    )

    hit_pos_handles: list[viser.GlbHandle] = []

    # Buttons + callbacks will operate on a per-client basis, but will modify the global scene! :)
    @server.on_client_connect
    def _(client: viser.ClientHandle) -> None:
        # Set up the camera -- this gives a nice view of the full mesh.
        client.camera.position = np.array([0.0, 0.0, -10.0])
        client.camera.wxyz = np.array([0.0, 0.0, 0.0, 1.0])

        # Tests "click" scenepointerevent.
        click_button_handle = client.gui.add_button(
            "Add sphere", icon=viser.Icon.POINTER
        )

        @click_button_handle.on_click
        def _(_):
            click_button_handle.disabled = True

            @client.scene.on_pointer_event(event_type="click")
            def _(event: viser.ScenePointerEvent) -> None:
                # Check for intersection with the mesh, using trimesh's ray-mesh intersection.
                # Note that mesh is in the mesh frame, so we need to transform the ray.
                R_world_mesh = tf.SO3(mesh_handle.wxyz)
                R_mesh_world = R_world_mesh.inverse()
                origin = (R_mesh_world @ np.array(event.ray_origin)).reshape(1, 3)
                direction = (R_mesh_world @ np.array(event.ray_direction)).reshape(1, 3)
                intersector = trimesh.ray.ray_triangle.RayMeshIntersector(mesh)
                hit_pos, _, _ = intersector.intersects_location(origin, direction)

                if len(hit_pos) == 0:
                    return
                client.scene.remove_pointer_callback()

                # Get the first hit position (based on distance from the ray origin).
                hit_pos = hit_pos[np.argmin(np.sum((hit_pos - origin) ** 2, axis=-1))]

                # Create a sphere at the hit location.
                hit_pos_mesh = trimesh.creation.icosphere(radius=0.1)
                hit_pos_mesh.vertices += R_world_mesh @ hit_pos
                hit_pos_mesh.visual.vertex_colors = (0.5, 0.0, 0.7, 1.0)  # type: ignore
                hit_pos_handle = server.scene.add_mesh_trimesh(
                    name=f"/hit_pos_{len(hit_pos_handles)}", mesh=hit_pos_mesh
                )
                hit_pos_handles.append(hit_pos_handle)

            @client.scene.on_pointer_callback_removed
            def _():
                click_button_handle.disabled = False

        # Tests "rect-select" scenepointerevent.
        paint_button_handle = client.gui.add_button("Paint mesh", icon=viser.Icon.PAINT)

        @paint_button_handle.on_click
        def _(_):
            paint_button_handle.disabled = True

            @client.scene.on_pointer_event(event_type="rect-select")
            def _(event: viser.ScenePointerEvent) -> None:
                client.scene.remove_pointer_callback()

                nonlocal mesh_handle
                camera = event.client.camera

                # Put the mesh in the camera frame.
                R_world_mesh = tf.SO3(mesh_handle.wxyz)
                R_mesh_world = R_world_mesh.inverse()
                R_camera_world = tf.SE3.from_rotation_and_translation(
                    tf.SO3(camera.wxyz), camera.position
                ).inverse()
                vertices = cast(np.ndarray, mesh.vertices)
                vertices = (R_mesh_world.as_matrix() @ vertices.T).T
                vertices = (
                    R_camera_world.as_matrix()
                    @ np.hstack([vertices, np.ones((vertices.shape[0], 1))]).T
                ).T[:, :3]

                # Get the camera intrinsics, and project the vertices onto the image plane.
                fov, aspect = camera.fov, camera.aspect
                vertices_proj = vertices[:, :2] / vertices[:, 2].reshape(-1, 1)
                vertices_proj /= np.tan(fov / 2)
                vertices_proj[:, 0] /= aspect

                # Move the origin to the upper-left corner, and scale to [0, 1].
                # ... make sure to match the OpenCV's image coordinates!
                vertices_proj = (1 + vertices_proj) / 2

                # Select the vertices that lie inside the 2D selected box, once projected.
                mask = (
                    (vertices_proj > np.array(event.screen_pos[0]))
                    & (vertices_proj < np.array(event.screen_pos[1]))
                ).all(axis=1)[..., None]

                # Update the mesh color based on whether the vertices are inside the box
                mesh.visual.vertex_colors = np.where(  # type: ignore
                    mask, (0.5, 0.0, 0.7, 1.0), (0.9, 0.9, 0.9, 1.0)
                )
                mesh_handle = server.scene.add_mesh_trimesh(
                    name="/mesh",
                    mesh=mesh,
                    position=(0.0, 0.0, 0.0),
                )

            @client.scene.on_pointer_callback_removed
            def _():
                paint_button_handle.disabled = False

        # Button to clear spheres.
        clear_button_handle = client.gui.add_button("Clear scene", icon=viser.Icon.X)

        @clear_button_handle.on_click
        def _(_):
            """Reset the mesh color and remove all click-generated spheres."""
            nonlocal mesh_handle
            for handle in hit_pos_handles:
                handle.remove()
            hit_pos_handles.clear()
            mesh.visual.vertex_colors = (0.9, 0.9, 0.9, 1.0)  # type: ignore
            mesh_handle = server.scene.add_mesh_trimesh(
                name="/mesh",
                mesh=mesh,
                position=(0.0, 0.0, 0.0),
            )

    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    main()
