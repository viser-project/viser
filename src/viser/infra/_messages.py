"""Message type definitions. For synchronization with the TypeScript definitions, see
`_typescript_interface_gen.py.`"""

from __future__ import annotations

import abc
import dataclasses
import functools
import warnings
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Type, TypeVar, Union, cast

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

    If ``binary_buffers`` is None, numpy arrays are inlined as memoryviews."""
    if annotation is Any:
        annotation = type(value)

    # Coerce some scalar types: if we've annotated as float / int but we get an
    # np.float32 / np.int64, for example, we should cast automatically.
    if annotation is float or isinstance(value, np.floating):
        return float(value)
    if annotation is int or isinstance(value, np.integer):
        return int(value)

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
        data = value.data if value.data.c_contiguous else value.copy().data
        if binary_buffers is not None:
            # Extract into separate buffer with tagged placeholder.
            idx = len(binary_buffers)
            binary_buffers.append(data)
            return {"__binary_index": idx, "dtype": value.dtype.str}
        else:
            # Inline as memoryview (used by API v0).
            return data

    if isinstance(value, list):
        return [_prepare_for_serialization(v, Any, binary_buffers) for v in value]

    if isinstance(value, dict):
        return {
            k: _prepare_for_serialization(v, Any, binary_buffers)
            for k, v in value.items()
        }  # type: ignore

    return value


T = TypeVar("T", bound="Message")


@functools.lru_cache(maxsize=None)
def get_type_hints_cached(cls: Type[Any]) -> Dict[str, Any]:
    return get_type_hints(cls)  # type: ignore


class Message(abc.ABC):
    """Base message type for server/client communication."""

    excluded_self_client: Optional[ClientId] = None
    """Don't send this message to a particular client. Useful when a client wants to
    send synchronization information to other clients."""

    def as_serializable_dict(
        self, binary_buffers: Optional[List[memoryview]] = None
    ) -> Dict[str, Any]:
        """Convert a Python Message object into a serializable dict.

        If ``binary_buffers`` is provided, numpy arrays are extracted into it
        and replaced with tagged placeholder dicts for the hybrid wire format.
        Otherwise, arrays are inlined as memoryviews (used by API v0)."""
        message_type = type(self)
        hints = get_type_hints_cached(message_type)
        # Filter to type-hinted fields only — excludes dynamic attributes
        # like cached values that shouldn't be serialized.
        out = {
            k: _prepare_for_serialization(v, hints[k], binary_buffers)
            for k, v in vars(self).items()
            if k in hints
        }
        out["type"] = message_type.__name__
        return out

    @classmethod
    def _from_serializable_dict(cls, mapping: Dict[str, Any]) -> Dict[str, Any]:
        """Convert a dict message back into a Python Message object."""

        hints = get_type_hints_cached(cls)

        mapping = {
            k: _prepare_for_deserialization(v, hints[k]) for k, v in mapping.items()
        }
        return mapping

    @classmethod
    def deserialize(cls, message: bytes) -> Message:
        """Convert bytes into a Python Message object."""
        mapping = msgspec.msgpack.decode(message)

        # List-to-tuple conversion is handled per-field in
        # _prepare_for_deserialization (called from _from_serializable_dict),
        # which uses type annotations to convert only where needed. This avoids
        # a blanket recursive traversal of the entire message tree.
        message_type = cls._subclass_from_type_string()[cast(str, mapping.pop("type"))]
        message_kwargs = message_type._from_serializable_dict(mapping)
        return message_type(**message_kwargs)

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
