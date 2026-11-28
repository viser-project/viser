"""Message type definitions. For synchronization with the TypeScript definitions, see
`_typescript_interface_gen.py.`"""

from __future__ import annotations

import abc
import dataclasses
import functools
import warnings
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    ClassVar,
    Dict,
    FrozenSet,
    List,
    Optional,
    Tuple,
    Type,
    TypeVar,
    Union,
    cast,
)

import msgspec.msgpack
import numpy as np
from typing_extensions import get_args, get_origin, get_type_hints

if TYPE_CHECKING:
    from ._infra import ClientId
else:
    ClientId = Any


def _prepare_for_deserialization(value: Any, annotation: Type) -> Any:
    # If annotated as a float but we got an integer, cast to float. These
    # are both `number` in Javascript.
    if annotation is float:
        return float(value)
    elif annotation is int:
        return int(value)
    elif get_origin(annotation) is Union:
        # Handle Optional[T] and Union[T1, T2, ...] by finding the best
        # matching inner type. This avoids needing a blanket lists_to_tuple()
        # pass over the entire deserialized message.
        if value is None:
            return None
        args = get_args(annotation)
        for arg in args:
            if arg is type(None):
                continue
            if get_origin(arg) is tuple and isinstance(value, (list, tuple)):
                return _prepare_for_deserialization(value, arg)
            if arg is float and isinstance(value, (int, float)):
                return float(value)
            if arg is int and isinstance(value, int):
                return int(value)
        return value
    elif get_origin(annotation) is tuple:
        out = []
        args = get_args(annotation)
        if len(args) >= 2 and args[1] == ...:
            args = (args[0],) * len(value)
        elif len(value) != len(args):
            warnings.warn(f"[viser] {value} does not match annotation {annotation}")
            return value

        for i, v in enumerate(value):
            out.append(
                # Hack to be OK with wrong type annotations.
                # https://github.com/nerfstudio-project/nerfstudio/pull/1805
                _prepare_for_deserialization(v, args[i]) if i < len(args) else v
            )
        return tuple(out)
    return value


def _deserialize_float(value: Any) -> Any:
    return value if type(value) is float else float(value)


def _deserialize_int(value: Any) -> Any:
    return value if type(value) is int else int(value)


def _identity(value: Any) -> Any:
    return value


def _make_deserialize_converter(annotation: Any) -> Callable[[Any], Any]:
    if annotation is float:
        return _deserialize_float
    if annotation is int:
        return _deserialize_int
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin is tuple and args and all(a is float for a in args):
        length = len(args)

        def deserialize_float_tuple(value: Any) -> Any:
            if len(value) != length:
                return _prepare_for_deserialization(value, annotation)
            return tuple([v if type(v) is float else float(v) for v in value])

        return deserialize_float_tuple
    if origin is tuple or origin is Union:
        return lambda value: _prepare_for_deserialization(value, annotation)
    return _identity


@functools.lru_cache(maxsize=None)
def _deserialize_converters(cls: Type[Any]) -> Dict[str, Callable[[Any], Any]]:
    return {
        k: _make_deserialize_converter(v) for k, v in get_type_hints_cached(cls).items()
    }


def _flat_byte_view(array: np.ndarray) -> memoryview:
    """View an array's contents as flat, C-ordered bytes. Copies only if the
    array isn't C-contiguous."""
    if array.dtype.hasobject:
        return memoryview(array.tobytes())
    return np.ascontiguousarray(array).reshape(-1).view(np.uint8).data


_PASSTHROUGH_TYPES = frozenset({str, int, float, bool, bytes, type(None)})
"""Exact types that msgpack encodes as-is."""

_DYNAMIC_TYPES = _PASSTHROUGH_TYPES | {tuple, list, dict}

Converter = Callable[[Any, Optional[List[memoryview]]], Any]


def _serialize_dynamic(value: Any, binary_buffers: Optional[List[memoryview]]) -> Any:
    """Serialize from the value's runtime type. Equivalent to
    ``_prepare_for_serialization()`` with an annotation that has no bearing on
    scalar coercion (``Any``, unions, ...), with fast paths for common types."""
    t = type(value)
    if t in _PASSTHROUGH_TYPES:
        return value
    if t is tuple or t is list:
        return [
            v
            if type(v) in _PASSTHROUGH_TYPES
            else _serialize_dynamic(v, binary_buffers)
            for v in value
        ]
    if t is dict:
        return {
            k: v
            if type(v) in _PASSTHROUGH_TYPES
            else _serialize_dynamic(v, binary_buffers)
            for k, v in value.items()
        }
    return _prepare_for_serialization(value, Any, binary_buffers)


