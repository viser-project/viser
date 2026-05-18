Frame Conventions
=================

This page describes the coordinate frame conventions used in ``viser``.

Scene Tree Naming
-----------------

Each object added to the scene in viser is instantiated as a node in a hierarchical scene tree. The structure of this tree is determined by the names assigned to the nodes.

If we add a coordinate frame called ``/base_link/shoulder/wrist``, it creates three nodes:

- ``wrist`` is a child of ``shoulder``
- ``shoulder`` is a child of ``base_link``
- ``base_link`` is the root node

When we set the transformation of a parent node like ``/base_link/shoulder``:

- ✅ Both the node **and all its children** (e.g., ``/base_link/shoulder/wrist``) will move
- ❌ Its parent (``/base_link``) remains **unaffected**

Poses
-----

Poses in ``viser`` are defined using two components:

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Field
     - Description
   * - ``wxyz``
     - Unit quaternion orientation term (always 4D: w, x, y, z)
   * - ``position``
     - Translation vector (always 3D: x, y, z)

These correspond to a transformation from coordinates in the local frame to the parent frame:

.. math::

   p_\mathrm{parent} = \begin{bmatrix} R & t \end{bmatrix}\begin{bmatrix}p_\mathrm{local} \\ 1\end{bmatrix}

where ``wxyz`` represents the quaternion form of the :math:`\mathrm{SO}(3)` rotation matrix :math:`R` and ``position`` represents the :math:`\mathbb{R}^3` translation vector :math:`t`.

World Coordinates
-----------------

In the world coordinate space, +Z points upward by default. This can be overridden with :func:`viser.SceneApi.set_up_direction()`.

Camera Conventions
------------------

In ``viser``, all camera parameters use the **COLMAP/OpenCV convention**:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Axis
     - Direction
   * - **Forward**
     - +Z
   * - **Up**
     - -Y
   * - **Right**
     - +X

.. note::
   **Difference from Nerfstudio**

   This is different from Nerfstudio, which uses the OpenGL/Blender convention:

   - Forward: -Z, Up: +Y, Right: +X

   **Conversion**: A simple **180° rotation around the local X-axis** converts between the two conventions.

----

.. seealso::

   **Related Documentation**

   - :class:`~viser.ViserServer` for scene management
   - :func:`~viser.SceneApi.set_up_direction` for coordinate system configuration
   - :mod:`~viser.transforms` for transformation utilities
