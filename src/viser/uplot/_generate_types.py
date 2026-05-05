"""TypeScript to Python TypedDict generator with AST-based parsing.

This script uses principled recursive descent parsing to convert TypeScript
definition files into Python TypedDict format with proper type mappings.

Key features:
- Full lexer and recursive descent parser for TypeScript types
- AST-based type conversion with semantic aliases
- Proper handling of complex union types and function signatures
- Conservative approach to undefined type references
"""

from __future__ import annotations

import re
import subprocess
from abc import ABC
from collections import defaultdict, deque
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path
from typing import Dict, List, Optional, Set, Union

# ==================== TypeScript Type Parser ====================


class TokenType(Enum):
    # Literals
    IDENTIFIER = auto()
    STRING_LITERAL = auto()
    NUMBER_LITERAL = auto()

    # Operators and punctuation
    PIPE = auto()  # |
    AMPERSAND = auto()  # &
    QUESTION = auto()  # ?
    COLON = auto()  # :
    SEMICOLON = auto()  # ;
    COMMA = auto()  # ,
    DOT = auto()  # .
    ARROW = auto()  # =>

    # Brackets and parentheses
    LPAREN = auto()  # (
    RPAREN = auto()  # )
    LBRACKET = auto()  # [
    RBRACKET = auto()  # ]
    LBRACE = auto()  # {
    RBRACE = auto()  # }

    # Special
    EOF = auto()
    UNKNOWN = auto()


@dataclass
class Token:
    type: TokenType
    value: str
    position: int


class Lexer:
    """Tokenizes TypeScript type strings."""

    def __init__(self, text: str):
        self.text = text
        self.position = 0
        self.current_char = self.text[0] if text else None

    def advance(self):
        """Move to the next character."""
        self.position += 1
        if self.position >= len(self.text):
            self.current_char = None
        else:
            self.current_char = self.text[self.position]

    def peek(self, offset: int = 1) -> Optional[str]:
        """Look ahead at the next character without advancing."""
        peek_pos = self.position + offset
        if peek_pos >= len(self.text):
            return None
        return self.text[peek_pos]

    def skip_whitespace(self):
        """Skip whitespace characters."""
        while self.current_char is not None and self.current_char.isspace():
            self.advance()

    def read_string_literal(self) -> str:
        """Read a quoted string literal."""
        quote_char = self.current_char  # ' or "
        result = quote_char or ""
        self.advance()

        while self.current_char is not None and self.current_char != quote_char:
            if self.current_char == "\\":
                result += "\\"
                self.advance()
                if self.current_char is not None:
                    result += self.current_char
                    self.advance()
            else:
                result += self.current_char
                self.advance()

        if self.current_char == quote_char:
            result += self.current_char or ""
            self.advance()

        return result

    def read_number_literal(self) -> str:
        """Read a number literal."""
        result = ""
        while self.current_char is not None and (
            self.current_char.isdigit() or self.current_char in ".-"
        ):
            result += self.current_char
            self.advance()
        return result

    def read_identifier(self) -> str:
        """Read an identifier or keyword."""
        result = ""
        while self.current_char is not None and (
            self.current_char.isalnum() or self.current_char in "_$"
        ):
            result += self.current_char
            self.advance()
        return result

    def get_next_token(self) -> Token:
        """Get the next token from the input."""
        while self.current_char is not None:
            if self.current_char.isspace():
                self.skip_whitespace()
                continue

            # String literals
            if self.current_char in ['"', "'"]:
                return Token(
                    TokenType.STRING_LITERAL, self.read_string_literal(), self.position
                )

            # Number literals
            peek_char = self.peek()
            if self.current_char.isdigit() or (
                self.current_char == "-"
                and peek_char is not None
                and peek_char.isdigit()
            ):
                return Token(
                    TokenType.NUMBER_LITERAL, self.read_number_literal(), self.position
                )

            # Arrow function =>
            if self.current_char == "=" and self.peek() == ">":
                self.advance()
                self.advance()
                return Token(TokenType.ARROW, "=>", self.position - 2)

            # Single character tokens
            single_char_tokens = {
                "|": TokenType.PIPE,
                "&": TokenType.AMPERSAND,
                "?": TokenType.QUESTION,
                ":": TokenType.COLON,
                ";": TokenType.SEMICOLON,
                ",": TokenType.COMMA,
                ".": TokenType.DOT,
                "(": TokenType.LPAREN,
                ")": TokenType.RPAREN,
                "[": TokenType.LBRACKET,
                "]": TokenType.RBRACKET,
                "{": TokenType.LBRACE,
                "}": TokenType.RBRACE,
            }

            if self.current_char in single_char_tokens:
                token_type = single_char_tokens[self.current_char]
                char = self.current_char
                pos = self.position
                self.advance()
                return Token(token_type, char, pos)

            # Identifiers and keywords
            if self.current_char.isalpha() or self.current_char in "_$":
                return Token(
                    TokenType.IDENTIFIER, self.read_identifier(), self.position
                )

            # Unknown character
            char = self.current_char
            pos = self.position
            self.advance()
            return Token(TokenType.UNKNOWN, char, pos)

        return Token(TokenType.EOF, "", self.position)

    def tokenize(self) -> List[Token]:
        """Tokenize the entire input string."""
        tokens = []
        while True:
            token = self.get_next_token()
            tokens.append(token)
            if token.type == TokenType.EOF:
                break
        return tokens


# AST Node classes
class TypeNode(ABC):
    """Base class for all type AST nodes."""

    pass


@dataclass
class PrimitiveType(TypeNode):
    """Primitive TypeScript types like string, number, boolean."""

    name: str


@dataclass
class LiteralType(TypeNode):
    """Literal types like "hello", 42, true."""

    value: str
    literal_type: str  # 'string', 'number', 'boolean'


@dataclass
class IdentifierType(TypeNode):
    """Type identifiers like MyInterface, HTMLElement."""

    name: str


@dataclass
class UnionType(TypeNode):
    """Union types like string | number."""

    types: List[TypeNode]


@dataclass
class IntersectionType(TypeNode):
    """Intersection types like A & B."""

    types: List[TypeNode]


@dataclass
class ArrayType(TypeNode):
    """Array types like string[] or Array<T>."""

    element_type: TypeNode


@dataclass
class TupleType(TypeNode):
    """Tuple types like [string, number]."""

    element_types: List[TypeNode]