def _serialize_float(value: Any, _: Optional[List[memoryview]]) -> Any:
    return value if type(value) is float else float(value)


def _serialize_int(value: Any, _: Optional[List[memoryview]]) -> Any:
    if type(value) is int:
        return value
    # Lenient about wrong annotations: don't truncate.
    return float(value) if isinstance(value, np.floating) else int(value)


def _serialize_bool(value: Any, _: Optional[List[memoryview]]) -> Any:
    if type(value) is bool:
        return value
    # Lenient about wrong annotations: don't truncate.
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.integer):
        return int(value)
    return bool(value)


_SCALAR_CONVERTERS: Dict[Any, Any] = {
    float: _serialize_float,
    int: _serialize_int,
    bool: _serialize_bool,
}


def _get_scalar_converter(annotation: Any) -> Optional[Converter]:
    # Annotations aren't always hashable.
    return next((f for t, f in _SCALAR_CONVERTERS.items() if t is annotation), None)


def _make_converter(annotation: Any) -> Converter:
    """Resolve an annotation to a serialization function once, so that the
    annotation doesn't need to be inspected for every message."""
    scalar_converter = _get_scalar_converter(annotation)
    if scalar_converter is not None:
        return scalar_converter

    if dataclasses.is_dataclass(annotation):

        def serialize_dataclass(
            value: Any, binary_buffers: Optional[List[memoryview]]
        ) -> Any:
            if isinstance(value, np.generic):
                return value.item()
            return {
                k: v
                if type(v) in _PASSTHROUGH_TYPES
                else _serialize_dynamic(v, binary_buffers)
                for k, v in vars(value).items()
            }

        return serialize_dataclass

    args = get_args(annotation)
    elements = [a for a in args if a is not Ellipsis]
    converters = [c for c in map(_get_scalar_converter, elements) if c is not None]
    if get_origin(annotation) is tuple and len(converters) == len(elements):
        variadic = len(args) == 2 and args[1] is Ellipsis

        def serialize_scalar_tuple(
            value: Any, binary_buffers: Optional[List[memoryview]]
        ) -> Any:
            if type(value) is tuple:
                if variadic:
                    convert = converters[0]
                    return [convert(v, None) for v in value]
                if len(value) == len(converters):
                    return [convert(v, None) for v, convert in zip(value, converters)]
            # Mismatched arity, arrays, etc.
            return _prepare_for_serialization(value, annotation, binary_buffers)

        return serialize_scalar_tuple

    if annotation is Any:
        return _serialize_dynamic

    def serialize_other(value: Any, binary_buffers: Optional[List[memoryview]]) -> Any:
        # Scalar coercion only happens for float/int/bool annotations. So without a
        # tuple annotation, containers depend only on what's in them.
        if not is_tuple and type(value) in _DYNAMIC_TYPES:
            return _serialize_dynamic(value, binary_buffers)
        return _prepare_for_serialization(value, annotation, binary_buffers)

    is_tuple = get_origin(annotation) is tuple
    return serialize_other


@functools.lru_cache(maxsize=None)
def _wire_converters(
    cls: Type[Any],
) -> Tuple[Tuple[str, FrozenSet[type], Converter], ...]:
    """(field name, passthrough types, converter) for everything a message type
    puts on the wire. Values whose exact type is in the passthrough set don't
    need to be converted."""
    hints = get_type_hints_cached(cls)
    out = []
    for name in wire_field_names(cls):
        hint = hints[name]
        if _get_scalar_converter(hint) is not None:
            passthrough = frozenset({hint})
        elif get_origin(hint) is tuple or dataclasses.is_dataclass(hint):
            passthrough = frozenset()
        else:
            passthrough = _PASSTHROUGH_TYPES
        convert = _make_converter(hint)
        out.append((name, passthrough, convert))
    return tuple(out)


