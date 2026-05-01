"""Type conversion utilities for viser.

This module centralizes all type conversions between:
1. User Input → Python Internal State (normalize_*() functions)
2. Python Internal State → TypeScript/JSON (serialize_for_wire())
3. TypeScript/JSON → Python Internal State (deserialize_from_wire())
"""

from __future__ import annotations

import datetime
from typing import Any

import numpy as np
import numpy.typing as npt


# ============================================================================
# Stage 1: User Input → Python Internal State
# ============================================================================
# Semantic helper functions that accept flexible user input and produce
# canonical internal representations.


def normalize_rgb_color(
    value: tuple | list | np.ndarray,
) -> tuple[int, int, int]:
    """Normalize RGB color to canonical (int, int, int) format.

    Accepts:
    - (255, 128, 0) or [255, 128, 0] → (255, 128, 0)
    - (1.0, 0.5, 0.0) floats [0-1] → (255, 128, 0)
    - np.array([255, 128, 0]) → (255, 128, 0)

    Args:
        value: RGB color as tuple, list, or numpy array.

    Returns:
        Normalized RGB color as (int, int, int).
    """
    if isinstance(value, np.ndarray):
        assert value.shape == (3,), f"Expected shape (3,), got {value.shape}"

    rgb_fixed = tuple(
        int(v) if np.issubdtype(type(v), np.integer) else int(v * 255)
        for v in value
    )
    assert len(rgb_fixed) == 3, f"Expected 3 values, got {len(rgb_fixed)}"
    assert all(0 <= c <= 255 for c in rgb_fixed), f"Invalid RGB values: {rgb_fixed}"
    return rgb_fixed  # type: ignore


def normalize_rgba_color(
    value: tuple | list | np.ndarray,
) -> tuple[int, int, int, int]:
    """Normalize RGBA color to canonical (int, int, int, int) format.

    Accepts:
    - (255, 128, 0, 255) or [255, 128, 0, 255] → (255, 128, 0, 255)
    - (1.0, 0.5, 0.0, 1.0) floats [0-1] → (255, 128, 0, 255)
    - np.array([255, 128, 0, 255]) → (255, 128, 0, 255)

    Args:
        value: RGBA color as tuple, list, or numpy array.

    Returns:
        Normalized RGBA color as (int, int, int, int).
    """
    if isinstance(value, np.ndarray):
        assert value.shape == (4,), f"Expected shape (4,), got {value.shape}"

    rgba_fixed = tuple(
        int(v) if np.issubdtype(type(v), np.integer) else int(v * 255)
        for v in value
    )
    assert len(rgba_fixed) == 4, f"Expected 4 values, got {len(rgba_fixed)}"
    assert all(0 <= c <= 255 for c in rgba_fixed), f"Invalid RGBA values: {rgba_fixed}"
    return rgba_fixed  # type: ignore


def normalize_vector(
    value: tuple | list | np.ndarray, length: int
) -> tuple[float, ...]:
    """Normalize vector to canonical tuple[float, ...] format.

    Args:
        value: Vector as tuple, list, or numpy array.
        length: Expected length of the vector.

    Returns:
        Normalized vector as tuple of floats.
    """
    if isinstance(value, np.ndarray):
        assert value.shape == (length,), (
            f"Expected shape ({length},), got {value.shape}"
        )
    result = tuple(map(float, value))
    assert len(result) == length, f"Expected {length} values, got {len(result)}"
    return result


def colors_to_uint8(colors: np.ndarray) -> npt.NDArray[np.uint8]:
    """Convert intensity values to uint8.

    Assumes the range [0,1] for floats, and [0,255] for integers.
    Accepts any shape.

    Args:
        colors: Color array with any dtype.

    Returns:
        Color array as uint8.
    """
    if colors.dtype != np.uint8:
        if np.issubdtype(colors.dtype, np.floating):
            colors = np.clip(colors * 255.0, 0, 255).astype(np.uint8)
        if np.issubdtype(colors.dtype, np.integer):
            colors = np.clip(colors, 0, 255).astype(np.uint8)
    return colors


