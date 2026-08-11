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

Server and Client Scopes
------------------------

Scene and GUI elements can be created through two kinds of handles:

- ``server.scene`` / ``server.gui``: **shared** elements, visible to every
  connected client and replayed to clients that connect later.
- ``client.scene`` / ``client.gui`` (via :class:`~viser.ClientHandle`):
  **per-client** elements, visible to one client only. Client state is
  ephemeral -- it disappears when the connection closes, and a reconnecting
  browser is a new client -- so per-client state should be (re)built in
  :meth:`~viser.ViserServer.on_client_connect`.

Each scene-tree name can hold one node from each scope. When both exist,
the client-scoped node **shadows** the shared one for that client: it is
the one rendered and the one that receives clicks and drags, while other
clients keep seeing the shared node. Updates to a shadowed shared node keep
accumulating invisibly; removing the client-scoped node reveals the shared
node again with its latest state. This makes per-client overrides of shared
elements a one-liner::

    # Everyone sees this...
    server.scene.add_box("/box", color=(255, 0, 0))
    # ...except this client, who now sees their own version instead:
    client.scene.add_box("/box", color=(0, 255, 0))

Removal is **scope-local**: removing a node (or a whole subtree) through
one scope's handle never touches the other scope's nodes, even per-client
children named under a shared parent -- those stay, anchored at the
parent's last pose, until their own scope removes them. In the scene-tree
panel, per-client nodes are marked with a ``local`` badge.

GUI container nesting across scopes is **directional**: a ``client.gui``
element may be added inside a ``server.gui`` container context (its
audience is a subset of the container's), rendering inside the shared
folder for that client only::

    with server.gui.add_folder("Shared folder"):
        client.gui.add_button("Only I see this")

The reverse -- a ``server.gui`` element inside a ``client.gui`` container
-- raises, since no other client could see the container. Cross-nested
elements are the one exception to scope-local removal: removing the
server container also removes the client elements nested inside it (an
orphaned widget, unlike a scene node, has nowhere coherent to go).

----

.. seealso::

   **Related Documentation**

   - :class:`~viser.ViserServer` for scene management
   - :class:`~viser.ClientHandle` for per-client state
   - :func:`~viser.SceneApi.set_up_direction` for coordinate system configuration
   - :mod:`~viser.transforms` for transformation utilities
