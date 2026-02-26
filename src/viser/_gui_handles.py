from __future__ import annotations

import base64
import dataclasses
import re
import time
import uuid
import warnings
from collections.abc import Coroutine
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Generic,
    Iterable,
    Literal,
    Tuple,
    TypeVar,
    overload,
)

import imageio.v3 as iio
import numpy as np
from typing_extensions import Protocol, override

from ._assignable_props_api import AssignablePropsBase
from ._icons import svg_from_icon
from ._icons_enum import IconName
from ._messages import (
    GuiBaseProps,
    GuiButtonGroupProps,
    GuiButtonProps,
    GuiCheckboxProps,
    GuiCloseModalMessage,
    GuiDropdownProps,
    GuiFolderProps,
    GuiHtmlProps,
    GuiImageProps,
    GuiMarkdownProps,
    GuiMultiSliderProps,
    GuiNumberProps,
    GuiPlotlyProps,
    GuiProgressBarProps,
    GuiRemoveMessage,
    GuiRgbaProps,
    GuiRgbProps,
    GuiSliderProps,
    GuiTabGroupProps,
    GuiTextProps,
    GuiUpdateMessage,
    GuiUploadButtonProps,
    GuiUplotProps,
    GuiVector2Props,
    GuiVector3Props,
)
from ._scene_api import _encode_image_binary
from .infra import ClientId

if TYPE_CHECKING:
    import plotly.graph_objects as go

    from ._gui_api import GuiApi
    from ._viser import ClientHandle


T = TypeVar("T")
TGuiHandle = TypeVar("TGuiHandle", bound="_GuiInputHandle")
NoneOrCoroutine = TypeVar("NoneOrCoroutine", None, Coroutine)


def _make_uuid() -> str:
    """Return a unique ID for referencing GUI elements."""
    return str(uuid.uuid4())


class GuiContainerProtocol(Protocol):
    _children: dict[str, SupportsRemoveProtocol] = dataclasses.field(
        default_factory=dict
    )


class SupportsRemoveProtocol(Protocol):
    def remove(self) -> None: ...


class GuiPropsProtocol(Protocol):
    order: float


@dataclasses.dataclass
class _GuiHandleState(Generic[T]):
    """Internal API for GUI elements."""

    uuid: str
    gui_api: GuiApi
    value: T
    props: GuiPropsProtocol
    parent_container_id: str
    """Container that this GUI input was placed into."""

    update_timestamp: float = 0.0
    update_cb: list[Callable[[GuiEvent], None | Coroutine]] = dataclasses.field(
        default_factory=list
    )
    """Registered functions to call when this input is updated."""

    is_button: bool = False
    """Indicates a button element, which requires special handling."""

    sync_cb: Callable[[ClientId, dict[str, Any]], None] | None = None
    """Callback for synchronizing inputs across clients."""

    removed: bool = False


@dataclasses.dataclass
class _GuiButtonHandleState(_GuiHandleState[bool]):
    """Internal API for button GUI elements with hold callback support."""

    hold_cbs_from_freq: dict[float, list[Callable[[GuiEvent], None | Coroutine]]] = (
        dataclasses.field(default_factory=dict)
    )
    """Mapping from frequency (Hz) to list of callbacks to call when button is held."""


