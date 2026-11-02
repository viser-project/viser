"""Regression tests for COLMAP binary image names and record alignment."""

import struct
from pathlib import Path
from typing import List, Tuple

import numpy as np
import pytest

from viser.extras.colmap import read_images_binary


def _write_images_binary(
    path: Path,
    records: List[Tuple[bytes, List[Tuple[float, float, int]]]],
) -> None:
    with path.open("wb") as fid:
        fid.write(struct.pack("<Q", len(records)))
        for image_id, (name, points) in enumerate(records, start=1):
            fid.write(
                struct.pack(
                    "<idddddddi",
                    image_id,
                    1.0,
                    0.0,
                    0.0,
                    0.0,
                    image_id + 0.25,
                    -1.5,
                    3.0,
                    image_id + 10,
                )
            )
            fid.write(name + b"\x00")
            fid.write(struct.pack("<Q", len(points)))
            for x, y, point3D_id in points:
                fid.write(struct.pack("<ddq", x, y, point3D_id))


@pytest.mark.parametrize(
    "name", ["image.png", "café.png", "场景.png", "😀.png", "场景😀.png"]
)
def test_read_images_binary_utf8_name(tmp_path: Path, name: str) -> None:
    path = tmp_path / "images.bin"
    _write_images_binary(
        path, [(name.encode("utf-8"), [(1.25, -2.5, 123), (3, 4, -1)])]
    )

    images = read_images_binary(path)

    assert list(images) == [1]
    assert images[1].name == name
    np.testing.assert_array_equal(images[1].xys, [[1.25, -2.5], [3, 4]])
    np.testing.assert_array_equal(images[1].point3D_ids, [123, -1])


def test_read_images_binary_multiple_records(tmp_path: Path) -> None:
    path = tmp_path / "images.bin"
    records = [
        ("image.png", [(1.25, -2.5, 123), (3.0, 4.0, -1)]),
        ("café.png", []),
        ("场景.png", [(5.5, 6.25, 2**40), (7.0, 8.0, -1), (9.0, 10.0, 456)]),
        ("场景😀.png", [(-11.5, 12.25, 789)]),
    ]
    _write_images_binary(
        path, [(name.encode("utf-8"), points) for name, points in records]
    )

    images = read_images_binary(path)

    assert list(images) == [1, 2, 3, 4]
    for image_id, (name, points) in enumerate(records, start=1):
        image = images[image_id]
        assert image.id == image_id
        assert image.name == name
        assert image.camera_id == image_id + 10
        np.testing.assert_array_equal(image.qvec, [1, 0, 0, 0])
        np.testing.assert_array_equal(image.tvec, [image_id + 0.25, -1.5, 3])
        np.testing.assert_array_equal(
            image.xys, np.array([(x, y) for x, y, _ in points]).reshape(-1, 2)
        )
        np.testing.assert_array_equal(
            image.point3D_ids, [point3D_id for _, _, point3D_id in points]
        )


@pytest.mark.parametrize("name", [b"bad\xff.png", b"bad\xc3.png", b"bad\xc3\x28.png"])
def test_read_images_binary_rejects_invalid_utf8(tmp_path: Path, name: bytes) -> None:
    path = tmp_path / "images.bin"
    _write_images_binary(path, [(name, [])])

    with pytest.raises(UnicodeDecodeError):
        read_images_binary(path)
