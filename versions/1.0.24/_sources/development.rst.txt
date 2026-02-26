Development
===========

In this note, we outline current practices, tools, and workflows for ``viser``
development. We assume that the repository is cloned to ``~/viser``.

Python install
--------------

We recommend using `uv <https://docs.astral.sh/uv/>`_ for Python development.

.. code-block:: bash

   # Install uv (if not already installed).
   curl -LsSf https://astral.sh/uv/install.sh | sh

   # Run any example directly (uv handles dependencies automatically).
   cd ~/viser
   uv run --extra examples python examples/00_getting_started/00_hello_world.py

Linting, formatting, type-checking
----------------------------------

For code quality, we use ``pyright`` for type checking and ``ruff`` for linting
and formatting.

.. code-block:: bash

   # Check static types.
   uv run --extra dev pyright

   # Lint and auto-fix issues.
   uvx ruff check --fix

   # Format code.
   uvx ruff format

Running tests
-------------

.. code-block:: bash

   uv run --extra dev pytest

Client-Server Synchronization
-----------------------------

The ``viser`` frontend and backend communicate via a shared set of message definitions and enforce
version compatibility to prevent security issues and crashes from mismatched versions.

Message Definitions
^^^^^^^^^^^^^^^^^^^

- On the server, messages are defined as Python dataclasses in
  ``~/viser/src/viser/_messages.py``.
- On the client, these are defined as TypeScript interfaces in
  ``~/viser/src/viser/client/src/WebsocketMessages.ts``.

There is a 1:1 correspondence between the Python dataclasses and the TypeScript interfaces.

Version Compatibility
^^^^^^^^^^^^^^^^^^^^^

Viser implements strict version compatibility checking between client and server:

1. The client includes its version in the WebSocket subprotocol name (e.g., ``viser-v0.2.23``)
2. The server extracts the client version from the subprotocol and compares it with its own version
3. If versions don't match, the connection is rejected with code 1002 (protocol error) and an informative message
4. This ensures that client and server components always operate with compatible functionality

Synchronization Script
^^^^^^^^^^^^^^^^^^^^^^

To synchronize message definitions and version information between the Python backend and TypeScript frontend,
use the ``sync_client_server.py`` script:

.. code-block:: bash

   cd ~/viser
   uv run python sync_client_server.py --sync-messages --sync-version

This script:

1. Generates TypeScript interfaces from Python dataclasses
2. Creates the VersionInfo.ts file with the current server version
3. Formats the generated files using prettier

Always run this script after:

- Changing message definitions in ``_messages.py``
- Updating the version in ``__init__.py``

Client development
------------------

For client development, we can start by launching a relevant Python script. The
examples are a good place to start:

.. code-block:: bash

   cd ~/viser/examples
   uv run python 05_camera_commands.py

When a ``viser`` script is launched, two URLs will be printed:

- An HTTP URL, like ``http://localhost:8080``, which can be used to open a
  *pre-built* version of the React frontend.
- A websocket URL, like ``ws://localhost:8080``, which client applications can
  connect to.

If changes to the client source files are detected on startup, ``viser`` will
re-build the client automatically. This is okay for quick changes, but for
faster iteration we can also launch a development version of the frontend, which
will reflect changes we make to the client source files
(``~/viser/src/viser/client/src``) without a full build. This requires a few more
steps.

**Installing dependencies.**

1. `Install nodejs. <https://nodejs.dev/en/download/package-manager>`_
2. Install dependencies.

   .. code-block:: bash

      cd ~/viser/src/viser/client
      npm install

**Launching client.**

To launch the client, we can run:

.. code-block:: bash

   cd ~/viser/src/viser/client
   npm run dev

from the ``viser/src/viser/client`` directory. After opening the client in a web
browser, the websocket server address typically needs to be updated in the
"Server" tab.

**Formatting.**

We use `prettier <https://prettier.io/docs/en/install.html>`_. This can be run via
one of:

- ``prettier -w .``
- ``npx prettier -w .``

from ``~/viser/src/viser/client``.
