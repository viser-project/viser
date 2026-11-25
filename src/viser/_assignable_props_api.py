from __future__ import annotations

import abc
import functools
from typing import (
    Any,
    Dict,
    Generic,
    Protocol,
    TypeVar,
    Union,
    cast,
)

import numpy as np
import numpy.typing as npt
from typing_extensions import get_args, get_origin, get_type_hints

# Type variable for props.


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
        elif np.issubdtype(colors.dtype, np.integer):
            colors = np.clip(colors, 0, 255).astype(np.uint8)
    return colors


TVector = TypeVar("TVector", bound=tuple)


def cast_vector(vector: TVector | np.ndarray, length: int) -> TVector:
    # Arity is checked for EVERY input form: tuples/lists used to pass
    # through unchecked, so a 2-tuple handed to a 3-vector API silently
    # desynced from the client's fixed component count.
    if isinstance(vector, np.ndarray):
        if vector.shape != (length,):
            raise ValueError(
                f"Expected vector of shape {(length,)}, but got {vector.shape} instead"
            )
        # Much faster than converting numpy scalars one at a time.
        vector = cast(TVector, vector.tolist())
    elif len(vector) != length:
        raise ValueError(
            f"Expected vector of length {length}, but got {len(vector)} instead"
        )
    return cast(TVector, tuple([float(v) for v in vector]))


def array_snapshot(array: np.ndarray) -> np.ndarray:
    """Returns a private, read-only, C-contiguous copy of an array.

    Snapshots are immutable, so a single one is shared between a handle's props
    and the messages queued for the wire. Handles replace their snapshot on
    assignment instead of writing into it, and hand out a writable copy the
    first time user code reads the property (`props_getattr()`)."""
    out = np.array(array, copy=True, order="C", subok=False)
    out.flags.writeable = False
    return out


