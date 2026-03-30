Performance Tips
---------------------------------

Viser is Usually Fast™, but can require care for larger scenes and time-series
data.

There are a few things to be mindful of.

Scene Node Count
=================================

Scenes in Viser can contain hundreds of objects without problems. When we start
visualizing thousands, however, the viewer can start to choke.

This is true even for simple geometries. For example, a scene with 5000 boxes
will start to sputter on most machines:

.. code-block:: python

    import viser

    server = viser.ViserServer()

    # Slow... 👎
    for i in range(5000):
        server.scene.add_box(
            f"/box_{i}",
            dimensions=(0.1, 0.1, 0.1),
            position=np.random.normal(size=3),
        )
    server.sleep_forever()


Batching objects can help by reducing CPU overhead and WebGL draw calls. Viser
provides several methods for batching, including:

- :meth:`viser.SceneApi.add_batched_axes`
- :meth:`viser.SceneApi.add_batched_meshes_simple`
- :meth:`viser.SceneApi.add_batched_meshes_trimesh`
- :meth:`viser.SceneApi.add_batched_glb`

In the case of splines and line segments, multiple lines can also be combined
into single :meth:`~viser.SceneApi.add_line_segments` calls.

With batching, even tens of thousands of boxes should feel snappy:

.. code-block:: python

    import numpy as np
    import trimesh
    import viser

    server = viser.ViserServer()

    N = 50_000
    batched_wxyzs = np.broadcast_to(np.array([1.0, 0.0, 0.0, 0.0]), (N, 4))
    batched_positions = np.random.normal(size=(N, 3))

    # Much faster! 👍
    server.scene.add_batched_meshes_trimesh(
        "/boxes",
        mesh=trimesh.creation.box(extents=(0.1, 0.1, 0.1)),
        batched_wxyzs=batched_wxyzs,
        batched_positions=batched_positions,
    )
    server.sleep_forever()


Time-series Data
=================================

The typical pattern for animations in Viser is to (1) set up the scene and (2)
update it in a loop:

.. code-block:: python

    import viser

    server = viser.ViserServer()

    # Scene setup.
    pass

    while True:
        # Update the scene.
        pass

        # Sleep based on update rate.
        time.sleep(1.0 / 30.0)


Compared to native viewers, one limitation of Viser is transport overhead. 3D
data is serialized in Python, passed through a websocket connection,
deserialized in your web browser, and then rendered using WebGL. These steps
are not typically an issue for static visualizations or the "setup" stage in
the example above. When combined with larger assets in the "update" stage and
faster update rates, however, they can become a bottleneck.

For smoother animations, we recommend avoiding heavier operations in loops:

* ❌ Sending large meshes or point clouds.
* ❌ Sending large images.
* ⚠️ Creating new scene nodes. (case-dependent)

Smaller property updates are generally fine. A non-exhaustive list:

* ✅ Setting visibilities.

  * Assigning :attr:`viser.SceneNodeHandle.visible`

* ✅ Setting orientations and positions of scene nodes.

  * Assigning :attr:`viser.SceneNodeHandle.wxyz`, :attr:`viser.SceneNodeHandle.position`

* ✅ Setting orientations and positions of batched meshes.

  * Assigning :attr:`viser.BatchedMeshHandle.batched_wxyzs`, :attr:`viser.BatchedMeshHandle.batched_positions`

* ✅ Setting scales of batched meshes.

  * Assigning :attr:`viser.BatchedMeshHandle.batched_scales`

* ✅ Updating orientations and positions of bones in skinned meshes.

  * Assigning :attr:`viser.MeshSkinnedHandle.bone_wxyzs` and :attr:`viser.MeshSkinnedHandle.bone_positions`

For animating heavier assets like point clouds, one workaround for transport
limitations is buffering: sending all point cloud data at the start and then
only toggling visibilities in the update loop.

.. note::

   Setting the visibility of a parent scene node to ``False`` will also hide
   all of its children. For time-series data, you can create a parent node for
   each timestep and toggle visibility of the parent to show/hide all children
   without looping through them individually. For an example of this pattern,
   see the :doc:`Record3D visualizer <examples/demos/record3d_visualizer>`.


Image Encoding Overhead
=================================

Images in Viser are represented as NumPy arrays and encoded for transport using
either JPEG or PNG compression. JPEG is generally faster, but PNG is lossless
and supports transparency.

If you run into problems with frequent updates to properties like
:attr:`viser.ImageHandle.image` and :attr:`viser.CameraFrustumHandle.image`, or
calls to :meth:`viser.SceneApi.set_background_image`, we recommend:

* Downsizing images before sending them.
* Using JPEG encoding if possible. Encoding can generally be set via a
  ``format=`` keyword argument.
* Ensuring that ``opencv-python`` is installed. This isn't a strict dependency
  of Viser, but Viser will use it to accelerate image encoding if installed.
  See discussion and benchmarks on `GitHub <https://github.com/viser-project/viser/pull/494>`_.
