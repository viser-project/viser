Depth compositing
=================

Display background images that can occlude 3D geometry based on depth values.

**Features:**

* :meth:`viser.SceneApi.set_background_image` with depth compositing
* Depth-based occlusion for realistic 2D/3D integration
* Custom depth maps for controlling visibility
* Real-time depth buffer updates

**Source:** ``examples/01_scene/07_background_composite.py``

.. figure:: ../../_static/examples/01_scene_07_background_composite.png
   :width: 100%
   :alt: Depth compositing

Code
----

.. code-block:: python
   :linenos:

   import time
   
   import numpy as np
   import trimesh
   import trimesh.creation
   
   import viser
   
   server = viser.ViserServer()
   
   
   img = np.random.randint(0, 255, size=(1000, 1000, 3), dtype=np.uint8)
   depth = np.ones((1000, 1000, 1), dtype=np.float32)
   
   # Make a square middle portal.
   depth[250:750, 250:750, :] = 10.0
   img[250:750, 250:750, :] = 255
   
   mesh = trimesh.creation.box((0.5, 0.5, 0.5))
   server.scene.add_mesh_trimesh(
       name="/cube",
       mesh=mesh,
       position=(0, 0, 0.0),
   )
   server.scene.set_background_image(img, depth=depth)
   
   
   while True:
       time.sleep(1.0)
   