def arrays_equal(a: np.ndarray, b: np.ndarray) -> bool:
    """`np.array_equal()`, but exits early. Arrays that are being updated
    usually differ everywhere, so there's no need to scan all of them (and
    allocate a mask for the result)."""
    if a.shape != b.shape:
        return False
    if a.ndim == 0 or a.size == 0:
        return bool(np.array_equal(a, b))
    rows = a.shape[0]
    rows_per_chunk = max(1, 4096 * rows // a.size)
    start = 0
    while start < rows:
        if not (
            a[start : start + rows_per_chunk] == b[start : start + rows_per_chunk]
        ).all():
            return False
        start += rows_per_chunk
        rows_per_chunk = min(rows_per_chunk * 4, max(1, (1 << 18) * rows // a.size))
    return True


@functools.lru_cache(maxsize=None)
def _get_prop_hints(props_cls: type) -> Dict[str, Any]:
    """Property type hints. Resolving these is expensive, so it's done once per
    props class rather than once per handle."""
    return get_type_hints(props_cls)


_property_setters: Dict[type, Dict[str, Any]] = {}


def _get_property_setter(cls: type, name: str) -> Any:
    """Setter for the `@property` with a given name, or `None` if there isn't
    one."""
    setters = _property_setters.setdefault(cls, {})
    try:
        return setters[name]
    except KeyError:
        prop = getattr(cls, name, None)
        setters[name] = prop.fset if isinstance(prop, property) else None
        return setters[name]


_NDARRAY_DTYPES: Dict[Any, Any] = {
    npt.NDArray[dtype]: dtype  # type: ignore
    for dtype in (
        np.float16,
        np.float32,
        np.float64,
        np.uint8,
        np.uint16,
        np.uint32,
        np.int32,
    )
}


class AssignablePropsBase(Generic[TImpl]):
    """Base class for all API objects with assignable properties."""

    _impl: TImpl

    def __init__(self, impl: TImpl):
        # Make sure arrays are copied to avoid shared references. Arrays that
        # are already immutable snapshots don't need another copy; see
        # `array_snapshot()`.
        for k, v in vars(impl.props).items():
            if isinstance(v, np.ndarray) and v.flags.writeable:
                setattr(impl.props, k, array_snapshot(v))

        # Store the implementation object.
        self._impl = impl

    def _cast_value_recursive(self, hint: Any, value: Any, prop_name: str) -> Any:
        """Recursively cast values to match type hints, handling arrays and tuples."""
        # Handle numpy arrays. This may or may not alias the input.
        if value is not None and get_origin(hint) is Union:
            # Optional[NDArray[...]].
            non_none = [a for a in get_args(hint) if a is not type(None)]
            if len(non_none) == 1:
                hint = non_none[0]
        dtype = _NDARRAY_DTYPES.get(hint)
        if dtype is not None:
            if dtype is np.uint8 and "color" in prop_name:
                return colors_to_uint8(np.asarray(value))
            return np.asarray(value, dtype=dtype)
        if isinstance(value, np.ndarray):
            return value

        # Handle tuple[T, ...] pattern.
        if (
            isinstance(value, tuple)
            and hasattr(hint, "__origin__")
            and hint.__origin__ is tuple
            and hasattr(hint, "__args__")
            and len(hint.__args__) == 2
            and hint.__args__[1] is ...
        ):
            element_type = hint.__args__[0]
            items = tuple(
                self._cast_value_recursive(element_type, item, prop_name)
                for item in value
            )
            return tuple(
                array_snapshot(v) if isinstance(v, np.ndarray) else v for v in items
            )

        return value

    @property
    def _prop_hints(self) -> Dict[str, Any]:
        return _get_prop_hints(type(self._impl.props))

    @abc.abstractmethod
    def _queue_update(self, name: str, value: Any) -> None:
        """Queue an update message with the property change."""

    def _on_prop_assigned(self, name: str) -> None:
        """Hook called after a props field is assigned and its update is queued.
        Subclasses can override to enforce cross-field invariants (e.g. keeping
        an array's dtype in sync with another field). No-op by default."""


def props_setattr(self, name: str, value: Any) -> None:
    if name == "_impl":
        return object.__setattr__(self, name, value)

    prop_setter = _get_property_setter(type(self), name)
    is_prop_hint = prop_setter is None and name in self._prop_hints

    # Reject property writes after the handle has been removed. This prevents
    # stale update messages from being queued against a no-longer-registered
    # entity, which would otherwise re-introduce it on the client (ghost
    # entity) because the client blindly processes incoming updates. Guard
    # both the @property.setter path (e.g. `value` on GUI input handles) and
    # the _prop_hints path (generic props forwarded to _queue_update).
    if (prop_setter is not None or is_prop_hint) and self._impl.removed:
        raise RuntimeError(
            f"Cannot assign to {name!r} on a removed {type(self).__name__}."
        )

    if prop_setter is not None:
        prop_setter(self, value)
        return

    # Try to handle as a props field.
    if is_prop_hint:
        # Handle type casting (arrays, tuples of arrays, etc.).
        raw_value = value
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
                # If the caller is assigning the array that we handed out, it
                # may have been modified in-place (`handle.points += 1.0`) and
                # there's nothing left to compare against.
                if raw_value is not current_value and arrays_equal(
                    current_value, value
                ):
                    return

            # Store and queue one immutable snapshot. It must not alias the
            # caller's array, which the caller may mutate after assignment
            # (e.g. an animation loop reusing one buffer).
            if (
                isinstance(raw_value, np.ndarray)
                and value is not raw_value
                and value.base is None
                and value.flags.c_contiguous
                and value.flags.owndata
            ):
                # Casting already produced a fresh array.
                value.flags.writeable = False
            else:
                value = array_snapshot(value)
            setattr(self._impl.props, name, value)
            queued: Any = value
        else:
            # Non-array properties (immutable / already a fresh cast).
            setattr(self._impl.props, name, value)
            queued = value
    else:
        return object.__setattr__(self, name, value)

    self._queue_update(name, queued)
    self._on_prop_assigned(name)


def props_getattr(self, name: str) -> Any:
    # This only works because *Props dataclass fields never have defaults:
    # a field default would become a class attribute on the handle (which
    # inherits the props dataclass for typing), and normal attribute lookup
    # would find it before __getattr__ is consulted -- reads would return
    # the default forever instead of the live value. Enforced by
    # tests/test_handle_prop_reads.py.
    if name in self._prop_hints:
        value = getattr(self._impl.props, name)
        if isinstance(value, np.ndarray) and not value.flags.writeable:
            # Stored arrays are snapshots shared with queued messages. User code
            # gets a private copy, which stays stable across reads.
            value = value.copy()
            setattr(self._impl.props, name, value)
        return value
    else:
        raise AttributeError(
            f"'{self.__class__.__name__}' object has no attribute '{name}'"
        )


AssignablePropsBase.__setattr__ = props_setattr  # type: ignore
AssignablePropsBase.__getattr__ = props_getattr  # type: ignore
