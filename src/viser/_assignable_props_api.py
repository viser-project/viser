from __future__ import annotations

import abc
from functools import cached_property
from typing import Any, Dict, Generic, Protocol, TypeVar, get_type_hints

import numpy as np

from . import _casts

# Type variable for props.


class HasProps(Protocol):
    props: Any  # One of the `*Props` objects in _messages.py.


TImpl = TypeVar("TImpl", bound=HasProps)


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

    def _cast_array_dtypes(
        self, prop_hints: Dict[str, Any], prop_name: str, value: np.ndarray
    ) -> np.ndarray:
        """Helper to cast array values to the correct data type."""
        return _casts.deserialize_from_wire(value, prop_hints[prop_name], prop_name)

    @cached_property
    def _prop_hints(self) -> Dict[str, Any]:
        return get_type_hints(type(self._impl.props))

    @abc.abstractmethod
    def _queue_update(self, name: str, value: Any) -> None:
        """Queue an update message with the property change."""


def props_setattr(self, name: str, value: Any) -> None:
    if name == "_impl":
        return object.__setattr__(self, name, value)

    # If it's a property with a setter, use the setter.
    prop = getattr(self.__class__, name, None)
    if isinstance(prop, property) and prop.fset is not None:
        prop.fset(self, value)
        return

    # Try to handle as a props field.
    if name in self._prop_hints:
        # Handle type casting (arrays, tuples of arrays, etc.).
        value = self._cast_value_recursive(self._prop_hints[name], value, name)
        current_value = getattr(self._impl.props, name)

        # Skip update if value hasn't changed.
        try:
            hash(current_value)
            if current_value == value:
                return
        except TypeError:
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
