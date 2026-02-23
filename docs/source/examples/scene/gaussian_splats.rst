Gaussian splats
===============

Viser includes a WebGL-based Gaussian splat renderer.

**Features:**

* :meth:`viser.SceneApi.add_gaussian_splats` to add a Gaussian splat object
* Correct sorting when multiple splat objects are present
* Compositing with other scene objects

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 01_scene/09_gaussian_splats.py  # With viser installed.

**Source:** ``examples/01_scene/09_gaussian_splats.py``

.. figure:: ../../_static/examples/01_scene_09_gaussian_splats.png
   :width: 100%
   :alt: Gaussian splats

Code
----

.. code-block:: python
   :linenos:

   from __future__ import annotations
   
   import time
   from pathlib import Path
   from typing import TypedDict
   
   import numpy as np
   import numpy.typing as npt
   import tyro
   from plyfile import PlyData
   
   import viser
   from viser import transforms as tf
   
   
   class SplatFile(TypedDict):
   
       centers: npt.NDArray[np.floating]
       rgbs: npt.NDArray[np.floating]
       opacities: npt.NDArray[np.floating]
       covariances: npt.NDArray[np.floating]
   
   
   def load_splat_file(splat_path: Path, center: bool = False) -> SplatFile:
       start_time = time.time()
       splat_buffer = splat_path.read_bytes()
       bytes_per_gaussian = (
           # Each Gaussian is serialized as:
           # - position (vec3, float32)
           3 * 4
           # - xyz (vec3, float32)
           + 3 * 4
           # - rgba (vec4, uint8)
           + 4
           # - ijkl (vec4, uint8), where 0 => -1, 255 => 1.
           + 4
       )
       assert len(splat_buffer) % bytes_per_gaussian == 0
       num_gaussians = len(splat_buffer) // bytes_per_gaussian
   
       # Reinterpret cast to dtypes that we want to extract.
       splat_uint8 = np.frombuffer(splat_buffer, dtype=np.uint8).reshape(
           (num_gaussians, bytes_per_gaussian)
       )
       scales = splat_uint8[:, 12:24].copy().view(np.float32)
       wxyzs = splat_uint8[:, 28:32] / 255.0 * 2.0 - 1.0
       Rs = tf.SO3(wxyzs).as_matrix()
       covariances = np.einsum(
           "nij,njk,nlk->nil", Rs, np.eye(3)[None, :, :] * scales[:, None, :] ** 2, Rs
       )
       centers = splat_uint8[:, 0:12].copy().view(np.float32)
       if center:
           centers -= np.mean(centers, axis=0, keepdims=True)
       print(
           f"Splat file with {num_gaussians=} loaded in {time.time() - start_time} seconds"
       )
       return SplatFile(
           centers=centers,
           # Colors should have shape (N, 3).
           rgbs=splat_uint8[:, 24:27] / 255.0,
           opacities=splat_uint8[:, 27:28] / 255.0,
           # Covariances should have shape (N, 3, 3).
           covariances=covariances,
       )
   
   
   def load_ply_file(ply_file_path: Path, center: bool = False) -> SplatFile:
       start_time = time.time()
   
       SH_C0 = 0.28209479177387814
   
       plydata = PlyData.read(ply_file_path)
       v = plydata["vertex"]
       positions = np.stack([v["x"], v["y"], v["z"]], axis=-1)
       scales = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=-1))
       wxyzs = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], axis=1)
       colors = 0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1)
       opacities = 1.0 / (1.0 + np.exp(-v["opacity"][:, None]))
   
       Rs = tf.SO3(wxyzs).as_matrix()
       covariances = np.einsum(
           "nij,njk,nlk->nil", Rs, np.eye(3)[None, :, :] * scales[:, None, :] ** 2, Rs
       )
       if center:
           positions -= np.mean(positions, axis=0, keepdims=True)
   
       num_gaussians = len(v)
       print(
           f"PLY file with {num_gaussians=} loaded in {time.time() - start_time} seconds"
       )
       return SplatFile(
           centers=positions,
           rgbs=colors,
           opacities=opacities,
           covariances=covariances,
       )
   
   
   def main(
       splat_paths: tuple[Path, ...] = (
           # Path(__file__).absolute().parent.parent / "assets" / "train.splat",
           Path(__file__).absolute().parent.parent / "assets" / "nike.splat",
       ),
   ) -> None:
       server = viser.ViserServer()
   
       for i, splat_path in enumerate(splat_paths):
           if splat_path.suffix == ".splat":
               splat_data = load_splat_file(splat_path, center=True)
           elif splat_path.suffix == ".ply":
               splat_data = load_ply_file(splat_path, center=True)
           else:
               raise SystemExit("Please provide a filepath to a .splat or .ply file.")
   
           server.scene.add_transform_controls(f"/{i}")
           gs_handle = server.scene.add_gaussian_splats(
               f"/{i}/gaussian_splats",
               centers=splat_data["centers"],
               rgbs=splat_data["rgbs"],
               opacities=splat_data["opacities"],
               covariances=splat_data["covariances"],
           )
   
           remove_button = server.gui.add_button(f"Remove splat object {i}")
   
           @remove_button.on_click
           def _(_, gs_handle=gs_handle, remove_button=remove_button) -> None:
               gs_handle.remove()
               remove_button.remove()
   
       while True:
           time.sleep(10.0)
   
   
   if __name__ == "__main__":
       tyro.cli(main)
   