def _prepare_for_serialization(
    value: Any,
    annotation: object,
    binary_buffers: Optional[List[memoryview]] = None,
) -> Any:
    """Prepare any special types for serialization.

    If ``binary_buffers`` is provided, numpy arrays are extracted into it and
    replaced with tagged placeholder dicts (``{"__binary_index": i, "dtype": "<f4"}``).
    This pairs with the hybrid wire format where binary data is appended raw
    after the msgpack payload, enabling zero-copy typed array views on the client.

    If ``binary_buffers`` is None, numpy arrays are inlined as memoryviews
    in the serialized dict itself."""
    if annotation is Any:
        annotation = type(value)

    # Coerce some scalar types: if we've annotated as float / int but we get an
    # np.float32 / np.int64, for example, we should cast automatically.
    if annotation is float or isinstance(value, np.floating):
        return float(value)
    if annotation is int or isinstance(value, np.integer):
        return int(value)
    # np.bool_ (from mask.any(), arr > 0, np.all(...), etc.) is neither
    # np.floating nor np.integer, and msgpack cannot encode it -- unconverted
    # it raised inside the broadcast producer, tearing down every client's
    # connection (and, being a persistent update, re-crashing on reconnect).
    if annotation is bool or isinstance(value, np.bool_):
        return bool(value)
    # Any OTHER numpy scalar msgpack can't encode -- most importantly np.str_
    # and np.bytes_ from a numpy string array (names[i], labels), which are
    # far more common than bool. .item() returns the python-native
    # equivalent. Closes the same crash class as the branches above; without
    # it a numpy-array-sourced name/label bricked the producer for all
    # clients. (Placed after float/int/bool so the common numeric paths keep
    # their explicit fast conversions.)
    if isinstance(value, np.generic):
        return value.item()

    if dataclasses.is_dataclass(annotation):
        return _prepare_for_serialization(vars(value), dict, binary_buffers)

    # Recursively handle tuples.
    if isinstance(value, tuple):
        out = []
        if get_origin(annotation) is tuple:
            args = get_args(annotation)
            if len(args) >= 2 and args[1] == ...:
                args = (args[0],) * len(value)
            elif len(value) != len(args):
                warnings.warn(f"[viser] {value} does not match annotation {annotation}")
                return value
        else:
            args = [Any] * len(value)

        for i, v in enumerate(value):
            out.append(
                # Hack to be OK with wrong type annotations.
                # https://github.com/nerfstudio-project/nerfstudio/pull/1805
                _prepare_for_serialization(v, args[i], binary_buffers)
                if i < len(args)
                else v
            )
        return tuple(out)

    # Handle numpy arrays: extract or inline depending on mode.
    if isinstance(value, np.ndarray):
        data = _flat_byte_view(value)
        if binary_buffers is not None:
            # Extract into separate buffer with tagged placeholder.
            idx = len(binary_buffers)
            binary_buffers.append(data)
            return {"__binary_index": idx, "dtype": value.dtype.str}
        else:
            # Inline as memoryview in the serialized dict.
            return data

    if isinstance(value, list):
        return [_prepare_for_serialization(v, Any, binary_buffers) for v in value]

    if isinstance(value, dict):
        return {
            k: _prepare_for_serialization(v, Any, binary_buffers)
            for k, v in value.items()
        }  # type: ignore

    return value


def is_binary_placeholder(value: Any) -> bool:
    """Detect the tagged placeholder dicts created above for extracted binary
    buffers. Must stay in sync with the client's detection in
    ``BinaryMessageDecode.ts``, which tests for the same two keys."""
    return isinstance(value, dict) and "__binary_index" in value and "dtype" in value


T = TypeVar("T", bound="Message")


@functools.lru_cache(maxsize=None)
def get_type_hints_cached(cls: Type[Any]) -> Dict[str, Any]:
    return get_type_hints(cls)  # type: ignore


@functools.lru_cache(maxsize=None)
def wire_field_names(cls: Type[Any]) -> Tuple[str, ...]:
    """Names of the fields a message type puts on the wire: declared,
    type-hinted dataclass fields, in declaration order. THE single
    definition of the wire field set -- the serializer and the TypeScript
    interface generator must never disagree on it. Declared fields (not
    ``vars()``) so that non-init defaulted fields (e.g. the scene messages'
    owner/virtual stamps) are included even before first assignment."""
    hints = get_type_hints_cached(cls)
    return tuple(f.name for f in dataclasses.fields(cls) if f.name in hints)


@functools.lru_cache(maxsize=None)
def _non_init_field_names(cls: Type[Any]) -> Tuple[str, ...]:
    """Dataclass fields excluded from ``__init__`` (assigned post-construction
    on deserialization). Empty for most message types."""
    return tuple(f.name for f in dataclasses.fields(cls) if not f.init)