# Not exported for now because some GUI handles don't currently inhert from
# `_GuiHandle`: notably `GuiModalHandle` and `GuiTabHandle`. These would fail
# isinstance checks, which would be confusing!
class _GuiHandle(Generic[T], AssignablePropsBase[_GuiHandleState]):
    def __init__(self, impl: _GuiHandleState[T]) -> None:
        super().__init__(impl=impl)
        parent = self._impl.gui_api._container_handle_from_uuid[
            self._impl.parent_container_id
        ]
        parent._children[self._impl.uuid] = self

        if isinstance(self, _GuiInputHandle):
            self._impl.gui_api._gui_input_handle_from_uuid[self._impl.uuid] = self

    @override
    def _queue_update(self, name: str, value: Any) -> None:
        self._impl.gui_api._websock_interface.queue_message(
            GuiUpdateMessage(self._impl.uuid, {name: value})
        )

    def remove(self) -> None:
        """Permanently remove this GUI element from the visualizer."""

        # Warn if already removed.
        if self._impl.removed:
            warnings.warn(
                f"Attempted to remove an already removed {self.__class__.__name__}.",
                stacklevel=2,
            )
            return
        self._impl.removed = True

        # Send remove to client(s) + update internal state.
        gui_api = self._impl.gui_api
        gui_api._websock_interface.get_message_buffer().remove_from_buffer(
            # Don't send outdated GUI updates to new clients.
            # This is brittle...
            lambda message: getattr(message, "uuid", None) == self._impl.uuid
        )
        gui_api._websock_interface.queue_message(GuiRemoveMessage(self._impl.uuid))
        parent = gui_api._container_handle_from_uuid[self._impl.parent_container_id]
        parent._children.pop(self._impl.uuid)

        if isinstance(self, _GuiInputHandle):
            gui_api._gui_input_handle_from_uuid.pop(self._impl.uuid)


class _GuiInputHandle(
    _GuiHandle[T],
    Generic[T],
    GuiBaseProps,
):
    @property
    def value(self) -> T:
        """Value of the GUI input. Synchronized automatically when assigned.

        :meta private:
        """
        # ^Note: we mark this property as private for Sphinx because I haven't
        # been able to get it to resolve the TypeVar in a readable way.
        # For the documentation's sake, we'll be manually adding ::attribute directives below.
        return self._impl.value

    @value.setter
    def value(self, value: T | np.ndarray) -> None:
        if isinstance(value, np.ndarray):
            assert len(value.shape) <= 1, f"{value.shape} should be at most 1D!"
            value = tuple(map(float, value))  # type: ignore

        # Send to client, except for buttons.
        if not self._impl.is_button:
            self._impl.gui_api._websock_interface.queue_message(
                GuiUpdateMessage(self._impl.uuid, {"value": value})
            )

        # Set internal state. We automatically convert numpy arrays to the expected
        # internal type. (eg 1D arrays to tuples)
        self._impl.value = type(self._impl.value)(value)  # type: ignore
        self._impl.update_timestamp = time.time()

        # Call update callbacks.
        for cb in self._impl.update_cb:
            # As a design decision: we choose to call update callbacks
            # synchronously instead of in the thread pool. It's rare that there
            # are significant blocking callbacks for GUI updates; this also
            # reduces the likelihood of many common race conditions.
            cb_out = cb(GuiEvent(client_id=None, client=None, target=self))
            if isinstance(cb_out, Coroutine):
                self._impl.gui_api._event_loop.create_task(cb_out)

    @property
    def update_timestamp(self) -> float:
        """Read-only timestamp when this input was last updated."""
        return self._impl.update_timestamp


StringType = TypeVar("StringType", bound=str)


