"""Per-client scene state

Mix shared (broadcast) scene elements with per-client ones, including
per-client overrides of shared nodes.

**Features:**

* :attr:`viser.ClientHandle.scene` for elements only one client sees
* Shadowing: a client-scoped node with a shared node's name replaces it for
  that client only, and the shared node (with its latest state) returns when
  the client-scoped variant is removed
* Scope-local removal: per-client annotations survive shared-node removal
  until their own scope removes them
"""

from __future__ import annotations

import time

import viser

server = viser.ViserServer()

# A shared box that every client sees, animated by the server.
shared_box = server.scene.add_box(
    "/box", dimensions=(0.5, 0.5, 0.5), color=(200, 60, 60)
)


@server.on_client_connect
def _(client: viser.ClientHandle) -> None:
    # Per-client GUI + scene state. Everything created through `client.` is
    # visible to this client alone and is rebuilt here on reconnect (client
    # state is ephemeral -- see the ClientHandle docs).
    highlight = client.gui.add_checkbox("Highlight box (only me)", False)
    annotate = client.gui.add_checkbox("Annotate box (only me)", False)

    highlight_handle: viser.BoxHandle | None = None
    annotation_handle = None

    @highlight.on_update
    def _(_) -> None:
        nonlocal highlight_handle
        if highlight.value:
            # Same name as the shared box: this client-scoped variant
            # SHADOWS the shared one for this client only. Other clients
            # keep seeing the server's red box, and server updates keep
            # accumulating in the hidden variant.
            highlight_handle = client.scene.add_box(
                "/box", dimensions=(0.55, 0.55, 0.55), color=(60, 200, 80)
            )
        elif highlight_handle is not None:
            # Un-shadow: the shared box reappears with its LATEST state.
            highlight_handle.remove()
            highlight_handle = None

    @annotate.on_update
    def _(_) -> None:
        nonlocal annotation_handle
        if annotate.value:
            # A per-client child under the shared node. If the server ever
            # removes /box, this annotation survives (anchored where the box
            # was) until this client removes it -- removal never reaches
            # across scopes.
            annotation_handle = client.scene.add_label(
                "/box/note", text=f"client {client.client_id}'s note"
            )
        elif annotation_handle is not None:
            annotation_handle.remove()
            annotation_handle = None


while True:
    # Server-side animation of the shared box; shadowing clients don't see
    # these updates until they un-shadow.
    shared_box.position = (0.0, 0.0, 0.4 + 0.2 * (time.time() % 1.0))
    time.sleep(0.05)