class Message(abc.ABC):
    """Base message type for server/client communication."""

    excluded_self_client: Optional[ClientId] = None
    """Don't send this message to a particular client. Useful when a client wants to
    send synchronization information to other clients."""

    # Entity lifecycle markers. Generic at this layer; application-specific
    # literals (e.g. EntityType in viser._messages) narrow these in subclasses
    # via the __init_subclass__ kwargs pattern. The buffer and GC read these
    # via the Message base to coalesce create/remove and purge stale updates
    # uniformly across entity types.
    entity_type: ClassVar[Optional[str]] = None
    lifecycle_phase: ClassVar[Optional[str]] = None
    entity_id_field: ClassVar[Optional[str]] = None

    # Required on every viser Message subclass (enforced in
    # viser._messages.Message.__init_subclass__). Type-only declaration here
    # so infra-level readers (e.g. the state-serializer filter) can access
    # the attribute without static errors.
    include_in_scene_serialization: ClassVar[bool]

    def entity_state_key(self) -> Optional[Tuple[str, str]]:
        """The (entity_type, entity_id) this message carries PER-ENTITY state
        for, or None for messages that carry none: update messages
        (``update_dict``/``update_simple``) key to their declared entity;
        phase-less messages carrying a ``name`` key to ``("scene", name)``
        (name-keyed adjacency exists only for SCENE nodes -- interaction
        bindings etc.; other entity families key by uuid fields that never
        collide with a scene name). The ONE definition of this taxonomy: the
        buffer's entity-state index, the same-name-replacement purge, and the
        connect-time garbage collector's sweep all resolve through it."""
        phase = self.lifecycle_phase
        if phase in ("update_dict", "update_simple"):
            if self.entity_type is not None and self.entity_id_field is not None:
                return (self.entity_type, getattr(self, self.entity_id_field))
            return None
        if phase is None:
            name = getattr(self, "name", None)
            if name is not None:
                return ("scene", name)
        return None

    def targets_entity_state(self, entity_type: str, entity_id: str) -> bool:
        """True when this message carries per-entity state for the given
        entity; the predicate form of :meth:`entity_state_key`."""
        return self.entity_state_key() == (entity_type, entity_id)

    def as_serializable_dict(
        self, binary_buffers: Optional[List[memoryview]] = None
    ) -> Dict[str, Any]:
        """Convert a Python Message object into a serializable dict.

        If ``binary_buffers`` is provided, numpy arrays are extracted into it
        and replaced with tagged placeholder dicts for the hybrid wire format.
        Otherwise, arrays are inlined as memoryviews in the returned dict."""
        message_type = type(self)
        out = {}
        for name, passthrough, convert in _wire_converters(message_type):
            value = getattr(self, name)
            out[name] = (
                value if type(value) in passthrough else convert(value, binary_buffers)
            )
        out["type"] = message_type.__name__
        return out

    @classmethod
    def _from_serializable_dict(cls, mapping: Dict[str, Any]) -> Dict[str, Any]:
        """Convert a dict message back into a Python Message object."""

        converters = _deserialize_converters(cls)
        return {k: converters[k](v) for k, v in mapping.items()}

    @classmethod
    def deserialize(cls, message: bytes) -> Message:
        """Convert bytes into a Python Message object."""
        mapping = msgspec.msgpack.decode(message)

        # List-to-tuple conversion is handled per-field in
        # by _deserialize_converters() (called from _from_serializable_dict),
        # which uses type annotations to convert only where needed. This avoids
        # a blanket recursive traversal of the entire message tree.
        message_type = cls._subclass_from_type_string()[cast(str, mapping.pop("type"))]
        message_kwargs = message_type._from_serializable_dict(mapping)
        # Non-init fields (e.g. the scene messages' owner/virtual stamps,
        # declared init=False so defaulted fields can follow subclasses'
        # positional ones on Python 3.8) can't be passed to __init__; strip
        # them out and assign after construction so the serialize ->
        # deserialize round trip stays lossless. The per-class name tuple is
        # cached: most message types have none, and this runs per inbound
        # message.
        non_init = {
            k: message_kwargs.pop(k)
            for k in _non_init_field_names(message_type)
            if k in message_kwargs
        }
        decoded = message_type(**message_kwargs)
        for k, v in non_init.items():
            setattr(decoded, k, v)
        return decoded

    @classmethod
    @functools.lru_cache(maxsize=100)
    def _subclass_from_type_string(cls: Type[T]) -> Dict[str, Type[T]]:
        subclasses = cls.get_subclasses()
        return {s.__name__: s for s in subclasses}

    @classmethod
    def get_subclasses(cls: Type[T]) -> List[Type[T]]:
        """Recursively get message subclasses."""

        def _get_subclasses(typ: Type[T]) -> List[Type[T]]:
            out = []
            for sub in typ.__subclasses__():
                if not sub.__name__.startswith("_"):
                    out.append(sub)
                out.extend(_get_subclasses(sub))
            return out

        return _get_subclasses(cls)

    @abc.abstractmethod
    def redundancy_key(self) -> str:
        """Returns a unique key for this message, used for detecting redundant
        messages.

        For example: if we send 1000 "set value" messages for the same GUI element, we
        should only keep the latest message.
        """