@dataclass
class FunctionType(TypeNode):
    """Function types like (x: number) => string."""

    parameters: List["ParameterType"]
    return_type: TypeNode


@dataclass
class ParameterType(TypeNode):
    """Function parameter like x: number or x?: string."""

    name: Optional[str]
    type: TypeNode
    optional: bool = False


@dataclass
class ParenthesizedType(TypeNode):
    """Parenthesized type like (string | number)."""

    inner_type: TypeNode


@dataclass
class GenericType(TypeNode):
    """Generic type like Array<T> or Map<K, V>."""

    base_type: TypeNode
    type_arguments: List[TypeNode]


class TypeScriptTypeParser:
    """Recursive descent parser for TypeScript type annotations."""

    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.position = 0
        self.current_token = self.tokens[0] if tokens else Token(TokenType.EOF, "", 0)

    def advance(self):
        """Move to the next token."""
        if self.position < len(self.tokens) - 1:
            self.position += 1
            self.current_token = self.tokens[self.position]

    def peek(self, offset: int = 1) -> Token:
        """Look ahead at a future token."""
        peek_pos = self.position + offset
        if peek_pos < len(self.tokens):
            return self.tokens[peek_pos]
        return Token(TokenType.EOF, "", 0)

    def parse(self) -> TypeNode:
        """Parse the token stream into an AST."""
        return self.parse_union_type()

    def parse_union_type(self) -> TypeNode:
        """Parse union type: A | B | C."""
        left = self.parse_intersection_type()

        if self.current_token.type == TokenType.PIPE:
            types = [left]
            while self.current_token.type == TokenType.PIPE:
                self.advance()  # consume |
                types.append(self.parse_intersection_type())
            return UnionType(types)

        return left

    def parse_intersection_type(self) -> TypeNode:
        """Parse intersection type: A & B & C."""
        left = self.parse_array_type()

        if self.current_token.type == TokenType.AMPERSAND:
            types = [left]
            while self.current_token.type == TokenType.AMPERSAND:
                self.advance()  # consume &
                types.append(self.parse_array_type())
            return IntersectionType(types)

        return left

    def parse_array_type(self) -> TypeNode:
        """Parse array type: T[] or Array<T>."""
        base = self.parse_primary_type()

        # Handle T[]
        while self.current_token.type == TokenType.LBRACKET:
            self.advance()  # consume [
            if self.current_token.type == TokenType.RBRACKET:
                self.advance()  # consume ]
                base = ArrayType(base)
            else:
                # This might be a tuple type [T, U] - backtrack and parse as primary
                break

        return base

    def parse_primary_type(self) -> TypeNode:
        """Parse primary types: identifiers, literals, parenthesized, etc."""

        # Parenthesized type or function type
        if self.current_token.type == TokenType.LPAREN:
            return self.parse_parenthesized_or_function()

        # Tuple type [T, U, V]
        if self.current_token.type == TokenType.LBRACKET:
            return self.parse_tuple_type()

        # String literal
        if self.current_token.type == TokenType.STRING_LITERAL:
            value = self.current_token.value
            self.advance()
            return LiteralType(value, "string")

        # Number literal
        if self.current_token.type == TokenType.NUMBER_LITERAL:
            value = self.current_token.value
            self.advance()
            return LiteralType(value, "number")

        # Identifier (including primitive types)
        if self.current_token.type == TokenType.IDENTIFIER:
            name = self.current_token.value
            self.advance()

            # Check for qualified names like HTMLElement.prototype
            if self.current_token.type == TokenType.DOT:
                qualified_parts = [name]
                while self.current_token.type == TokenType.DOT:
                    self.advance()  # consume .
                    if self.current_token.type == TokenType.IDENTIFIER:
                        qualified_parts.append(self.current_token.value)
                        self.advance()
                    else:
                        break
                return IdentifierType(".".join(qualified_parts))

            # Check if it's a primitive type
            if name in [
                "string",
                "number",
                "boolean",
                "void",
                "null",
                "undefined",
                "any",
                "unknown",
                "never",
            ]:
                return PrimitiveType(name)

            return IdentifierType(name)

        # If we can't parse anything, create an unknown identifier
        return IdentifierType("unknown")

    def parse_parenthesized_or_function(self) -> TypeNode:
        """Parse parenthesized type (T) or function type (params) => return."""
        self.advance()  # consume (

        # Check if this looks like a function parameter list
        if self.is_function_parameter_list():
            return self.parse_function_type_from_paren()

        # Otherwise, parse as parenthesized type
        inner = self.parse_union_type()

        if self.current_token.type == TokenType.RPAREN:
            self.advance()  # consume )

        # Check for arrow function after parentheses
        if self.current_token.type == TokenType.ARROW:
            self.advance()  # consume =>
            return_type = self.parse_union_type()
            # Convert the parenthesized type to function parameters if possible
            params = []
            if isinstance(inner, IdentifierType):
                params = [ParameterType(None, inner)]
            return FunctionType(params, return_type)

        return ParenthesizedType(inner)

    def is_function_parameter_list(self) -> bool:
        """Check if the current position looks like a function parameter list."""
        # Look ahead to see if we have parameter-like patterns
        saved_pos = self.position

        try:
            # Skip to see if we find => after )
            paren_depth = 1  # We already consumed the opening (
            while paren_depth > 0 and self.current_token.type != TokenType.EOF:
                if self.current_token.type == TokenType.LPAREN:
                    paren_depth += 1
                elif self.current_token.type == TokenType.RPAREN:
                    paren_depth -= 1
                self.advance()

            # Now check if we have =>
            result = self.current_token.type == TokenType.ARROW
            return result
        finally:
            # Restore position
            self.position = saved_pos
            self.current_token = (
                self.tokens[self.position]
                if self.position < len(self.tokens)
                else Token(TokenType.EOF, "", 0)
            )

    def parse_function_type_from_paren(self) -> FunctionType:
        """Parse function type starting from after the opening parenthesis."""
        parameters = []

        # Parse parameter list
        while self.current_token.type not in {TokenType.RPAREN, TokenType.EOF}:
            param = self.parse_parameter()
            parameters.append(param)

            if self.current_token.type == TokenType.COMMA:
                self.advance()  # consume ,
            elif self.current_token.type == TokenType.RPAREN:
                break
            else:
                # Safety break: if we don't see comma or closing paren, advance to avoid infinite loop
                self.advance()

        if self.current_token.type == TokenType.RPAREN:
            self.advance()  # consume )

        # Expect =>
        if self.current_token.type == TokenType.ARROW:
            self.advance()  # consume =>

        # Parse return type
        return_type = self.parse_union_type()

        return FunctionType(parameters, return_type)

    def parse_parameter(self) -> ParameterType:
        """Parse a function parameter."""
        name = None
        optional = False

        # Try to parse name: type pattern
        if self.current_token.type == TokenType.IDENTIFIER and self.peek().type in [
            TokenType.COLON,
            TokenType.QUESTION,
        ]:
            name = self.current_token.value
            self.advance()

            if self.current_token.type == TokenType.QUESTION:
                optional = True
                self.advance()  # consume ?

            if self.current_token.type == TokenType.COLON:
                self.advance()  # consume :

        # Parse the type
        param_type = self.parse_union_type()

        return ParameterType(name, param_type, optional)

    def parse_tuple_type(self) -> TypeNode:
        """Parse tuple type [T, U, V]."""
        self.advance()  # consume [

        element_types = []

        while self.current_token.type not in {TokenType.RBRACKET, TokenType.EOF}:
            # Handle labeled tuple elements like [min: number, max: number]
            if (
                self.current_token.type == TokenType.IDENTIFIER
                and self.peek().type == TokenType.COLON
            ):
                # Skip the label
                self.advance()  # identifier
                self.advance()  # :

            element_type = self.parse_union_type()
            element_types.append(element_type)

            if self.current_token.type == TokenType.COMMA:
                self.advance()  # consume ,
            elif self.current_token.type == TokenType.RBRACKET:
                break
            else:
                # Safety break: if we don't see comma or closing bracket, advance to avoid infinite loop
                self.advance()

        if self.current_token.type == TokenType.RBRACKET:
            self.advance()  # consume ]

        return TupleType(element_types)