# GuiInputHandle[T] is used for all inputs except for buttons.
#
# We inherit from _GuiInputHandle to special-case buttons because the usage semantics
# are slightly different: we have `on_click()` instead of `on_update()`.
class GuiInputHandle(_GuiInputHandle[T], Generic[T]):
    """A handle is created for each GUI element that is added in `viser`.
    Handles can be used to read and write state.

    When a GUI element is added via :attr:`ViserServer.gui`, state is
    synchronized between all connected clients. When a GUI element is added via
    :attr:`ClientHandle.gui`, state is local to a specific client.
    """

    def on_update(
        self: TGuiHandle, func: Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]
    ) -> Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]:
        """Attach a function to call when a GUI input is updated.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl.update_cb.append(func)
        return func

    def remove_update_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove update callbacks from the GUI input.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl.update_cb.clear()
        else:
            self._impl.update_cb = [cb for cb in self._impl.update_cb if cb != callback]


class GuiCheckboxHandle(GuiInputHandle[bool], GuiCheckboxProps):
    """Handle for checkbox inputs.

    .. attribute:: value
       :type: bool

       Value of the input. Synchronized automatically when assigned.
    """


class GuiTextHandle(GuiInputHandle[str], GuiTextProps):
    """Handle for text inputs.

    .. attribute:: value
       :type: str

       Value of the input. Synchronized automatically when assigned.
    """


IntOrFloat = TypeVar("IntOrFloat", int, float)


class GuiNumberHandle(GuiInputHandle[IntOrFloat], Generic[IntOrFloat], GuiNumberProps):
    """Handle for number inputs.

    .. attribute:: value
       :type: IntOrFloat

       Value of the input. Synchronized automatically when assigned.
    """


class GuiSliderHandle(GuiInputHandle[IntOrFloat], Generic[IntOrFloat], GuiSliderProps):
    """Handle for slider inputs.

    .. attribute:: value
       :type: IntOrFloat

       Value of the input. Synchronized automatically when assigned.
    """


class GuiMultiSliderHandle(
    GuiInputHandle[Tuple[IntOrFloat, ...]], Generic[IntOrFloat], GuiMultiSliderProps
):
    """Handle for multi-slider inputs.

    .. attribute:: value
       :type: tuple[IntOrFloat, ...]

       Value of the input. Synchronized automatically when assigned.
    """


class GuiRgbHandle(GuiInputHandle[Tuple[int, int, int]], GuiRgbProps):
    """Handle for RGB color inputs.

    .. attribute:: value
       :type: tuple[int, int, int]

       Value of the input. Synchronized automatically when assigned.
    """


class GuiRgbaHandle(GuiInputHandle[Tuple[int, int, int, int]], GuiRgbaProps):
    """Handle for RGBA color inputs.

    .. attribute:: value
       :type: tuple[int, int, int, int]

       Value of the input. Synchronized automatically when assigned.
    """


class GuiVector2Handle(GuiInputHandle[Tuple[float, float]], GuiVector2Props):
    """Handle for 2D vector inputs.

    .. attribute:: value
       :type: tuple[float, float]

       Value of the input. Synchronized automatically when assigned.
    """


class GuiVector3Handle(GuiInputHandle[Tuple[float, float, float]], GuiVector3Props):
    """Handle for 3D vector inputs.

    .. attribute:: value
       :type: tuple[float, float, float]

       Value of the input. Synchronized automatically when assigned.
    """


@dataclasses.dataclass(frozen=True)
class GuiEvent(Generic[TGuiHandle]):
    """Information associated with a GUI event, such as an update or click.

    Passed as input to callback functions."""

    client: ClientHandle | None
    """Client that triggered this event."""
    client_id: int | None
    """ID of client that triggered this event."""
    target: TGuiHandle
    """GUI element that was affected."""


class GuiButtonHandle(_GuiInputHandle[bool], GuiButtonProps):
    """Handle for a button input in our visualizer.

    .. attribute:: value
       :type: bool

       Value of the button. Set to `True` when the button is pressed. Can be manually set back to `False`.
    """

    def __init__(self, _impl: _GuiButtonHandleState, _icon: IconName | None):
        super().__init__(impl=_impl)
        self._icon = _icon

    @property
    def _button_impl(self) -> _GuiButtonHandleState:
        """Access the button-specific implementation state."""
        assert isinstance(self._impl, _GuiButtonHandleState)
        return self._impl

    @property
    def icon(self) -> IconName | None:
        """Icon to display on the button. When set to None, no icon is displayed."""
        return self._icon

    @icon.setter
    def icon(self, icon: IconName | None) -> None:
        self._icon = icon
        self._icon_html = None if icon is None else svg_from_icon(icon)

    def on_click(
        self: TGuiHandle, func: Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]
    ) -> Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]:
        """Attach a function to call when a button is pressed.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl.update_cb.append(func)
        return func

    # Type alias for button hold callbacks.
    _HoldCallback = Callable[["GuiEvent[GuiButtonHandle]"], "None | Coroutine"]

    @overload
    def on_hold(
        self,
        func: None = None,
        callback_hz: float = 10.0,
    ) -> Callable[[_HoldCallback], _HoldCallback]: ...

    @overload
    def on_hold(
        self,
        func: _HoldCallback,
        callback_hz: float = 10.0,
    ) -> _HoldCallback: ...

    def on_hold(
        self,
        func: _HoldCallback | None = None,
        callback_hz: float = 10.0,
    ) -> Callable[[_HoldCallback], _HoldCallback] | _HoldCallback:
        """Attach a function to call repeatedly while a button is held down.

        The callback will be triggered immediately when the button is pressed,
        and then repeatedly at the specified frequency until released.

        Can be used as a decorator with or without arguments:
            @button.on_hold
            def callback(event): ...

            @button.on_hold(callback_hz=30.0)
            def callback(event): ...

        Or called directly:
            button.on_hold(callback)
            button.on_hold(callback, callback_hz=30.0)

        Args:
            func: The callback function to attach. If None, returns a decorator.
            callback_hz: The frequency in Hz at which to call the callback while
                the button is held. Defaults to 10.0 Hz.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        button_impl = self._button_impl

        def register_callback(
            f: GuiButtonHandle._HoldCallback,
        ) -> GuiButtonHandle._HoldCallback:
            # Add callback to the frequency-specific list.
            if callback_hz not in button_impl.hold_cbs_from_freq:
                button_impl.hold_cbs_from_freq[callback_hz] = []
            button_impl.hold_cbs_from_freq[callback_hz].append(f)

            # Update the prop to notify client of new frequency.
            self._hold_callback_freqs = tuple(button_impl.hold_cbs_from_freq.keys())

            return f

        if func is not None:
            return register_callback(func)
        return register_callback


@dataclasses.dataclass
class UploadedFile:
    """Result of a file upload."""

    name: str
    """Name of the file."""
    content: bytes
    """Contents of the file."""


class GuiUploadButtonHandle(_GuiInputHandle[UploadedFile], GuiUploadButtonProps):
    """Handle for an upload file button in our visualizer.

    The `.value` attribute will be updated with the contents of uploaded files.

    .. attribute:: value
       :type: UploadedFile

       Value of the input. Contains information about the uploaded file.
    """

    def __init__(self, _impl: _GuiHandleState[UploadedFile], _icon: IconName | None):
        super().__init__(impl=_impl)
        self._icon = _icon

    @property
    def icon(self) -> IconName | None:
        """Icon to display on the upload button. When set to None, no icon is displayed."""
        return self._icon

    @icon.setter
    def icon(self, icon: IconName | None) -> None:
        self._icon = icon
        self._icon_html = None if icon is None else svg_from_icon(icon)

    def on_upload(
        self: TGuiHandle, func: Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]
    ) -> Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]:
        """Attach a function to call when a file is uploaded.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl.update_cb.append(func)
        return func


