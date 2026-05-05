import sys

import imageio.v3 as iio
import numpy as np

from viser._image_encoding import cv2_imencode_with_fallback


def test_image_encode_png(monkeypatch) -> None:
    image = np.random.randint(0, 256, (100, 100, 3), dtype=np.uint8)
    bytes_cv2 = cv2_imencode_with_fallback(
        "png", image, jpeg_quality=None, channel_ordering="rgb"
    )
    monkeypatch.setitem(sys.modules, "cv2", None)
    bytes_no_cv2 = cv2_imencode_with_fallback(
        "png", image, jpeg_quality=None, channel_ordering="rgb"
    )
    assert bytes_cv2 != bytes_no_cv2, (
        "Expected different byte outputs for PNG encoding with and without cv2."
    )
    np.testing.assert_array_equal(
        iio.imread(bytes_cv2, extension=".png"),
        iio.imread(bytes_no_cv2, extension=".png"),
    )


def test_image_encode_jpeg_quality_75(monkeypatch) -> None:
    image = np.random.randint(0, 256, (100, 100, 3), dtype=np.uint8)
    bytes_cv2 = cv2_imencode_with_fallback(
        "jpeg", image, jpeg_quality=75, channel_ordering="rgb"
    )
    monkeypatch.setitem(sys.modules, "cv2", None)
    bytes_no_cv2 = cv2_imencode_with_fallback(
        "jpeg", image, jpeg_quality=75, channel_ordering="rgb"
    )
    np.testing.assert_array_equal(
        iio.imread(bytes_cv2, extension=".jpeg"),
        iio.imread(bytes_no_cv2, extension=".jpeg"),
    )


def test_image_encode_jpeg_no_quality(monkeypatch) -> None:
    image = np.random.randint(0, 256, (100, 100, 3), dtype=np.uint8)
    bytes_cv2 = cv2_imencode_with_fallback(
        "jpeg", image, jpeg_quality=None, channel_ordering="rgb"
    )
    monkeypatch.setitem(sys.modules, "cv2", None)
    bytes_no_cv2 = cv2_imencode_with_fallback(
        "jpeg", image, jpeg_quality=None, channel_ordering="rgb"
    )
    np.testing.assert_array_equal(
        iio.imread(bytes_cv2, extension=".jpeg"),
        iio.imread(bytes_no_cv2, extension=".jpeg"),
    )