def parse_typescript_type(type_string: str) -> TypeNode:
    """Parse a TypeScript type string into an AST."""
    lexer = Lexer(type_string)
    tokens = lexer.tokenize()
    parser = TypeScriptTypeParser(tokens)
    return parser.parse()


# ==================== AST to Python Converter ====================


class PythonTypeConverter:
    """Converts TypeScript AST nodes to Python type annotations."""

    def __init__(
        self,
        known_interfaces: Optional[Set[str]] = None,
        type_aliases: Optional[Dict[str, str]] = None,
        enums: Optional[Dict[str, "TypeScriptEnum"]] = None,
        use_literal_enums: bool = True,
    ):
        self.known_interfaces = known_interfaces or set()
        self.type_aliases = type_aliases or {}
        self.enums = enums or {}
        self.use_literal_enums = use_literal_enums

        # Semantic type mappings
        self.primitive_mappings = {
            "string": "str",
            "number": "float",
            "boolean": "bool",
            "void": "None",
            "null": "None",
            "undefined": "None",
            "any": "Any",
            "unknown": "Any",
            "never": "Never",
        }

        # DOM and browser type mappings
        self.dom_types = {
            "HTMLElement",
            "Element",
            "Node",
            "Event",
            "MouseEvent",
            "DOMRect",
            "HTMLCanvasElement",
            "HTMLDivElement",
            "HTMLInputElement",
            "EventTarget",
            "Document",
            "Window",
        }

        # CSS and canvas types
        self.css_types = {
            "CSSStyleDeclaration",
            "CanvasRenderingContext2D",
            "CanvasGradient",
            "CanvasPattern",
            "ImageData",
            "TextMetrics",
        }

    def convert(self, node: TypeNode) -> str:
        """Convert a TypeScript AST node to Python type annotation."""
        if isinstance(node, PrimitiveType):
            return self._convert_primitive(node)
        elif isinstance(node, LiteralType):
            return self._convert_literal(node)
        elif isinstance(node, IdentifierType):
            return self._convert_identifier(node)
        elif isinstance(node, UnionType):
            return self._convert_union(node)
        elif isinstance(node, IntersectionType):
            return self._convert_intersection(node)
        elif isinstance(node, ArrayType):
            return self._convert_array(node)
        elif isinstance(node, TupleType):
            return self._convert_tuple(node)
        elif isinstance(node, FunctionType):
            return self._convert_function(node)
        elif isinstance(node, ParenthesizedType):
            return self.convert(node.inner_type)
        elif isinstance(node, GenericType):
            return self._convert_generic(node)
        else:
            return "UnknownType"

    def _convert_primitive(self, node: PrimitiveType) -> str:
        """Convert primitive types."""
        return self.primitive_mappings.get(node.name, "UnknownType")

    def _convert_literal(self, node: LiteralType) -> str:
        """Convert literal types."""
        return f"Literal[{node.value}]"

    def _convert_identifier(self, node: IdentifierType) -> str:
        """Convert identifier types with semantic mapping."""
        name = node.name

        # Handle qualified names (e.g., HTMLElement.prototype)
        if "." in name:
            parts = name.split(".")
            base_name = parts[0]

            # Check for type aliases first (e.g., Scale.Auto, Sync.Scales)
            # Try exact match first.
            if name in self.type_aliases:
                alias_def = self.type_aliases[name]
                # Recursively convert the aliased type
                try:
                    ast_node = parse_typescript_type(alias_def)
                    return self.convert(ast_node)
                except Exception:
                    # If parsing fails, fall back to original logic
                    pass

            # Try with common namespace prefixes (e.g., Sync.Scales -> Cursor.Sync.Scales)
            for prefix in ["Cursor", "Scale", "Series", "Axis", "Legend"]:
                qualified_name = f"{prefix}.{name}"
                if qualified_name in self.type_aliases:
                    alias_def = self.type_aliases[qualified_name]
                    try:
                        ast_node = parse_typescript_type(alias_def)
                        return self.convert(ast_node)
                    except Exception:
                        continue

            # Check for namespace patterns first (e.g., Legend.Markers -> Legend_Markers)
            full_name = "_".join(parts)
            if full_name in self.known_interfaces:
                return full_name

            # Check for namespaced enums (e.g., Axis.Align -> Align)
            enum_name = parts[-1]  # Get the last part (e.g., "Align" from "Axis.Align")
            if enum_name in self.enums:
                if self.use_literal_enums:
                    return self._convert_enum_to_literal(enum_name)
                else:
                    return enum_name
            elif enum_name in self.known_interfaces:
                return enum_name

            # For type aliases within namespaces (e.g., Legend.Width, Legend.Stroke)
            # these should be treated as UnknownType since they're not interfaces
            if base_name in self.known_interfaces:
                return "UnknownType"

            # For other qualified names that we don't have definitions for
            return "UnknownType"

        # Check if it's a type alias first
        if name in self.type_aliases:
            alias_def = self.type_aliases[name]
            # Recursively convert the aliased type
            try:
                ast_node = parse_typescript_type(alias_def)
                return self.convert(ast_node)
            except Exception:
                # If parsing fails, fall back to original logic
                pass

        # Check if it's an enum first
        if name in self.enums:
            if self.use_literal_enums:
                return self._convert_enum_to_literal(name)
            else:
                return name

        # Check if it's a known interface
        if name in self.known_interfaces:
            return name

        # Check for DOM types
        if name in self.dom_types:
            return "DOMElement"

        # Check for CSS/Canvas types
        if name in self.css_types:
            return "CSSValue"

        # Handle common TypeScript utility types
        utility_types = {
            "Partial",
            "Required",
            "Readonly",
            "Pick",
            "Omit",
            "Exclude",
            "Extract",
            "NonNullable",
            "Parameters",
            "ConstructorParameters",
            "ReturnType",
            "InstanceType",
            "ThisType",
            "Record",
            "Uppercase",
            "Lowercase",
            "Capitalize",
            "Uncapitalize",
        }
        if name in utility_types:
            return "UnknownType"

        # Handle built-in TypeScript types
        builtin_types = {
            "object": "Dict",
            "Object": "Dict",
            "String": "str",
            "Number": "float",
            "Boolean": "bool",
            "Array": "List",
            "Function": "JSCallback",
            "Date": "UnknownType",
            "RegExp": "UnknownType",
            "Promise": "UnknownType",
            "Symbol": "UnknownType",
            "BigInt": "int",
        }
        if name in builtin_types:
            return builtin_types[name]

        # Default for unknown identifiers
        return "UnknownType"

    def _convert_enum_to_literal(self, enum_name: str) -> str:
        """Convert an enum to a Literal union type."""
        if enum_name not in self.enums:
            return "UnknownType"

        enum_obj = self.enums[enum_name]
        values = []
        for member_name, value in enum_obj.members:
            # Keep the value as-is (already properly quoted for strings)
            values.append(value)

        # Use compact Literal syntax: Literal[0, 1, 2] instead of Literal[0] | Literal[1] | Literal[2]
        return f"Literal[{', '.join(values)}]"

    def _convert_union(self, node: UnionType) -> str:
        """Convert union types."""
        if not node.types:
            return "UnknownType"

        converted_types = []
        for type_node in node.types:
            converted = self.convert(type_node)
            converted_types.append(converted)

        # Remove duplicates while preserving order
        seen = set()
        unique_types = []
        for t in converted_types:
            if t not in seen:
                seen.add(t)
                unique_types.append(t)

        if len(unique_types) == 1:
            return unique_types[0]
        elif len(unique_types) > 1:
            return f"Union[{', '.join(unique_types)}]"
        else:
            return "UnknownType"

    def _convert_intersection(self, node: IntersectionType) -> str:
        """Convert intersection types - these are complex in Python."""
        # For now, just return the first type or UnknownType
        if node.types:
            return self.convert(node.types[0])
        return "UnknownType"

    def _convert_array(self, node: ArrayType) -> str:
        """Convert array types to Tuple[T, ...] by default."""
        element_type = self.convert(node.element_type)
        return f"Tuple[{element_type}, ...]"

    def _convert_tuple(self, node: TupleType) -> str:
        """Convert tuple types."""
        if not node.element_types:
            return "Tuple[()]"

        element_types = [self.convert(t) for t in node.element_types]
        return f"Tuple[{', '.join(element_types)}]"

    def _convert_function(self, node: FunctionType) -> str:
        """Convert function types to JSCallback."""
        return "JSCallback"

    def _convert_generic(self, node: GenericType) -> str:
        """Convert generic types."""
        base = self.convert(node.base_type)

        # Handle common generic types
        if isinstance(node.base_type, IdentifierType):
            base_name = node.base_type.name

            if base_name == "Array" and node.type_arguments:
                element_type = self.convert(node.type_arguments[0])
                return f"Tuple[{element_type}, ...]"

            if base_name == "Record" and len(node.type_arguments) >= 2:
                key_type = self.convert(node.type_arguments[0])
                value_type = self.convert(node.type_arguments[1])
                return f"Dict[{key_type}, {value_type}]"

            if base_name == "Partial":
                # Partial<T> in TypeScript makes all properties optional
                # In Python TypedDict, we handle this at the TypedDict level
                return "UnknownType"

            if base_name == "Promise":
                # Promises don't have a direct Python equivalent
                return "UnknownType"

        # For other generic types, just use the base type
        return base