class GuiButtonGroupHandle(_GuiInputHandle[str], GuiButtonGroupProps):
    """Handle for a button group input in our visualizer.

    .. attribute:: value
       :type: str

       Value of the input. Represents the currently selected button in the group.
    """

    def on_click(
        self: TGuiHandle, func: Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]
    ) -> Callable[[GuiEvent[TGuiHandle]], NoneOrCoroutine]:
        """Attach a function to call when a button in the group is clicked.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl.update_cb.append(func)
        return func

    @property
    def disabled(self) -> bool:
        """Button groups cannot be disabled."""
        return False

    @disabled.setter
    def disabled(self, disabled: bool) -> None:  # type: ignore
        """Button groups cannot be disabled."""
        assert not disabled, "Button groups cannot be disabled."


class GuiDropdownHandle(
    GuiInputHandle[StringType], Generic[StringType], GuiDropdownProps
):
    """Handle for a dropdown-style GUI input in our visualizer.

    .. attribute:: value
       :type: StringType

       Value of the input. Represents the currently selected option in the dropdown.
    """

    @property
    def options(self) -> tuple[StringType, ...]:
        """Options for our dropdown. Synchronized automatically when assigned.

        For projects that care about typing: the static type of `options` should be
        consistent with the `StringType` associated with a handle. Literal types will be
        inferred where possible when handles are instantiated; for the most flexibility,
        we can declare handles as `GuiDropdownHandle[str]`.
        """
        assert isinstance(self._impl.props, GuiDropdownProps)
        return self._impl.props.options  # type: ignore

    @options.setter
    def options(self, options: Iterable[StringType]) -> None:  # type: ignore
        assert isinstance(self._impl.props, GuiDropdownProps)
        options = tuple(options)
        self._impl.props.options = options

        self._impl.gui_api._websock_interface.queue_message(
            GuiUpdateMessage(
                self._impl.uuid,
                {"options": options},
            )
        )
        if self.value not in options:
            self.value = options[0]


class GuiTabGroupHandle(_GuiHandle[None], GuiTabGroupProps):
    """Handle for a tab group. Call :meth:`add_tab()` to add a tab."""

    def __init__(self, _impl: _GuiHandleState[None]) -> None:
        super().__init__(impl=_impl)
        self._tab_handles: list[GuiTabHandle] = []

    def add_tab(self, label: str, icon: IconName | None = None) -> GuiTabHandle:
        """Add a tab. Returns a handle we can use to add GUI elements to it."""

        uuid = _make_uuid()

        # We may want to make this thread-safe in the future.
        out = GuiTabHandle(_parent=self, _id=uuid, _label=label, _icon=icon)

        self._tab_handles.append(out)
        self._tab_labels = self._tab_labels + (label,)
        self._tab_icons_html = self._tab_icons_html + (
            None if icon is None else svg_from_icon(icon),
        )
        self._tab_container_ids = tuple(handle._id for handle in self._tab_handles)
        return out

    def __post_init__(self) -> None:
        parent = self._impl.gui_api._container_handle_from_uuid[
            self._impl.parent_container_id
        ]
        parent._children[self._impl.uuid] = self

    def remove(self) -> None:
        """Remove this tab group and all contained GUI elements."""
        # Warn if already removed.
        if self._impl.removed:
            warnings.warn(
                f"Attempted to remove an already removed {self.__class__.__name__}.",
                stacklevel=2,
            )
            return
        self._impl.removed = True

        # Remove tabs, then self.
        for tab in tuple(self._tab_handles):
            tab.remove()
        gui_api = self._impl.gui_api
        gui_api._websock_interface.get_message_buffer().remove_from_buffer(
            # Don't send outdated GUI updates to new clients.
            lambda message: (
                isinstance(message, GuiUpdateMessage)
                and message.uuid == self._impl.uuid
            )
        )
        gui_api._websock_interface.queue_message(GuiRemoveMessage(self._impl.uuid))
        parent = gui_api._container_handle_from_uuid[self._impl.parent_container_id]
        parent._children.pop(self._impl.uuid)


@dataclasses.dataclass
class GuiTabHandle:
    """Use as a context to place GUI elements into a tab."""

    _parent: GuiTabGroupHandle
    _id: str  # Used as container ID of children.
    _label: str
    _icon: IconName | None
    _container_id_restore: str | None = None
    _children: dict[str, SupportsRemoveProtocol] = dataclasses.field(
        default_factory=dict
    )
    _removed: bool = False

    @property
    def icon(self) -> IconName | None:
        """Icon to display on the tab. When set to None, no icon is displayed."""
        return self._icon

    @icon.setter
    def icon(self, icon: IconName | None) -> None:
        self._icon = icon
        # Find the index of this tab in the parent's tab list.
        tab_index = self._parent._tab_handles.index(self)
        # Update the icon HTML in the parent's tuple.
        icons_list = list(self._parent._tab_icons_html)
        icons_list[tab_index] = None if icon is None else svg_from_icon(icon)
        self._parent._tab_icons_html = tuple(icons_list)

    def __enter__(self) -> GuiTabHandle:
        self._container_id_restore = self._parent._impl.gui_api._get_container_uuid()
        self._parent._impl.gui_api._set_container_uuid(self._id)
        return self

    def __exit__(self, *args) -> None:
        del args
        assert self._container_id_restore is not None
        self._parent._impl.gui_api._set_container_uuid(self._container_id_restore)
        self._container_id_restore = None

    def __post_init__(self) -> None:
        self._parent._impl.gui_api._container_handle_from_uuid[self._id] = self

    def remove(self) -> None:
        """Permanently remove this tab and all contained GUI elements from the
        visualizer."""
        # Warn if already removed.
        if self._removed:
            warnings.warn(
                f"Attempted to remove an already removed {self.__class__.__name__}.",
                stacklevel=2,
            )
            return
        self._removed = True

        # We may want to make this thread-safe in the future.
        found_index = -1
        for i, tab in enumerate(self._parent._tab_handles):
            if tab is self:
                found_index = i
                break
        assert found_index != -1, "Tab already removed!"

        self._parent._tab_labels = (
            self._parent._tab_labels[:found_index]
            + self._parent._tab_labels[found_index + 1 :]
        )
        self._parent._tab_icons_html = (
            self._parent._tab_icons_html[:found_index]
            + self._parent._tab_icons_html[found_index + 1 :]
        )
        self._parent._tab_handles = (
            self._parent._tab_handles[:found_index]
            + self._parent._tab_handles[found_index + 1 :]
        )

        for child in tuple(self._children.values()):
            child.remove()
        self._parent._impl.gui_api._container_handle_from_uuid.pop(self._id)


class GuiFolderHandle(_GuiHandle[None], GuiFolderProps):
    """Use as a context to place GUI elements into a folder."""

    def __init__(self, _impl: _GuiHandleState[None]) -> None:
        super().__init__(impl=_impl)
        self._impl.gui_api._container_handle_from_uuid[self._impl.uuid] = self
        self._children = {}
        parent = self._impl.gui_api._container_handle_from_uuid[
            self._impl.parent_container_id
        ]
        parent._children[self._impl.uuid] = self

    def __enter__(self) -> GuiFolderHandle:
        self._container_id_restore = self._impl.gui_api._get_container_uuid()
        self._impl.gui_api._set_container_uuid(self._impl.uuid)
        return self

    def __exit__(self, *args) -> None:
        del args
        assert self._container_id_restore is not None
        self._impl.gui_api._set_container_uuid(self._container_id_restore)
        self._container_id_restore = None

    def remove(self) -> None:
        """Permanently remove this folder and all contained GUI elements from the
        visualizer."""
        # Warn if already removed.
        if self._impl.removed:
            warnings.warn(
                f"Attempted to remove an already removed {self.__class__.__name__}.",
                stacklevel=2,
            )
            return
        self._impl.removed = True

        # Remove children, then self.
        gui_api = self._impl.gui_api
        gui_api._websock_interface.get_message_buffer().remove_from_buffer(
            # Don't send outdated GUI updates to new clients.
            lambda message: (
                isinstance(message, GuiUpdateMessage)
                and message.uuid == self._impl.uuid
            )
        )
        gui_api._websock_interface.queue_message(GuiRemoveMessage(self._impl.uuid))
        for child in tuple(self._children.values()):
            child.remove()
        parent = gui_api._container_handle_from_uuid[self._impl.parent_container_id]
        parent._children.pop(self._impl.uuid)
        gui_api._container_handle_from_uuid.pop(self._impl.uuid)


@dataclasses.dataclass
class GuiModalHandle:
    """Use as a context to place GUI elements into a modal."""

    _gui_api: GuiApi
    _uuid: str  # Used as container ID of children.
    _container_uuid_restore: str | None = None
    _children: dict[str, SupportsRemoveProtocol] = dataclasses.field(
        default_factory=dict
    )

    def __enter__(self) -> GuiModalHandle:
        self._container_uuid_restore = self._gui_api._get_container_uuid()
        self._gui_api._set_container_uuid(self._uuid)
        return self

    def __exit__(self, *args) -> None:
        del args
        assert self._container_uuid_restore is not None
        self._gui_api._set_container_uuid(self._container_uuid_restore)
        self._container_uuid_restore = None

    def __post_init__(self) -> None:
        self._gui_api._container_handle_from_uuid[self._uuid] = self
        self._gui_api._modal_handle_from_uuid[self._uuid] = self

    def close(self) -> None:
        """Close this modal and permananently remove all contained GUI elements."""
        self._gui_api._websock_interface.queue_message(
            GuiCloseModalMessage(self._uuid),
        )
        for child in tuple(self._children.values()):
            child.remove()
        self._gui_api._container_handle_from_uuid.pop(self._uuid)
        self._gui_api._modal_handle_from_uuid.pop(self._uuid)


def _get_data_url(url: str, image_root: Path | None) -> str:
    if not url.startswith("http") and not image_root:
        warnings.warn(
            (
                "No `image_root` provided. All relative paths will be scoped to viser's"
                " installation path."
            ),
            stacklevel=2,
        )
    if url.startswith("http") or url.startswith("data:"):
        return url
    if image_root is None:
        image_root = Path(__file__).parent
    try:
        image = iio.imread(image_root / url)
        _, binary = _encode_image_binary(image, "png")
        url = base64.b64encode(binary).decode("utf-8")
        return f"data:image/png;base64,{url}"
    except (IOError, FileNotFoundError):
        warnings.warn(
            f"Failed to read image {url}, with image_root set to {image_root}.",
            stacklevel=2,
        )
        return url


def _parse_markdown(markdown: str, image_root: Path | None) -> str:
    markdown = re.sub(
        r"\!\[([^]]*)\]\(([^]]*)\)",
        lambda match: (
            f"![{match.group(1)}]({_get_data_url(match.group(2), image_root)})"
        ),
        markdown,
    )
    return markdown


class GuiProgressBarHandle(_GuiInputHandle[float], GuiProgressBarProps):
    """Handle for updating and removing progress bars."""


class GuiMarkdownHandle(_GuiHandle[None], GuiMarkdownProps):
    """Handling for updating and removing markdown elements."""

    def __init__(self, _impl: _GuiHandleState, _content: str, _image_root: Path | None):
        super().__init__(impl=_impl)
        self._content = _content
        self._image_root = _image_root

    @property
    def content(self) -> str:
        """Current content of this markdown element. Synchronized automatically when assigned."""
        assert self._content is not None
        return self._content

    @content.setter
    def content(self, content: str) -> None:
        self._content = content
        self._markdown = _parse_markdown(content, self._image_root)


class GuiHtmlHandle(_GuiHandle[None], GuiHtmlProps):
    """Handling for updating and removing HTML elements."""


class GuiPlotlyHandle(_GuiHandle[None], GuiPlotlyProps):
    """Handle for updating and removing Plotly figures."""

    def __init__(self, _impl: _GuiHandleState, _figure: go.Figure):
        super().__init__(impl=_impl)
        self._figure = _figure

    @property
    def figure(self) -> go.Figure:
        """Current content of this markdown element. Synchronized automatically when assigned."""
        assert self._figure is not None
        return self._figure

    @figure.setter
    def figure(self, figure: go.Figure) -> None:
        self._figure = figure

        json_str = figure.to_json()
        assert isinstance(json_str, str)
        self._plotly_json_str = json_str


class GuiUplotHandle(_GuiHandle[None], GuiUplotProps):
    """Handle for updating and removing Uplot figures."""

    pass


class GuiImageHandle(_GuiHandle[None], GuiImageProps):
    """Handle for updating and removing images."""

    def __init__(
        self,
        _impl: _GuiHandleState,
        _image: np.ndarray,
        _jpeg_quality: int | None,
    ):
        super().__init__(impl=_impl)
        self._image = _image
        self._jpeg_quality = _jpeg_quality
        self._user_format: Literal["auto", "jpeg", "png"] = "auto"  # Default if not set

    @property
    def image(self) -> np.ndarray:
        """Current content of this image element. Synchronized automatically when assigned."""
        assert self._image is not None
        return self._image

    @image.setter
    def image(self, image: np.ndarray) -> None:
        self._image = image
        resolved_format, data = _encode_image_binary(
            image, self._user_format, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._data = data

    @property
    def format(self) -> Literal["auto", "jpeg", "png"]:
        """Image format. 'auto' will use PNG for RGBA images and JPEG for RGB."""
        return self._user_format

    @format.setter
    def format(self, value: Literal["auto", "jpeg", "png"]) -> None:
        import warnings

        # Skip if format isn't changing.
        if self._user_format == value:
            return

        self._user_format = value

        # Re-encode image.
        if value == "jpeg" and self._image.shape[2] == 4:
            warnings.warn(
                "Converting RGBA image to JPEG will discard the alpha channel."
            )
        resolved_format, data = _encode_image_binary(
            self._image, value, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._data = data
