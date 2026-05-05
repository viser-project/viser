"""Camera pose tracking

Monitor and read camera poses from connected clients in real-time.

This example demonstrates how to track camera movements and handle multiple connected clients. Camera pose tracking is essential for applications like telepresence, collaborative visualization, or recording user viewpoints for replay.

**Key features:**

* :meth:`viser.ViserServer.on_client_connect` for detecting new client connections
* :meth:`viser.CameraHandle.on_update` for real-time camera movement callbacks
* :attr:`viser.CameraHandle.wxyz` and :attr:`viser.CameraHandle.position` for pose data
* :attr:`viser.CameraHandle.fov` and :attr:`viser.CameraHandle.aspect` for camera parameters

The example shows how to access camera intrinsics (FOV, aspect ratio, canvas size) and extrinsics (position, orientation) from each connected client, enabling synchronized multi-user experiences or camera-based interactions.
"""

import time

import viser

server = viser.ViserServer()
server.scene.world_axes.visible = True


@server.on_client_connect
def _(client: viser.ClientHandle) -> None:
    print("new client!")

    # This will run whenever we get a new camera!
    @client.camera.on_update
    def _(_: viser.CameraHandle) -> None:
        print(f"New camera on client {client.client_id}!")

    # Show the client ID in the GUI.
    gui_info = client.gui.add_text("Client ID", initial_value=str(client.client_id))
    gui_info.disabled = True


while True:
    # Get all currently connected clients.
    clients = server.get_clients()
    print("Connected client IDs", clients.keys())

    for id, client in clients.items():
        print(f"Camera pose for client {id}")
        print(f"\twxyz: {client.camera.wxyz}")
        print(f"\tposition: {client.camera.position}")
        print(f"\tfov: {client.camera.fov}")
        print(f"\taspect: {client.camera.aspect}")
        print(f"\tlast update: {client.camera.update_timestamp}")
        print(
            f"\tcanvas size: {client.camera.image_width}x{client.camera.image_height}"
        )

    time.sleep(2.0)