def convert_type_with_ast(
    ts_type: str,
    known_interfaces: Set[str],
    type_aliases: Optional[Dict[str, str]] = None,
    enums: Optional[Dict[str, "TypeScriptEnum"]] = None,
    use_literal_enums: bool = True,
) -> str:
    """Convert TypeScript type using AST-based parsing."""
    try:
        # Create converter with known interfaces, type aliases, and enums for better type resolution
        converter = PythonTypeConverter(
            known_interfaces, type_aliases, enums, use_literal_enums
        )

        # Parse and convert using AST
        ast_node = parse_typescript_type(ts_type)
        return converter.convert(ast_node)
    except Exception:
        # Fallback for unparseable types
        return "UnknownType"


# ==================== TypeScript Interface Parser ====================


@dataclass
class Interface:
    name: str
    properties: List[Dict[str, str]]
    raw_definition: str
    base_interface: Optional[str] = None


@dataclass
class TypeAlias:
    name: str
    definition: str


@dataclass
class TypeScriptEnum:
    name: str
    members: List[tuple[str, str]]  # List of (member_name, value) pairs.


def parse_type_aliases(content: str) -> Dict[str, str]:
    """Parse type alias declarations from TypeScript content with proper namespace tracking."""
    type_aliases = {}
    lines = content.split("\n")
    i = 0
    namespace_stack = []
    namespace_brace_depth = []  # Track brace depth for each namespace.
    current_brace_depth = 0

    while i < len(lines):
        line = lines[i].strip()

        # Count braces to track nesting depth.
        open_braces = line.count("{")
        close_braces = line.count("}")

        # Track namespace entries.
        namespace_match = re.match(r"(export |declare )?namespace (\w+)", line)
        if namespace_match:
            namespace_name = namespace_match.group(2)
            namespace_stack.append(namespace_name)
            # After this line, we'll be one level deeper.
            namespace_brace_depth.append(current_brace_depth + open_braces)

        # Update current brace depth.
        current_brace_depth += open_braces - close_braces

        # Check if we've exited any namespaces.
        while namespace_stack and current_brace_depth < namespace_brace_depth[-1]:
            namespace_stack.pop()
            namespace_brace_depth.pop()

        # Find type alias declarations: export type Show = boolean | ...
        type_match = re.match(r"export type (\w+)\s*=\s*(.+)", line)
        if type_match:
            type_name = type_match.group(1)
            type_def = type_match.group(2).rstrip(";")

            # Build qualified name with namespace (skip main uPlot namespace).
            relevant_namespaces = [ns for ns in namespace_stack if ns != "uPlot"]
            if relevant_namespaces:
                qualified_name = ".".join(relevant_namespaces + [type_name])
                type_aliases[qualified_name] = type_def
                # Also add unqualified name for fallback.
                type_aliases[type_name] = type_def
            else:
                type_aliases[type_name] = type_def

        i += 1

    return type_aliases


def parse_enums(content: str) -> Dict[str, TypeScriptEnum]:
    """Parse const enum declarations from TypeScript content."""
    enums = {}
    lines = content.split("\n")
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        # Find const enum declarations.
        enum_match = re.match(r"export const enum (\w+)", line)
        if enum_match:
            enum_name = enum_match.group(1)

            # Extract enum body.
            enum_members = []
            i += 1

            while i < len(lines):
                current_line = lines[i].strip()

                if current_line == "}":
                    break

                # Parse enum member: Name = value (either number or string).
                # Handle both numeric and string values
                member_match = re.match(r"(\w+)\s*=\s*(.+?)(?:,.*)?$", current_line)
                if member_match:
                    member_name = member_match.group(1)
                    value = member_match.group(2).strip().rstrip(",")
                    enum_members.append((member_name, value))

                i += 1

            if enum_members:
                enums[enum_name] = TypeScriptEnum(name=enum_name, members=enum_members)

        i += 1

    return enums


def parse_interfaces(content: str) -> List[Interface]:
    """Parse interfaces from TypeScript content with namespace support."""
    interfaces = []
    lines = content.split("\n")
    i = 0
    namespace_stack = []

    while i < len(lines):
        line = lines[i].strip()

        # Track namespace entries.
        namespace_match = re.match(r"(export |declare )?namespace (\w+)", line)
        if namespace_match:
            namespace_name = namespace_match.group(2)
            namespace_stack.append(namespace_name)
            i += 1
            continue

        # Track namespace exits (simple heuristic).
        if line == "}" and namespace_stack:
            indent = len(lines[i]) - len(lines[i].lstrip())
            # If we're at low indentation, probably exiting a namespace.
            if indent <= len(namespace_stack):
                namespace_stack.pop()

        # Find interface declarations (both exported and internal).
        interface_match = re.match(r"(export )?interface (\w+)", line)
        if interface_match:
            interface_name = interface_match.group(2)

            # Build qualified name with namespace (skip main uPlot namespace for top-level exports).
            if namespace_stack and not (
                len(namespace_stack) == 1 and namespace_stack[0] == "uPlot"
            ):
                qualified_name = "_".join(namespace_stack + [interface_name])
            else:
                qualified_name = interface_name

            # Check for inheritance using extends keyword
            extends_match = re.search(r"extends\s+([A-Za-z_][A-Za-z0-9_.<>]*)", line)
            base_interface = None
            if extends_match:
                base_interface = extends_match.group(1)

            # Extract interface body.
            body_lines = []
            brace_count = 0
            started = False

            while i < len(lines):
                current_line = lines[i]

                if "{" in current_line:
                    started = True

                if started:
                    body_lines.append(current_line)
                    brace_count += current_line.count("{") - current_line.count("}")
                    if brace_count == 0:
                        break

                i += 1

            # Parse properties.
            properties = parse_properties("\n".join(body_lines))

            interfaces.append(
                Interface(
                    name=qualified_name,
                    properties=properties,
                    raw_definition="\n".join(body_lines),
                    base_interface=base_interface,
                )
            )

        i += 1

    return interfaces


def parse_properties(interface_body: str) -> List[Dict[str, str]]:
    """Parse properties from interface body."""
    properties = []
    lines = interface_body.split("\n")

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if not line or line in ["{", "}"]:
            i += 1
            continue

        # Collect comments.
        comment = ""
        while (
            line.startswith("/**")
            or line.startswith("//")
            or (line.startswith("*") and ":" not in line)
        ):
            if line.startswith("/**"):
                comment = line[3:].strip()
            elif line.startswith("//"):
                comment = line[2:].strip()
            elif line.startswith("*"):
                comment = line[1:].strip()

            if comment.endswith("*/"):
                comment = comment[:-2].strip()

            i += 1
            line = lines[i].strip() if i < len(lines) else ""

        # Parse index signatures like [key: string]: Scale.
        if line.startswith("[") and "]:" in line:
            # Extract index signature: [key: string]: Scale -> key_type: string, value_type: Scale.
            match = re.match(r"^\[([^:]+):\s*([^\]]+)\]:\s*(.+);?$", line.strip())
            if match:
                key_name = match.group(1).strip()
                key_type = match.group(2).strip()
                value_type = match.group(3).strip().rstrip(";").rstrip(",")

                # Create a special property to indicate this is an index signature.
                properties.append(
                    {
                        "name": "__index_signature__",
                        "type": f"[{key_type}, {value_type}]",  # Store both key and value types.
                        "optional": False,
                        "comment": f"Index signature: {key_name} -> {value_type}",
                    }
                )

        # Parse regular property line.
        elif ":" in line and not line.startswith("["):
            # Handle multi-line properties - but be careful about parsing.
            prop_line = line

            # Only continue to next line if this line doesn't end with ; or ,.
            while (
                not prop_line.rstrip().endswith(";")
                and not prop_line.rstrip().endswith(",")
                and i + 1 < len(lines)
            ):
                i += 1
                next_line = lines[i].strip()
                # Stop if next line looks like a new property or comment.
                if (
                    ":" in next_line
                    or next_line.startswith("/**")
                    or next_line.startswith("//")
                ):
                    i -= 1  # Back up.
                    break
                prop_line += " " + next_line

            prop = parse_property(prop_line, comment)
            if prop:
                properties.append(prop)

        i += 1

    return properties


