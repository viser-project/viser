Batched URDF visualization
==========================

Render multiple copies of one robot using
:class:`viser.extras.BatchedViserUrdf`. Visual geometry is exported once per
visual mesh, and shared across all instances. Each robot has independent
joint values and a base pose relative to the caller's root frame.

Install the ``urdf`` extra and run::

   python examples/04_demos/06_batched_urdf.py --num-robots 16

The example uses a small bundled robot with revolute, prismatic, fixed, and
mimic joints. No external robot downloads are required. Turn off animation
to control every robot with the joint sliders, or export a self-contained
animation with ``--record demo.html``.

This helper batches rendering and geometry transfer. Forward kinematics is
still evaluated in a Python loop using yourdfpy. It supports visual meshes
only, a fixed instance count, and the existing batched GLB rendering
limitations. Floating/planar joints and additional global scaling are not
supported.

For indexed changes, pass ``robot_indices`` to ``update_cfg`` with a ``(K, J)``
array, or to ``update_base_poses`` with ``(K, 4)`` quaternions and ``(K, 3)``
positions. Row ``k`` updates robot ``robot_indices[k]``. Indices must be unique
integers in ``[0, N)``. This avoids FK for unchanged robots; changed visual
properties still transmit full-N arrays through the existing dense protocol.
No frontend or message schema change is required.
Joint and base-pose arrays must be real and finite; complex arrays are rejected
before conversion so imaginary components cannot be silently discarded.
This also applies to complex scalars inside object arrays.

.. literalinclude:: ../../../../examples/04_demos/06_batched_urdf.py
   :language: python
   :linenos:
