from __future__ import annotations

import abc
from functools import cached_property
from typing import Any, Dict, Generic, Protocol, TypeVar, get_type_hints

import numpy as np
import numpy.typing as npt

# Type variable for props


class HasProps(Protocol):
    props: Any  # One of the `*Props` objects in _messages.py.
    removed: bool  # Lifecycle flag; see AssignablePropsBase guard below.


TImpl = TypeVar("TImpl", bound=HasProps)


def colors_to_uint8(colors: np.ndarray) -> npt.NDArray[np.uint8]:
    """Convert intensity values to uint8. We assume the range [0,1] for floats, and
    [0,255] for integers. Accepts any shape."""
    if colors.dtype != np.uint8:
        if np.issubdtype(colors.dtype, np.floating):
            colors = np.clip(colors * 255.0, 0, 255).astype(np.uint8)
        if np.issubdtype(colors.dtype, np.integer):
            colors = np.clip(colors, 0, 255).astype(np.uint8)
    return colors


class AssignablePropsBase(Generic[TImpl]):
    """Base class for all API objects with assignable properties."""

    _impl: TImpl

    def __init__(self, impl: TImpl):
        # Make sure arrays are copied to avoid shared references.
        # This will also make sure that our `np.array_equal` checks below work
        # correctly.
        for k, v in vars(impl.props).items():
            if isinstance(v, np.ndarray):
                setattr(impl.props, k, v.copy())

        # Store the implementation object.
        self._impl = impl

    def _cast_value_recursive(self, hint: Any, value: Any, prop_name: str) -> Any:
        """Recursively cast values to match type hints, handling arrays and tuples."""
        # Handle numpy arrays
        if hint == npt.NDArray[np.float16]:
            return np.asarray(value).astype(np.float16)
        elif hint == npt.NDArray[np.float32]:
            return np.asarray(value).astype(np.float32)
        elif hint == npt.NDArray[np.float64]:
            return np.asarray(value).astype(np.float64)
        elif hint == npt.NDArray[np.uint8] and "color" in prop_name:
            return colors_to_uint8(value)
        if isinstance(value, np.ndarray):
            return value

        # Handle tuple[T, ...] pattern
        if (
            isinstance(value, tuple)
            and hasattr(hint, "__origin__")
            and hint.__origin__ is tuple
            and hasattr(hint, "__args__")
            and len(hint.__args__) == 2
            and hint.__args__[1] is ...
        ):
            element_type = hint.__args__[0]
            return tuple(
                self._cast_value_recursive(element_type, item, prop_name)
                for item in value
            )

        return value

    def _cast_array_dtypes(
        self, prop_hints: Dict[str, Any], prop_name: str, value: np.ndarray
    ) -> np.ndarray:
        """Helper to cast array values to the correct data type."""
        return self._cast_value_recursive(prop_hints[prop_name], value, prop_name)

    @cached_property
    def _prop_hints(self) -> Dict[str, Any]:
        return get_type_hints(type(self._impl.props))

    @abc.abstractmethod
    def _queue_update(self, name: str, value: Any) -> None:
        """Queue an update message with the property change."""


def props_setattr(self, name: str, value: Any) -> None:
    if name == "_impl":
        return object.__setattr__(self, name, value)

    prop = getattr(self.__class__, name, None)
    prop_setter = (
        prop.fset if isinstance(prop, property) and prop.fset is not None else None
    )
    is_prop_hint = name in self._prop_hints

    # Reject property writes after the handle has been removed. This prevents
    # stale update messages from being queued against a no-longer-registered
    # entity, which would otherwise re-introduce it on the client (ghost
    # entity) because the client blindly processes incoming updates. Guard
    # both the @property.setter path (e.g. `value` on GUI input handles) and
    # the _prop_hints path (generic props forwarded to _queue_update).
    if (prop_setter is not None or is_prop_hint) and self._impl.removed:
        raise RuntimeError(
            f"Cannot assign to {name!r} on a removed "
            f"{type(self).__name__}."
        )

    if prop_setter is not None:
        prop_setter(self, value)
        return

    # Try to handle as a props field.
    if is_prop_hint:
        # Handle type casting (arrays, tuples of arrays, etc.).
        value = self._cast_value_recursive(self._prop_hints[name], value, name)
        current_value = getattr(self._impl.props, name)

        # Skip update if value hasn't changed.
        try:
            hash(current_value)
            if current_value == value:
                return
        except (TypeError, ValueError):
            pass

        # Update the value based on type.
        if isinstance(value, np.ndarray):
            if hasattr(current_value, "dtype"):
                # Ensure consistent dtype.
                if value.dtype != current_value.dtype:
                    value = value.astype(current_value.dtype)
                if np.array_equal(current_value, value):
                    return

            # In-place update for same shape arrays.
            if hasattr(current_value, "shape") and value.shape == current_value.shape:
                current_value[:] = value
            else:
                setattr(self._impl.props, name, value.copy())
        else:
            # Non-array properties
            setattr(self._impl.props, name, value)
    else:
        return object.__setattr__(self, name, value)

    self._queue_update(name, value)


def props_getattr(self, name: str) -> Any:
    if name in self._prop_hints:
        return getattr(self._impl.props, name)
    else:
        raise AttributeError(
            f"'{self.__class__.__name__}' object has no attribute '{name}'"
        )


AssignablePropsBase.__setattr__ = props_setattr  # type: ignore
AssignablePropsBase.__getattr__ = props_getattr  # type: ignore