def parse_property(
    line: str, comment: str = ""
) -> Optional[Dict[str, Union[str, bool]]]:
    """Parse a single property line."""
    line = line.strip().rstrip(";").rstrip(",")

    if ":" not in line:
        return None

    optional = "?" in line
    parts = line.split(":", 1)
    if len(parts) != 2:
        return None

    name = parts[0].replace("?", "").strip()
    type_str = parts[1].strip()

    # Clean up type string - remove everything after comma or comment.
    if "," in type_str:
        type_str = type_str.split(",")[0].strip()

    # Remove inline comments.
    if "//" in type_str:
        type_str = type_str.split("//")[0].strip()

    if "/*" in type_str:
        type_str = type_str.split("/*")[0].strip()

    # Handle readonly.
    if name.startswith("readonly "):
        name = name[9:]

    # Validate property name.
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
        return None

    return {"name": name, "type": type_str, "optional": optional, "comment": comment}


def camel_to_screaming_snake(name: str) -> str:
    """Convert camelCase to SCREAMING_SNAKE_CASE for enum members."""
    # Insert underscores before capital letters (except the first)
    result = re.sub(r"(?<!^)(?=[A-Z])", "_", name)
    return result.upper()


def topological_sort_interfaces(interfaces: List[Interface]) -> List[Interface]:
    """Sort interfaces in topological order so dependencies come before dependents."""
    interface_map = {iface.name: iface for iface in interfaces}
    interface_names = set(interface_map.keys())

    # Build dependency graph: interface -> set of interfaces it depends on.
    dependencies = defaultdict(set)
    dependents = defaultdict(set)  # Reverse mapping.

    for interface in interfaces:
        interface_name = interface.name
        deps = set()

        # Find all interface dependencies in properties.
        for prop in interface.properties:
            # Skip index signatures.
            if prop["name"] == "__index_signature__":
                continue

            prop_type = prop["type"]

            # Find interface references in the type string.
            # Look for exact interface names (including underscore names like Legend_Markers).
            for other_name in interface_names:
                if other_name != interface_name:
                    # Use word boundary regex to ensure exact matches.
                    # But exclude patterns like "Legend.Something" which are type aliases, not interface refs.
                    if re.search(r"\b" + re.escape(other_name) + r"\b", prop_type):
                        # Make sure it's not a qualified name like "Legend.Width".
                        # By checking if it's followed by a dot and identifier.
                        full_match = re.search(
                            r"\b"
                            + re.escape(other_name)
                            + r"(\.[A-Za-z_][A-Za-z0-9_]*)?",
                            prop_type,
                        )
                        if full_match and full_match.group(1):
                            # This is a qualified name like "Legend.Width", not an interface reference.
                            continue
                        deps.add(other_name)

            # Also look for namespaced references that map to underscore names.
            # e.g., "Legend.Markers" should create dependency on "Legend_Markers".
            namespaced_refs = re.findall(
                r"\b[A-Z][a-zA-Z0-9_]*\.[A-Z][a-zA-Z0-9_]*\b", prop_type
            )
            for ref in namespaced_refs:
                underscore_name = ref.replace(".", "_")
                if (
                    underscore_name in interface_names
                    and underscore_name != interface_name
                ):
                    deps.add(underscore_name)

        dependencies[interface_name] = deps
        for dep in deps:
            dependents[dep].add(interface_name)

    # Kahn's algorithm for topological sorting.
    # Start with interfaces that have no dependencies.
    in_degree = {iface.name: len(dependencies[iface.name]) for iface in interfaces}
    queue = deque([name for name, degree in in_degree.items() if degree == 0])
    result = []

    while queue:
        current = queue.popleft()
        result.append(interface_map[current])

        # Remove this interface from its dependents' dependency lists.
        for dependent in dependents[current]:
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                queue.append(dependent)

    # Check for cycles.
    if len(result) != len(interfaces):
        remaining = set(interface_map.keys()) - {iface.name for iface in result}
        print(f"Warning: Circular dependencies detected in interfaces: {remaining}")
        # Add remaining interfaces in original order.
        for interface in interfaces:
            if interface.name in remaining:
                result.append(interface)

    return result


def resolve_inheritance(interfaces: List[Interface]) -> List[Interface]:
    """Resolve interface inheritance by copying properties from base interfaces."""
    interface_map = {iface.name: iface for iface in interfaces}
    resolved_interfaces = []

    # Create a simple resolution that doesn't cause loops.
    for interface in interfaces:
        if interface.base_interface:
            # Look for the base interface with proper namespacing.
            base_name = interface.base_interface
            base_interface = None

            # Try with namespace prefix if the current interface has one.
            current_namespace = ""
            if "_" in interface.name:
                current_namespace = interface.name.split("_")[0] + "_"

            # Try exact match first.
            if base_name in interface_map:
                base_interface = interface_map[base_name]
            else:
                namespaced_base = current_namespace + base_name
                if namespaced_base in interface_map:
                    base_interface = interface_map[namespaced_base]

            if base_interface:
                # Recursively resolve base interface first if it has inheritance.
                resolved_base = base_interface
                if base_interface.base_interface:
                    # Find the base's base.
                    base_base_name = base_interface.base_interface
                    base_base_interface = None

                    if base_base_name in interface_map:
                        base_base_interface = interface_map[base_base_name]
                    else:
                        namespaced_base_base = current_namespace + base_base_name
                        if namespaced_base_base in interface_map:
                            base_base_interface = interface_map[namespaced_base_base]

                    if base_base_interface:
                        # Combine base's base properties with base properties.
                        combined_base_props = base_base_interface.properties.copy()
                        base_prop_names = {
                            prop["name"] for prop in base_interface.properties
                        }
                        combined_base_props = [
                            prop
                            for prop in combined_base_props
                            if prop["name"] not in base_prop_names
                        ]
                        combined_base_props.extend(base_interface.properties)

                        resolved_base = Interface(
                            name=base_interface.name,
                            properties=combined_base_props,
                            raw_definition=base_interface.raw_definition,
                            base_interface=None,
                        )

                # Copy properties from resolved base interface.
                combined_properties = resolved_base.properties.copy()

                # Add properties from current interface (they override base properties).
                current_prop_names = {prop["name"] for prop in interface.properties}
                combined_properties = [
                    prop
                    for prop in combined_properties
                    if prop["name"] not in current_prop_names
                ]
                combined_properties.extend(interface.properties)

                resolved_interface = Interface(
                    name=interface.name,
                    properties=combined_properties,
                    raw_definition=interface.raw_definition,
                    base_interface=None,  # Clear base interface after resolution.
                )
                resolved_interfaces.append(resolved_interface)
            else:
                # Base interface not found, keep as is.
                resolved_interfaces.append(interface)
        else:
            # No inheritance, keep as is.
            resolved_interfaces.append(interface)

    return resolved_interfaces


