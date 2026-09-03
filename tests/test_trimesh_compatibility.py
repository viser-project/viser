import numpy as np
import trimesh

import viser


def test_trimesh_mesh_helpers() -> None:
    server = viser.ViserServer(port=0, verbose=False)
    try:
        mesh = trimesh.creation.box(extents=(1.0, 2.0, 3.0))
        server.scene.add_mesh_trimesh("/mesh", mesh)
        server.scene.add_batched_meshes_trimesh(
            "/batched",
            mesh,
            batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32),
            batched_positions=np.array([[0.0, 0.0, 0.0]], dtype=np.float32),
        )
    finally:
        server.stop()
