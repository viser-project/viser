"""Hello world

The simplest possible viser program: creates a server and adds a red sphere.

This demonstrates the two essential steps to get started with viser:

1. Create a :class:`viser.ViserServer` instance, which starts a web server at http://localhost:8080
2. Add 3D content using the scene API, like :meth:`viser.SceneApi.add_icosphere`

The server runs indefinitely until interrupted with Ctrl+C.
"""

import time

import viser


def main():
    server = viser.ViserServer()
    server.scene.add_icosphere(
        name="/hello_sphere",
        radius=0.5,
        color=(255, 0, 0),  # Red
        position=(0.0, 0.0, 0.0),
    )

    print("Open your browser to http://localhost:8080")
    print("Press Ctrl+C to exit")

    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    main()
