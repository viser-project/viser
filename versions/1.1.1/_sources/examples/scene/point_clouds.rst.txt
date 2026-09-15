Point cloud visualization
=========================

Visualize 3D point clouds with colors.

Point clouds are fundamental for many 3D computer vision applications like SLAM, 3D reconstruction, and neural radiance fields. This example demonstrates how to use :meth:`viser.SceneApi.add_point_cloud` to display point clouds with per-point colors.

The example shows two different point clouds:

1. A **spiral point cloud** with height-based color gradient (blue to red)
2. A **random noise cloud** with random colors for each point

We also add a coordinate frame using :meth:`viser.SceneApi.add_frame` to provide spatial reference. Point clouds support various parameters like ``point_size`` to control visual appearance.

**Source:** ``examples/01_scene/01_point_clouds.py``

.. figure:: ../../_static/examples/01_scene_01_point_clouds.png
   :width: 100%
   :alt: Point cloud visualization

Code
----

.. code-block:: python
   :linenos:

   import numpy as np
   
   import viser
   
   
   def main():
       server = viser.ViserServer()
   
       # Generate a spiral point cloud.
       num_points = 200
       t = np.linspace(0, 10, num_points)
       spiral_positions = np.column_stack(
           [
               np.sin(t) * (1 + t / 10),
               np.cos(t) * (1 + t / 10),
               t / 5,
           ]
       )
   
       # Create colors based on height (z-coordinate).
       z_min, z_max = spiral_positions[:, 2].min(), spiral_positions[:, 2].max()
       normalized_z = (spiral_positions[:, 2] - z_min) / (z_max - z_min)
   
       # Color gradient from blue (bottom) to red (top).
       colors = np.zeros((num_points, 3), dtype=np.uint8)
       colors[:, 0] = (normalized_z * 255).astype(np.uint8)  # Red channel.
       colors[:, 2] = ((1 - normalized_z) * 255).astype(np.uint8)  # Blue channel.
   
       # Add the point cloud to the scene.
       server.scene.add_point_cloud(
           name="/spiral_cloud",
           points=spiral_positions,
           colors=colors,
           point_size=0.05,
       )
   
       # Add a second point cloud - random noise points.
       num_noise_points = 500
       noise_positions = np.random.normal(0, 1, (num_noise_points, 3))
       noise_colors = np.random.randint(0, 255, (num_noise_points, 3), dtype=np.uint8)
   
       server.scene.add_point_cloud(
           name="/noise_cloud",
           points=noise_positions,
           colors=noise_colors,
           point_size=0.03,
       )
   
       print("Point cloud visualization loaded!")
       print("- Spiral point cloud with height-based colors")
       print("- Random noise point cloud with random colors")
       print("Visit: http://localhost:8080")
   
       while True:
           pass
   
   
   if __name__ == "__main__":
       main()
   
