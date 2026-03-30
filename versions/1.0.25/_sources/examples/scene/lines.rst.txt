Line visualization
==================

Create line segments and smooth splines for wireframe and path visualization.

This example demonstrates viser's line rendering capabilities, which are essential for visualizing paths, trajectories, wireframes, and vector fields. Lines are commonly used in robotics for path planning, in computer graphics for wireframe models, and in data visualization for connections between points.

**Line types available:**

* :meth:`viser.SceneApi.add_line_segments` for straight line segments (most efficient for many lines)
* :meth:`viser.SceneApi.add_spline_catmull_rom` for smooth curves through control points
* :meth:`viser.SceneApi.add_spline_cubic_bezier` for precise curve control with Bezier handles

The example shows performance best practices: batching many line segments into a single call is much more efficient than creating individual scene objects for each line.

**Source:** ``examples/01_scene/03_lines.py``

.. figure:: ../../_static/examples/01_scene_03_lines.png
   :width: 100%
   :alt: Line visualization

Code
----

.. code-block:: python
   :linenos:

   import time
   
   import numpy as np
   
   import viser
   
   
   def main() -> None:
       server = viser.ViserServer()
   
       # Line segments.
       #
       # This will be much faster than creating separate scene objects for
       # individual line segments or splines.
       N = 2000
       points = np.random.normal(size=(N, 2, 3)) * 3.0
       colors = np.random.randint(0, 255, size=(N, 2, 3))
       server.scene.add_line_segments(
           "/line_segments",
           points=points,
           colors=colors,
           line_width=3.0,
       )
   
       # Spline helpers.
       #
       # If many lines are needed, it'll be more efficient to batch them in
       # `add_line_segments()`.
       for i in range(10):
           points = np.random.normal(size=(30, 3)) * 3.0
           server.scene.add_spline_catmull_rom(
               f"/catmull/{i}",
               points=points,
               tension=0.5,
               line_width=3.0,
               color=np.random.uniform(size=3),
               segments=100,
           )
   
           control_points = np.random.normal(size=(30 * 2 - 2, 3)) * 3.0
           server.scene.add_spline_cubic_bezier(
               f"/cubic_bezier/{i}",
               points=points,
               control_points=control_points,
               line_width=3.0,
               color=np.random.uniform(size=3),
               segments=100,
           )
   
       while True:
           time.sleep(10.0)
   
   
   if __name__ == "__main__":
       main()
   
