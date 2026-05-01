import dataclasses
import datetime
import types
from collections import defaultdict
from typing import Any, Type, Union, cast

import numpy as np
from typing_extensions import (
    Annotated,
    Literal,
    Never,
    NotRequired,
    get_args,
    get_origin,
    get_type_hints,
    is_typeddict,
)

try:
    from typing import Literal as LiteralAlt
except ImportError:
    LiteralAlt = Literal  # type: ignore

from ._messages import Message

_raw_type_mapping = {
    bool: "boolean",
    float: "number",
    int: "number",
    str: "string",
    # For numpy arrays, we directly serialize the underlying data buffer.
    np.ndarray: "Uint8Array<ArrayBuffer>",
    bytes: "Uint8Array<ArrayBuffer>",
    Any: "any",
    None: "null",
    Never: "never",
    type(None): "null",
    # datetime types serialize as ISO 8601 strings
    datetime.datetime: "string",
    datetime.date: "string",
    datetime.time: "string",
}


def _get_ts_type(typ: Type[Any]) -> str:
    origin_typ = get_origin(typ)

    # Look for TypeScriptAnnotationOverride in the annotations.
    if origin_typ is Annotated:
        args = get_args(typ)
        for arg in args[1:]:
            if isinstance(arg, TypeScriptAnnotationOverride):
                return arg.annotation

        # If no override is found, just use the unwrapped type.
        origin_typ = args[0]

    # Automatic Python => TypeScript conversion.
    UnionType = getattr(types, "UnionType", Union)
    if origin_typ is tuple:
        args = get_args(typ)
        if len(args) == 2 and args[1] == ...:
            return _get_ts_type(args[0]) + "[]"
        else:
            return "[" + ", ".join(map(_get_ts_type, args)) + "]"
    elif origin_typ is list:
        args = get_args(typ)
        assert len(args) == 1
        return _get_ts_type(args[0]) + "[]"
    elif origin_typ is dict:
        args = get_args(typ)
        assert len(args) == 2
        return "{[key: " + _get_ts_type(args[0]) + "]: " + _get_ts_type(args[1]) + "}"
    elif origin_typ in (Literal, LiteralAlt):
        return " | ".join(
            map(
                lambda lit: repr(lit).lower() if type(lit) is bool else repr(lit),
                get_args(typ),
            )
        )
    elif origin_typ in (Union, UnionType):
        return (
            "("
            + " | ".join(
                # We're using dictionary as an ordered set.
                {_get_ts_type(t): None for t in get_args(typ)}.keys()
            )
            + ")"
        )
    elif origin_typ is list:
        args = get_args(typ)
        return _get_ts_type(args[0]) + "[]"
    elif origin_typ is dict:
        args = get_args(typ)
        assert len(args) == 2
        return "{ [key: " + _get_ts_type(args[0]) + "]: " + _get_ts_type(args[1]) + " }"
    elif is_typeddict(typ) or dataclasses.is_dataclass(typ):
        hints = get_type_hints(typ)
        if dataclasses.is_dataclass(typ):
            hints = {field.name: hints[field.name] for field in dataclasses.fields(typ)}
        optional_keys = getattr(typ, "__optional_keys__", [])

        def fmt(key):
            val = hints[key]
            optional = key in optional_keys
            if is_typeddict(typ) and get_origin(val) is NotRequired:
                val = get_args(val)[0]
            ret = f"'{key}'{'?' if optional else ''}" + ": " + _get_ts_type(val)
            return ret

        ret = "{" + ", ".join(map(fmt, hints)) + "}"
        return ret
    else:
        # Like get_origin(), but also supports numpy.typing.NDArray[dtype].
        typ = cast(Any, getattr(typ, "__origin__", typ))

        assert typ in _raw_type_mapping, f"Unsupported type {typ}"
        return _raw_type_mapping[typ]


@dataclasses.dataclass(frozen=True)
class TypeScriptAnnotationOverride:
    """Use with `typing.Annotated[]` to override the automatically-generated
    TypeScript annotation corresponding to a dataclass field."""

    annotation: str


def generate_typescript_interfaces(message_cls: Type[Message]) -> str:
    """Generate TypeScript definitions for all subclasses of a base message class."""
    out_lines = []
    message_types = message_cls.get_subclasses()

    tag_map = defaultdict(list)

    # Generate interfaces for each specific message.
    for cls in message_types:
        if cls.__doc__ is not None:
            docstring = "\n * ".join(
                map(lambda line: line.strip(), cls.__doc__.split("\n"))
            )
            out_lines.append(f"/** {docstring}")
            out_lines.append(" *")
            out_lines.append(" * (automatically generated)")
            out_lines.append(" */")

        for tag in getattr(cls, "_tags", []):
            tag_map[tag].append(cls.__name__)

        out_lines.append(f"export interface {cls.__name__} " + "{")
        out_lines.append(f'  type: "{cls.__name__}";')
        field_names = set([f.name for f in dataclasses.fields(cls)])  # type: ignore
        for name, typ in get_type_hints(cls, include_extras=True).items():
            if name in field_names:
                typ = _get_ts_type(typ)
            else:
                continue
            out_lines.append(f"  {name}: {typ};")
        out_lines.append("}")
    out_lines.append("")

    # Generate union type over all messages.
    out_lines.append("export type Message = ")
    for cls in message_types:
        out_lines.append(f"  | {cls.__name__}")
    out_lines[-1] = out_lines[-1] + ";"

    # Generate union type over all tags.
    for tag, cls_names in tag_map.items():
        out_lines.append(f"export type {tag} = ")
        for cls_name in cls_names:
            out_lines.append(f"  | {cls_name}")
        out_lines[-1] = out_lines[-1] + ";"

    for tag, cls_names in tag_map.items():
        out_lines.extend(
            [
                f"const typeSet{tag} = new Set(['" + "', '".join(cls_names) + "']);"
                f"export function is{tag}(message: Message): message is {tag}" + " {",
                f"    return typeSet{tag}.has(message.type);",
                "}",
            ]
        )

    generated_typescript = "\n".join(out_lines) + "\n"

    # Add header and return.
    return (
        "\n".join(
            [
                (
                    "// AUTOMATICALLY GENERATED message interfaces, from Python"
                    " dataclass definitions."
                ),
                "// This file should not be manually modified.",
                "",
            ]
        )
        + generated_typescript
    )
