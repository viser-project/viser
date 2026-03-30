Embedded Visualizations
========================

This guide describes how to export 3D visualizations from Viser and embed them into static webpages. The process involves three main steps: exporting scene state, creating a client build, and hosting the visualization.

.. warning::

   This workflow is experimental and not yet polished. We're documenting it
   nonetheless, since we think it's quite useful! If you have suggestions or
   improvements, issues and PRs are welcome.


Step 1: Exporting Scene State
-----------------------------

You can export static or dynamic 3D data from a Viser scene using the scene
serializer. :func:`viser.ViserServer.get_scene_serializer` returns a serializer
object that can serialize the current scene state to a binary format.

Static Scene Export
~~~~~~~~~~~~~~~~~~~

For static 3D visualizations, :func:`viser.infra.StateSerializer.serialize` can be used to
save the scene state:

.. code-block:: python

   import viser
   from pathlib import Path

   server = viser.ViserServer()

   # Add objects to the scene via server.scene
   # For example:
   # server.scene.add_mesh(...)
   # server.scene.add_point_cloud(...)
   server.scene.add_box("/box", color=(255, 0, 0), dimensions=(1, 1, 1))

   # Serialize and save the scene state
   data = server.get_scene_serializer().serialize()  # Returns bytes
   Path("recording.viser").write_bytes(data)


As a suggestion, you can also add a button for exporting the scene state.
Clicking the button in your web browser will trigger a download of the
``.viser`` file.

.. code-block:: python

   import viser
   server = viser.ViserServer()

   # Add objects to the scene via server.scene.
   # For example:
   # server.scene.add_mesh(...)
   # server.scene.add_point_cloud(...)
   server.scene.add_box("/box", color=(255, 0, 0), dimensions=(1, 1, 1))

   save_button = server.gui.add_button("Save Scene")

   @save_button.on_click
   def _(event: viser.GuiEvent) -> None:
       assert event.client is not None
       event.client.send_file_download("recording.viser", server.get_scene_serializer().serialize())

   server.sleep_forever()

Dynamic Scene Export
~~~~~~~~~~~~~~~~~~~~

For dynamic visualizations with animation, you can create a "3D video" by
calling :meth:`StateSerializer.insert_sleep` between frames:

.. code-block:: python

   import viser
   import numpy as np
   from pathlib import Path

   server = viser.ViserServer()

   # Add objects to the scene via server.scene
   # For example:
   # server.scene.add_mesh(...)
   # server.scene.add_point_cloud(...)
   box = server.scene.add_box("/box", color=(255, 0, 0), dimensions=(1, 1, 1))

   # Create serializer.
   serializer = server.get_scene_serializer()

   num_frames = 100
   for t in range(num_frames):
       # Update existing scene objects or add new ones.
       box.position = (0.0, 0.0, np.sin(t / num_frames * 2 * np.pi))

       # Add a frame delay.
       serializer.insert_sleep(1.0 / 30.0)

   # Save the complete animation.
   data = serializer.serialize()  # Returns bytes
   Path("recording.viser").write_bytes(data)

.. note::
   Always add scene elements using :attr:`ViserServer.scene`, not :attr:`ClientHandle.scene`.

.. note::
   The ``.viser`` file is a binary format containing scene state data and is not meant to be human-readable.

Step 2: Creating a Viser Client Build
-------------------------------------

To serve the 3D visualization, you'll need two things:

1. The ``.viser`` file containing your scene data
2. A build of the Viser client

With Viser installed, create the Viser client build using the command-line tool:

.. code-block:: bash

   # View available options
   viser-build-client --help

   # Build to a specific directory
   viser-build-client --output-dir viser-client/


Step 3: Hosting
---------------

Directory Structure
~~~~~~~~~~~~~~~~~~~

For our hosting instructions, we're going to assume the following directory structure:

.. code-block::

    .
    ├── recordings/
    │   └── recording.viser    # Your exported scene data
    └── viser-client/
        ├── index.html         # Generated client files
        └── ...

This is just a suggestion; you can structure your files however you like.

Local Development Server
~~~~~~~~~~~~~~~~~~~~~~~~

For testing locally, you can use Python's built-in HTTP server:

.. code-block:: bash

    # Navigate to the parent directory containing both folders
    cd /path/to/parent/dir

    # Start the server (default port 8000)
    python -m http.server 8000

Then open your browser and navigate to:

* ``http://localhost:8000/viser-client/`` (default port)

This should show the a standard Viser client. To visualize the exported scene, you'll need to specify a URL via the ``?playbackPath=`` parameter:

* ``http://localhost:8000/viser-client/?playbackPath=http://localhost:8000/recordings/recording.viser``


GitHub Pages Deployment
~~~~~~~~~~~~~~~~~~~~~~~

To host your visualization on GitHub Pages:

1. Create a new repository or use an existing one
2. Create a ``gh-pages`` branch or enable GitHub Pages on your main branch
3. Push your directory structure to the repository:

   .. code-block:: bash

       git add recordings/ viser-client/
       git commit -m "Add Viser visualization"
       git push origin main  # or gh-pages

Your visualization will be available at: ``https://user.github.io/repo/viser-client/?playbackPath=https://user.github.io/repo/recordings/recording.viser``

You can embed this into other webpages using an HTML ``<iframe />`` tag.


Step 4: Setting the initial camera pose
-----------------------------------------------

Using Python
~~~~~~~~~~~~

The easiest way to set the initial camera pose is using :attr:`viser.ViserServer.initial_camera`
before serializing or calling :meth:`~viser.SceneApi.show`:

.. code-block:: python

   import viser

   server = viser.ViserServer()
   server.scene.add_box("/box", color=(255, 0, 0), dimensions=(1, 1, 1))

   # Set the initial camera pose.
   server.initial_camera.position = (2.0, -4.0, 1.0)
   server.initial_camera.look_at = (0.0, 0.0, 0.0)
   server.initial_camera.up = (0.0, 0.0, 1.0)

   # The initial camera is included when serializing.
   data = server.get_scene_serializer().serialize()

This sets the camera pose that will be used when the visualization first loads.
See :class:`viser.InitialCameraConfig` for all available options including
``fov``, ``near``, and ``far``.

Using URL Parameters
~~~~~~~~~~~~~~~~~~~~

You can also override the initial camera pose using URL parameters. This is
useful for fine-tuning the camera position after export.

To find the camera parameters, add a ``&logCamera`` parameter to the URL:

* ``http://localhost:8000/viser-client/?playbackPath=http://localhost:8000/recordings/recording.viser&logCamera``

Then, open your Javascript console. You should see the camera pose printed
whenever you move the camera. It should look something like this:

* ``&initialCameraPosition=2.216,-4.233,-0.947&initialCameraLookAt=-0.115,0.346,-0.192&initialCameraUp=0.329,-0.904,0.272&initialCameraFov=0.7854&initialCameraNear=0.01&initialCameraFar=1000``

You can then add this string to the URL to set the initial camera pose. URL
parameters take priority over the Python-configured initial camera.

Available URL parameters:

* ``initialCameraPosition`` - Camera position as ``x,y,z``
* ``initialCameraLookAt`` - Look-at target as ``x,y,z``
* ``initialCameraUp`` - Up direction as ``x,y,z``
* ``initialCameraFov`` - Field of view in radians
* ``initialCameraNear`` - Near clipping plane distance
* ``initialCameraFar`` - Far clipping plane distance
