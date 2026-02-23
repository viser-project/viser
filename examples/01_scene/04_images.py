"""Images

Display background images and 3D image textures in the scene.

Display background images and 3D image textures positioned in world space.

**Features:**

* :meth:`viser.SceneApi.set_background_image` for background images behind the scene
* :meth:`viser.SceneApi.add_image` for 3D-positioned image planes in world coordinates
* Static images from files and dynamic procedural content
* Image positioning, scaling, and orientation in 3D space

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 01_scene/04_images.py  # With viser installed.
"""

import time
from pathlib import Path

import imageio.v3 as iio
import numpy as np

import viser


def main() -> None:
    server = viser.ViserServer()

    # Add a background image.
    server.scene.set_background_image(
        iio.imread(Path(__file__).parent / "../assets/Cal_logo.png"),
        format="png",
    )

    # Add main image.
    server.scene.add_image(
        "/img",
        iio.imread(Path(__file__).parent / "../assets/Cal_logo.png"),
        4.0,
        4.0,
        format="png",
        wxyz=(1.0, 0.0, 0.0, 0.0),
        position=(2.0, 2.0, 0.0),
    )
    while True:
        server.scene.add_image(
            "/noise",
            np.random.randint(0, 256, size=(400, 400, 3), dtype=np.uint8),
            4.0,
            4.0,
            format="jpeg",
            wxyz=(1.0, 0.0, 0.0, 0.0),
            position=(2.0, 2.0, -1e-2),
        )
        time.sleep(0.2)


if __name__ == "__main__":
    main()