# ============================================================================
# Stage 2: Python Internal State → TypeScript/JSON
# ============================================================================


def serialize_for_wire(value: Any) -> Any:
    """Serialize Python value to JSON-compatible format for WebSocket transmission.

    This is handled automatically by the message infrastructure in infra/_messages.py
    via _prepare_for_serialization(). This function exists for documentation and
    potential future manual serialization needs.

    Conversions:
    - datetime.datetime → ISO 8601 string
    - datetime.date → ISO 8601 string
    - datetime.time → ISO 8601 string
    - np.ndarray → binary buffer (handled by msgspec)
    - tuple, primitives → pass through unchanged

    Args:
        value: Python value to serialize.

    Returns:
        JSON-serializable value.
    """
    # This is primarily handled by infra/_messages._prepare_for_serialization()
    # We keep this function for API completeness and documentation.
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat()
    return value


# ============================================================================
# Stage 3: TypeScript/JSON → Python Internal State
# ============================================================================


def deserialize_from_wire(
    value: Any,
    type_hint: Any,
    prop_name: str = "",
) -> Any:
    """Deserialize JSON value from client to Python internal representation.

    This handles conversion from JSON-serializable types back to rich Python types.
    Used for GUI update messages (GuiUpdateMessage) which bypass the message
    infrastructure.

    Conversions:
    - ISO 8601 string → datetime.datetime (timezone-naive)
    - ISO 8601 string → datetime.date
    - ISO 8601 string → datetime.time
    - number → int or float based on type hint
    - array → tuple or numpy array based on type hint

    Args:
        value: JSON value from client.
        type_hint: Expected Python type.
        prop_name: Name of the property (for context-dependent conversions).

    Returns:
        Deserialized Python value.
    """
    # Handle datetime types.
    if type_hint is datetime.datetime:
        if isinstance(value, str):
            dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            # Strip timezone info to avoid naive/aware mixing issues.
            return dt.replace(tzinfo=None)
        elif isinstance(value, (int, float)):
            # Backward compatibility: support old timestamp format.
            return datetime.datetime.fromtimestamp(value)
        elif isinstance(value, datetime.datetime):
            return value
        return value

    if type_hint is datetime.date:
        if isinstance(value, str):
            return datetime.date.fromisoformat(value)
        return value

    if type_hint is datetime.time:
        if isinstance(value, str):
            return datetime.time.fromisoformat(value)
        return value

    # Handle tuple patterns.
    if hasattr(type_hint, "__origin__") and hasattr(type_hint, "__args__"):
        origin = getattr(type_hint, "__origin__")
        args = getattr(type_hint, "__args__")

        if origin is tuple:
            # Handle tuple[T, ...] pattern (variable length).
            if len(args) == 2 and args[1] is ...:
                element_type = args[0]
                return tuple(
                    deserialize_from_wire(item, element_type, prop_name)
                    for item in value
                )

            # Handle fixed-size tuple like Tuple[float, float, float].
            elif len(args) > 0 and args[0] is not ...:
                if len(value) != len(args):
                    # Length mismatch - handle gracefully.
                    return tuple(
                        deserialize_from_wire(
                            item, args[min(i, len(args) - 1)], prop_name
                        )
                        for i, item in enumerate(value)
                    )
                return tuple(
                    deserialize_from_wire(item, arg_type, prop_name)
                    for arg_type, item in zip(args, value)
                )

    # Handle numpy arrays.
    if type_hint == npt.NDArray[np.float16]:
        return np.asarray(value).astype(np.float16)
    elif type_hint == npt.NDArray[np.float32]:
        return np.asarray(value).astype(np.float32)
    elif type_hint == npt.NDArray[np.float64]:
        return np.asarray(value).astype(np.float64)
    elif type_hint == npt.NDArray[np.uint8] and "color" in prop_name:
        return colors_to_uint8(np.asarray(value))
    elif isinstance(value, np.ndarray):
        return value

    return value