def find_needed_interfaces(
    interfaces: List[Interface], start: str = "Options"
) -> Set[str]:
    """Find interfaces needed starting from the given interface."""
    needed = set()
    to_process = [start]
    interface_map = {iface.name: iface for iface in interfaces}

    while to_process:
        current = to_process.pop()
        if current in needed or current not in interface_map:
            continue

        needed.add(current)
        current_interface = interface_map[current]

        # Also include base interfaces for inheritance
        if current_interface.base_interface:
            base_name = current_interface.base_interface
            # Try exact match first.
            if base_name in interface_map and base_name not in needed:
                to_process.append(base_name)
            else:
                # Try with namespace prefix.
                current_namespace = ""
                if "_" in current:
                    current_namespace = current.split("_")[0] + "_"

                namespaced_base = current_namespace + base_name
                if namespaced_base in interface_map and namespaced_base not in needed:
                    to_process.append(namespaced_base)

        # Look for interface references in properties.
        for prop in current_interface.properties:
            # Find PascalCase words that might be interface names.
            words = re.findall(r"\b[A-Z][a-zA-Z0-9_]*\b", prop["type"])
            for word in words:
                if word in interface_map and word not in needed:
                    to_process.append(word)

            # Also look for namespaced interfaces like Axis.Grid -> Axis_Grid.
            namespaced_refs = re.findall(
                r"\b[A-Z][a-zA-Z0-9_]*\.[A-Z][a-zA-Z0-9_]*\b", prop["type"]
            )
            for ref in namespaced_refs:
                underscore_name = ref.replace(".", "_")
                if underscore_name in interface_map and underscore_name not in needed:
                    to_process.append(underscore_name)

    return needed


def collect_used_enums(
    interfaces: List[Interface],
    enums: Dict[str, TypeScriptEnum],
    type_aliases: Dict[str, str],
) -> Set[str]:
    """Collect enum names that are actually used in the TypedDict definitions."""
    used_enums = set()

    # Create set of known interface names for type conversion
    known_interface_names = {iface.name for iface in interfaces} | set(enums.keys())

    for interface in interfaces:
        for prop in interface.properties:
            if prop["name"] == "__index_signature__":
                continue

            # Convert the property type and see what enums it references (using enum classes for analysis).
            converted_type = convert_type_with_ast(
                prop["type"],
                known_interface_names,
                type_aliases,
                enums,
                use_literal_enums=False,
            )

            # Look for enum references in the converted type.
            for enum_name in enums.keys():
                if re.search(rf"\b{re.escape(enum_name)}\b", converted_type):
                    used_enums.add(enum_name)

    return used_enums


