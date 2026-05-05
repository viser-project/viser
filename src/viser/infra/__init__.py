""":mod:`viser.infra` provides WebSocket-based communication infrastructure.

We implement abstractions for:
- Launching a WebSocket+HTTP server on a shared port.
- Registering callbacks for connection events and incoming messages.
- Asynchronous message sending, both broadcasted and to individual clients.
- Defining dataclass-based message types.
- Translating Python message types to TypeScript interfaces.

These are what `viser` runs on under-the-hood, and generally won't be useful unless
you're building a web-based application from scratch.
"""

from ._infra import ClientId as ClientId
from ._infra import StateSerializer as StateSerializer
from ._infra import WebsockClientConnection as WebsockClientConnection
from ._infra import WebsockMessageHandler as WebsockMessageHandler
from ._infra import WebsockServer as WebsockServer
from ._messages import Message as Message
from ._typescript_interface_gen import EditorHidden as EditorHidden
from ._typescript_interface_gen import (
    TypeScriptAnnotationOverride as TypeScriptAnnotationOverride,
)
from ._typescript_interface_gen import (
    generate_typescript_interfaces as generate_typescript_interfaces,
)
