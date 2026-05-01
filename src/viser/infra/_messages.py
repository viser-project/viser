"""Message type definitions. For synchronization with the TypeScript definitions, see
`_typescript_interface_gen.py.`"""

from __future__ import annotations

import abc
import dataclasses
import functools
import warnings
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Type, TypeVar, cast

import msgspec
import numpy as np
from typing_extensions import get_args, get_origin, get_type_hints

if TYPE_CHECKING:
    from ._infra import ClientId
else:
    ClientId = Any


def _prepare_for_deserialization(value: Any, annotation: Type) -> Any:
    import datetime

    # Handle ISO strings → datetime types
    if annotation is datetime.datetime:
        if isinstance(value, str):
            dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            # Strip timezone info to avoid naive/aware mixing issues.
            return dt.replace(tzinfo=None)
        elif isinstance(value, (int, float)):
            # Backward compatibility: support old timestamp format.
            return datetime.datetime.fromtimestamp(value)
        return value

    if annotation is datetime.date:
        if isinstance(value, str):
            return datetime.date.fromisoformat(value)
        return value

    if annotation is datetime.time:
        if isinstance(value, str):
            return datetime.time.fromisoformat(value)
        return value

    # If annotated as a float but we got an integer, cast to float. These
    # are both `number` in Javascript.
    if annotation is float:
        return float(value)
    elif annotation is int:
        return int(value)
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


def _prepare_for_serialization(value: Any, annotation: object) -> Any:
    """Prepare any special types for serialization."""
    import datetime

    if annotation is Any:
        annotation = type(value)

    # Handle datetime types → ISO 8601 strings
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat()

    # Coerce some scalar types: if we've annotated as float / int but we get an
    # np.float32 / np.int64, for example, we should cast automatically.
    if annotation is float or isinstance(value, np.floating):
        return float(value)
    if annotation is int or isinstance(value, np.integer):
        return int(value)

    if dataclasses.is_dataclass(annotation):
        return _prepare_for_serialization(vars(value), dict)

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
                _prepare_for_serialization(v, args[i]) if i < len(args) else v
            )
        return tuple(out)

    # For arrays, we serialize underlying data directly. The client is responsible for
    # reading using the correct dtype.
    if isinstance(value, np.ndarray):
        return value.data if value.data.c_contiguous else value.copy().data

    if isinstance(value, dict):
        return {k: _prepare_for_serialization(v, Any) for k, v in value.items()}  # type: ignore

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

    def as_serializable_dict(self) -> Dict[str, Any]:
        """Convert a Python Message object into bytes."""
        message_type = type(self)
        hints = get_type_hints_cached(message_type)
        out = {
            k: _prepare_for_serialization(v, hints[k]) for k, v in vars(self).items()
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

        # msgpack deserializes to lists by default, but all of our annotations use
        # tuples.
        def lists_to_tuple(obj: Any) -> Any:
            if isinstance(obj, list):
                return tuple(lists_to_tuple(x) for x in obj)
            elif isinstance(obj, dict):
                return {k: lists_to_tuple(v) for k, v in obj.items()}
            else:
                return obj

        mapping = lists_to_tuple(mapping)
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