def generate_python_code(
    interfaces: List[Interface], content: str, use_literal_enums: bool = True
) -> str:
    """Generate clean Python TypedDict code using AST-based type conversion."""

    # Find needed interfaces.
    needed_names = find_needed_interfaces(interfaces, "Options")
    needed_interfaces = [iface for iface in interfaces if iface.name in needed_names]

    # Resolve inheritance relationships
    needed_interfaces = resolve_inheritance(needed_interfaces)

    # Filter out width and height from Options interface.
    for interface in needed_interfaces:
        if interface.name == "Options":
            interface.properties = [
                prop
                for prop in interface.properties
                if prop["name"] not in ["width", "height"]
            ]

    # Sort interfaces in topological order to eliminate forward references.
    needed_interfaces = topological_sort_interfaces(needed_interfaces)

    # Parse enums and type aliases from content.
    all_enums = parse_enums(content)
    type_aliases = parse_type_aliases(content)

    # Only keep enums that are actually used in the final interfaces (if generating enum classes).
    if use_literal_enums:
        # When using literal enums, we still need all enums for conversion but won't generate classes.
        enums = all_enums
    else:
        used_enum_names = collect_used_enums(needed_interfaces, all_enums, type_aliases)
        enums = {
            name: enum_obj
            for name, enum_obj in all_enums.items()
            if name in used_enum_names
        }

    # Create set of known interface names for better type conversion.
    known_interface_names = {iface.name for iface in needed_interfaces} | set(
        enums.keys()
    )

    lines = [
        '"""Clean uPlot TypedDict definitions."""',
        "",
        "# =========================================================================",
        "# WARNING: This file is auto-generated by _generate_types.py",
        "# DO NOT EDIT MANUALLY - Your changes will be overwritten!",
        "# To modify types, edit the generation script or the TypeScript definitions",
        "# =========================================================================",
        "",
        "from __future__ import annotations",
        "",
    ]

    # Add imports based on what we're generating.
    if enums and not use_literal_enums:
        lines.append("from enum import IntEnum, StrEnum")
    lines.extend(
        [
            "from typing import Any, Dict, List, Literal, Tuple, Union",
            "from typing_extensions import Never, Required, TypedDict",
            "",
            "# Semantic type aliases for unsupported/complex TypeScript patterns",
            "JSCallback = Never  # JavaScript function signatures",
            "DOMElement = Never  # DOM elements (HTMLElement, etc.)",
            "CSSValue = str  # CSS property values",
            "UnknownType = Any  # Unknown interface references",
            "",
        ]
    )

    # Generate Enum classes and type aliases (only if not using literal enums).
    if enums and not use_literal_enums:
        lines.append("# Enum definitions")
        for enum_name, enum_obj in enums.items():
            # Determine if this is a string enum or numeric enum.
            is_string_enum = any(
                value.startswith("'") or value.startswith('"')
                for _, value in enum_obj.members
            )

            if is_string_enum:
                lines.append(f"class {enum_name}(StrEnum):")
                for member_name, value in enum_obj.members:
                    # For string enums, use UPPER_CASE naming convention.
                    upper_name = member_name.upper()
                    lines.append(f"    {upper_name} = {value}")
            else:
                lines.append(f"class {enum_name}(IntEnum):")
                for member_name, value in enum_obj.members:
                    snake_case_name = camel_to_screaming_snake(member_name)
                    lines.append(f"    {snake_case_name} = {value}")
            lines.append("")

    # Generate TypedDict classes and collect type aliases.
    type_aliases_to_generate = []
    interface_names = {iface.name for iface in needed_interfaces}

    # First pass: collect type aliases that need to be generated.
    for interface in needed_interfaces:
        name = interface.name
        properties = interface.properties

        # Check for index signatures.
        index_signatures = [p for p in properties if p["name"] == "__index_signature__"]
        regular_properties = [
            p for p in properties if p["name"] != "__index_signature__"
        ]

        # Handle interfaces with only index signatures (like Scales).
        if index_signatures and not regular_properties:
            # Store for generation before classes.
            index_sig = index_signatures[0]
            # Parse [key_type, value_type] from the stored format.
            match = re.match(r"^\[([^,]+),\s*(.+)\]$", index_sig["type"])
            if match:
                key_type = convert_type_with_ast(
                    match.group(1).strip(),
                    known_interface_names,
                    type_aliases,
                    enums,
                    use_literal_enums,
                )
                value_type = convert_type_with_ast(
                    match.group(2).strip(),
                    known_interface_names,
                    type_aliases,
                    enums,
                    use_literal_enums,
                )
                type_aliases_to_generate.append(
                    (name, index_sig["comment"], key_type, value_type)
                )

    # Generate type aliases first (using string quotes for forward references).
    if type_aliases_to_generate:
        lines.append("# Type aliases for index signatures")
        for name, comment, key_type, value_type in type_aliases_to_generate:
            # Use string quotes to allow forward references.
            value_type_str = (
                f'"{value_type}"' if value_type in interface_names else value_type
            )
            # Add period to comment if it doesn't already end with punctuation.
            if comment and not comment.rstrip().endswith((".", "!", "?", ":", ";")):
                comment += "."
            lines.extend(
                [f"# {comment}", f"{name} = Dict[{key_type}, {value_type_str}]", ""]
            )

    # Second pass: generate TypedDict classes.
    type_alias_names = {name for name, _, _, _ in type_aliases_to_generate}

    for interface in needed_interfaces:
        name = interface.name

        # Skip if this was already handled as a type alias.
        if name in type_alias_names:
            continue

        properties = interface.properties

        # Check for index signatures.
        index_signatures = [p for p in properties if p["name"] == "__index_signature__"]
        regular_properties = [
            p for p in properties if p["name"] != "__index_signature__"
        ]

        if not regular_properties:
            lines.append(f"{name} = TypedDict('{name}', {{}}, total=False)")
            lines.append('""":py:class:`~typing.TypedDict` type for uPlot."""')
            lines.append("")
            continue

        # Separate required and optional regular properties.
        required = [p for p in regular_properties if not p["optional"]]
        optional = [p for p in regular_properties if p["optional"]]

        # Generate functional TypedDict.
        lines.append(f"{name} = TypedDict('{name}', {{")

        # Add all properties (both required and optional).
        all_props = required + optional
        for i, prop in enumerate(all_props):
            prop_name = prop["name"]  # Use original name, no escaping needed in quotes.

            # Use AST-based type conversion.
            prop_type = convert_type_with_ast(
                prop["type"],
                known_interface_names,
                type_aliases,
                enums,
                use_literal_enums,
            )

            # Add comment above the property.
            if prop["comment"]:
                comment = prop["comment"]
                # Add period if comment doesn't already end with punctuation.
                if comment and not comment.rstrip().endswith((".", "!", "?", ":", ";")):
                    comment += "."
                lines.append(f"    # {comment}")

            # Handle required vs optional.
            if required and optional:  # Mixed case - use Required[] for required props.
                if prop in required:
                    type_annotation = f"Required[{prop_type}]"
                else:
                    type_annotation = prop_type
            else:
                # All required or all optional.
                type_annotation = prop_type

            # Add trailing comma except for last item.
            comma = "," if i < len(all_props) - 1 else ""
            lines.append(f"    '{prop_name}': {type_annotation}{comma}")

        # Set total=False if we have any optional properties.
        total_param = ", total=False" if optional else ""
        lines.append(f"}}{total_param})")

        # Add docstring after the TypedDict definition.
        lines.append('""":py:class:`~typing.TypedDict` type for uPlot."""')
        lines.append("")

    return "\n".join(lines)


def main(
    input_file: Path = Path("uPlot.d.ts"),
    output_file: Path = Path("_uplot_types.py"),
    use_literal_enums: bool = True,
) -> None:
    """Generate clean Python TypedDict types from TypeScript definitions."""

    print(f"Reading {input_file}")
    content = input_file.read_text()

    print("Parsing interfaces...")
    interfaces = parse_interfaces(content)
    print(f"Found {len(interfaces)} interfaces")

    print("Generating Python code...")
    enum_mode = "Literal types" if use_literal_enums else "Enum classes"
    print(f"Using {enum_mode} for enums")
    python_code = generate_python_code(interfaces, content, use_literal_enums)

    print(f"Writing to {output_file}")
    output_file.write_text(python_code)

    print("Running ruff format...")
    try:
        subprocess.run(["ruff", "format", str(output_file)], check=True)
        print("Formatting completed successfully")
    except subprocess.CalledProcessError as e:
        print(f"Warning: ruff format failed with exit code {e.returncode}")
    except FileNotFoundError:
        print("Warning: ruff not found, skipping formatting")

    print("Done!")


@dataclass
class Config:
    """Configuration for generating Python TypedDict types from TypeScript definitions."""

    input: Path = Path("uPlot.d.ts")
    """Input TypeScript file"""

    output: Path = Path("_uplot_types.py")
    """Output Python file"""

    enum_classes: bool = False
    """Generate enum classes instead of Literal types"""


if __name__ == "__main__":
    import tyro

    config = tyro.cli(Config)

    main(
        input_file=config.input,
        output_file=config.output,
        use_literal_enums=not config.enum_classes,
    )
