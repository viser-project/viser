from __future__ import annotations

import base64
import dataclasses
import json
import math
import re
import time
import uuid
import warnings
from collections.abc import Coroutine, Mapping
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
    cast,
    overload,
)

import numpy as np
from typing_extensions import Protocol, Self, TypeAlias, override

from ._assignable_props_api import AssignablePropsBase
from ._icons import svg_from_icon
from ._icons_enum import IconName
from ._messages import (
    CommandProps,
    CommandUpdateMessage,
    EdgePlacement,
    FloatPlacement,
    GuiBaseProps,
    GuiButtonGroupProps,
    GuiButtonProps,
    GuiCheckboxProps,
    GuiCloseModalMessage,
    GuiDividerProps,
    GuiDropdownProps,
    GuiFolderProps,
    GuiFormSubmitMessage,
    GuiHtmlProps,
    GuiImageProps,
    GuiMarkdownProps,
    GuiMultiSliderProps,
    GuiNumberProps,
    GuiPanelProps,
    GuiPanelRemoveMessage,
    GuiPlotlyProps,
    GuiProgressBarProps,
    GuiRemoveMessage,
    GuiRgbaProps,
    GuiRgbProps,
    GuiSetPanelCollapsedMessage,
    GuiSetPanelHeightMessage,
    GuiSetPanelPositionMessage,
    GuiSetPanelWidthMessage,
    GuiSliderProps,
    GuiTabGroupProps,
    GuiTextProps,
    GuiUpdateMessage,
    GuiUploadButtonProps,
    GuiUplotProps,
    GuiVector2Props,
    GuiVector3Props,
    Message,
    RemoveCommandMessage,
    SplitPlacement,
)
from ._scene_api import _encode_image_binary
from .infra import ClientId

if TYPE_CHECKING:
    import plotly.graph_objects as go

    from ._gui_api import GuiApi
    from ._viser import ClientHandle


T = TypeVar("T")
TGuiHandle = TypeVar("TGuiHandle", bound="_GuiHandle")
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

        gui_api = self._impl.gui_api
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

    def _coerce_assigned_value(self, value: T | np.ndarray) -> T | np.ndarray:
        """Hook for input-type-specific coercion of an assigned value. The base
        is identity; rgb/rgba handles override this to normalize colors."""
        return value

    @value.setter
    def value(self, value: T | np.ndarray) -> None:
        value = self._coerce_assigned_value(value)
        if isinstance(value, np.ndarray):
            assert len(value.shape) <= 1, f"{value.shape} should be at most 1D!"
            # Preserve each element's expected Python type -- float for vectors,
            # int for colors. A blanket `float(...)` would turn an int tuple into
            # floats, and the `tuple(...)` cast below does not restore types.
            elems = value.tolist()
            current = self._impl.value
            if isinstance(current, tuple) and len(current) == len(elems):
                value = tuple(type(c)(e) for c, e in zip(current, elems))  # type: ignore
            else:
                value = tuple(elems)  # type: ignore

        # Convert to internal type early so we can compare.
        value = type(self._impl.value)(value)  # type: ignore

        # Skip if value hasn't changed (but always process buttons).
        if not self._impl.is_button:
            try:
                if self._impl.value == value:
                    return
            except (TypeError, ValueError):
                pass

        # Send to client, except for buttons.
        if not self._impl.is_button:
            self._impl.gui_api._websock_interface.queue_message(
                GuiUpdateMessage(self._impl.uuid, {"value": value})
            )

        # Set internal state.
        self._impl.value = value  # type: ignore
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


def _colors_to_int_tuple(value: Any) -> tuple[int, ...]:
    """Coerce an RGB/RGBA color to an int tuple in [0, 255].

    Integer channels are taken as absolute [0, 255]; float channels are
    interpreted as [0, 1] and scaled (the matplotlib convention), so ``1.0`` ->
    255 (white) but ``1`` -> 1. The result is clamped to [0, 255] -- matching
    ``colors_to_uint8`` -- so out-of-range inputs (e.g. a float ``255.0`` or a
    negative value) degrade gracefully instead of producing a wild value.
    Generalized to any channel count (RGB and RGBA)."""
    if isinstance(value, np.ndarray):
        assert value.ndim == 1, f"Expected a 1D color, got shape {value.shape}."
    return tuple(
        max(0, min(255, int(v) if np.issubdtype(type(v), np.integer) else int(v * 255)))
        for v in value
    )


class GuiRgbHandle(GuiInputHandle[Tuple[int, int, int]], GuiRgbProps):
    """Handle for RGB color inputs.

    .. attribute:: value
       :type: tuple[int, int, int]

       Value of the input. Synchronized automatically when assigned.
    """

    @override
    def _coerce_assigned_value(
        self, value: Tuple[int, int, int] | np.ndarray
    ) -> Tuple[int, int, int]:
        # Float channels are [0, 1] (scaled to [0, 255]); int channels absolute.
        return cast(Tuple[int, int, int], _colors_to_int_tuple(value))


class GuiRgbaHandle(GuiInputHandle[Tuple[int, int, int, int]], GuiRgbaProps):
    """Handle for RGBA color inputs.

    .. attribute:: value
       :type: tuple[int, int, int, int]

       Value of the input. Synchronized automatically when assigned.
    """

    @override
    def _coerce_assigned_value(
        self, value: Tuple[int, int, int, int] | np.ndarray
    ) -> Tuple[int, int, int, int]:
        # Float channels are [0, 1] (scaled to [0, 255]); int channels absolute.
        return cast(Tuple[int, int, int, int], _colors_to_int_tuple(value))


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
        if len(options) == 0:
            raise ValueError("Dropdown requires at least one option.")
        self._impl.props.options = options

        self._impl.gui_api._websock_interface.queue_message(
            GuiUpdateMessage(
                self._impl.uuid,
                {"options": options},
            )
        )
        if self.value not in options:
            self.value = options[0]


class _TabContainerMixin:
    """Shared ``add_tab`` machinery for handles that own a tab list.

    A tab container holds the three parallel tab tuples (``_tab_labels`` /
    ``_tab_icons_html`` / ``_tab_container_ids``, provided by the handle's props
    class) plus ``_tab_handles``. Both :class:`GuiTabGroupHandle` (inline tab
    group) and :class:`PanelHandle` (standalone panel) mix this in; the only
    difference is their props class and lifecycle, not how tabs are added. The
    tabs are real GUI containers (each :class:`GuiTabHandle`), so a panel's tabs
    register as dock panes exactly like a tab group's."""

    # Provided by the props class / handle:
    _tab_labels: Tuple[str, ...]
    _tab_icons_html: Tuple[str | None, ...]
    _tab_container_ids: Tuple[str, ...]
    _tab_handles: list[GuiTabHandle]
    _impl: _GuiHandleState[None]

    def add_tab(self, label: str, icon: IconName | None = None) -> GuiTabHandle:
        """Add a tab. Returns a handle we can use to add GUI elements to it."""
        # Guard before mutating: otherwise we'd half-register a tab (appended to
        # _tab_handles + the container map via GuiTabHandle.__post_init__) before
        # the first props write below hits the removed-guard and raises, leaving
        # inconsistent state + a leaked container entry. Applies to both mixers
        # (tab group and standalone panel).
        if self._impl.removed:
            raise RuntimeError(f"Cannot add a tab to a removed {type(self).__name__}.")

        uuid = _make_uuid()

        # We may want to make this thread-safe in the future.
        out = GuiTabHandle(_parent=self, _id=uuid, _label=label, _icon=icon)

        self._tab_handles.append(out)
        self._rebuild_tab_props()
        return out

    def _rebuild_tab_props(self) -> None:
        """Recompute the three wire tuples from ``_tab_handles`` -- the single
        source of truth for a tab's id/label/icon. Every mutation (add, remove,
        icon change) rebuilds through here, so the parallel tuples can never
        desync in length or order."""
        self._tab_container_ids = tuple(h._id for h in self._tab_handles)
        self._tab_labels = tuple(h._label for h in self._tab_handles)
        self._tab_icons_html = tuple(
            None if h._icon is None else svg_from_icon(h._icon)
            for h in self._tab_handles
        )


class GuiTabGroupHandle(_TabContainerMixin, _GuiHandle[None], GuiTabGroupProps):
    """Handle for a tab group. Call :meth:`add_tab()` to add a tab."""

    def __init__(self, _impl: _GuiHandleState[None]) -> None:
        super().__init__(impl=_impl)
        self._tab_handles: list[GuiTabHandle] = []

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

        # Remove tabs first. Each tab.remove() writes back to this group's
        # tab-list props (_tab_labels / _tab_icons_html / _tab_container_ids), so
        # we must NOT mark the group removed until afterwards -- otherwise the
        # removed-handle guard in props_setattr raises on those writes, leaving
        # the group half-removed (still in its parent's _children with
        # removed=True). A subsequent gui.reset() then spins forever, since its
        # `while root._children: child.remove()` loop hits that group whose
        # remove() now no-ops via the already-removed guard.
        for tab in tuple(self._tab_handles):
            tab.remove()
        self._impl.removed = True
        gui_api = self._impl.gui_api
        gui_api._websock_interface.queue_message(GuiRemoveMessage(self._impl.uuid))
        parent = gui_api._container_handle_from_uuid[self._impl.parent_container_id]
        parent._children.pop(self._impl.uuid)


@dataclasses.dataclass
class GuiTabHandle:
    """Use as a context to place GUI elements into a tab."""

    _parent: _TabContainerMixin
    _id: str  # Used as container ID of children.
    _label: str
    _icon: IconName | None
    _container_id_restore: str | None = None
    _children: dict[str, SupportsRemoveProtocol] = dataclasses.field(
        default_factory=dict
    )
    removed: bool = False

    @property
    def icon(self) -> IconName | None:
        """Icon to display on the tab. When set to None, no icon is displayed."""
        return self._icon

    @icon.setter
    def icon(self, icon: IconName | None) -> None:
        # The handle owns its icon; rebuild rederives the wire tuples from the
        # handles, so there's no index arithmetic that could target the wrong tab.
        self._icon = icon
        self._parent._rebuild_tab_props()

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
        if self.removed:
            warnings.warn(
                f"Attempted to remove an already removed {self.__class__.__name__}.",
                stacklevel=2,
            )
            return
        self.removed = True

        # We may want to make this thread-safe in the future.
        assert self in self._parent._tab_handles, "Tab already removed!"
        # Drop this handle; the three wire tuples are rederived from the handle
        # list in one place, so they can't end up mismatched in length or order.
        self._parent._tab_handles = [
            tab for tab in self._parent._tab_handles if tab is not self
        ]
        self._parent._rebuild_tab_props()

        for child in tuple(self._children.values()):
            child.remove()
        self._parent._impl.gui_api._container_handle_from_uuid.pop(self._id)


# The control panel's fixed uuid, shared with the client (CONTROL_PANEL_ID in
# ControlPanelDock.tsx). Used as the anchor uuid when `main_panel` is a dock
# anchor, and as the placement target for the main panel itself.
CONTROL_PANEL_ID = "viser-control-panel"


def _check_dimension(value: float | None, name: str) -> None:
    """Reject non-positive / non-finite panel sizes before they reach the client.

    NaN/negative/zero widths produce broken (and, for NaN, sticky + replayed)
    layouts; the client's floating-window resize doesn't clamp them, so we
    validate at the Python boundary like other viser inputs do."""
    if value is not None and (not math.isfinite(value) or value <= 0.0):
        raise ValueError(f"{name} must be a positive, finite number, got {value!r}.")


def _check_coordinate(value: float | None, name: str) -> None:
    """Reject non-finite float coordinates. Unlike dimensions, coordinates may be
    negative (a gap from the far edge) or zero, but NaN/inf would produce a
    broken, sticky, replayed window position."""
    if value is not None and not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number, got {value!r}.")


class _PlacementMixin:
    """Shared placement / sizing commands for panel handles.

    Placement is WRITE-ONLY from the server: there is no placement state stored
    or read back here. Each command fires one per-axis message
    (``GuiSetPanel{Position,Width,Height,Collapsed}Message``); the client owns all
    placement state. The messages are ``update_simple`` updates that coalesce
    per-type, persist, and replay to late joiners -- so e.g. ``set_width`` never
    carries a position and cannot re-dock a panel the user has moved.

    Subclasses provide ``_placement_uuid`` (the tab-group uuid to target) and
    ``_placement_gui_api``.
    """

    _placement_uuid: str
    _placement_gui_api: GuiApi

    def _queue_placement(self, message: Message) -> None:
        # Single guard point for every command: reject placement on a removed
        # panel, which would otherwise queue an update against a dead uuid.
        # `MainPanelHandle` has no `_impl` and can't be removed, so it's never
        # blocked.
        impl = getattr(self, "_impl", None)
        if impl is not None and impl.removed:
            raise RuntimeError(f"Cannot place a removed {type(self).__name__}.")
        # Stamp the per-panel layout-update counter (bumped on EVERY placement
        # command) and this GuiApi's run id. The client uses the pair to ignore
        # replayed/late placement for a panel the user has since rearranged (see
        # the message's `counter` / `run_id` docs). Methods construct the message
        # with placeholder counter=0 / run_id=""; the authoritative values are
        # assigned here, the single chokepoint. The bump is guarded by a lock so
        # concurrent placement calls from two threads can't stamp duplicate
        # counters (which would weaken the client's monotonicity gate).
        api = self._placement_gui_api
        counts = api._layout_update_count_from_uuid
        with api._layout_update_lock:
            counts[self._placement_uuid] = counts.get(self._placement_uuid, 0) + 1
            counter = counts[self._placement_uuid]
        stamped = dataclasses.replace(
            cast(Any, message), counter=counter, run_id=api._layout_run_id
        )
        api._websock_interface.queue_message(stamped)

    def _set_position(
        self, position: EdgePlacement | SplitPlacement | FloatPlacement
    ) -> None:
        self._queue_placement(
            GuiSetPanelPositionMessage(
                self._placement_uuid, position, counter=0, run_id=""
            )
        )

    def _resolve_anchor_uuid(self, anchor: PlaceableHandle) -> str:
        """Validate an anchor and return its tab-group uuid.

        The anchor must share this panel's scope, except `main_panel`, which
        renders on every client and is a legal anchor from any scope."""
        if isinstance(anchor, MainPanelHandle):
            # main_panel: legal from any scope, no removed/scope checks. Still
            # reject docking it relative to itself (uuid check, not identity --
            # `main_panel` hands out a fresh throwaway handle per access).
            if self._placement_uuid == CONTROL_PANEL_ID:
                raise ValueError("A panel cannot be docked relative to itself.")
            return CONTROL_PANEL_ID
        if not isinstance(anchor, PanelHandle):
            # User-facing API: a clear error, not an AssertionError (which `-O`
            # would strip, letting a wrong-typed anchor slip through).
            raise ValueError(
                "Anchor must be a PanelHandle or main_panel, got "
                f"{type(anchor).__name__}."
            )
        if anchor._impl.uuid == self._placement_uuid:
            raise ValueError("A panel cannot be docked relative to itself.")
        if anchor._impl.removed:
            raise ValueError("Cannot dock relative to a removed panel.")
        if anchor._impl.gui_api is not self._placement_gui_api:
            raise ValueError(
                "Anchor panel belongs to a different scope (server vs. client, "
                "or a different client). Use `main_panel` to anchor across scopes."
            )
        return anchor._impl.uuid

    def dock_left(self) -> None:
        """Dock this panel to the left viewport edge.

        Each new left-dock is inserted at the innermost position, so several
        panels docked to the left appear in call order from the edge inward.
        Calling again repositions an already-placed panel."""
        self._set_position({"kind": "edge", "edge": "left"})

    def dock_right(self) -> None:
        """Dock this panel to the right viewport edge.

        Each new right-dock is inserted at the innermost position, so several
        panels docked to the right appear in call order from the edge inward.
        Calling again repositions an already-placed panel."""
        self._set_position({"kind": "edge", "edge": "right"})

    def dock_above(self, anchor: PlaceableHandle) -> None:
        """Stack this panel directly above another panel (a column split).

        The ``anchor`` must itself be DOCKED (a column split needs a docked
        neighbor to split against). If the anchor is floating or not yet placed,
        this falls back to docking on the right edge (with a warning); dock the
        anchor first."""
        self._set_position(
            {
                "kind": "split",
                "anchor_uuid": self._resolve_anchor_uuid(anchor),
                "side": "above",
            }
        )

    def dock_below(self, anchor: PlaceableHandle) -> None:
        """Stack this panel directly below another panel (a column split).

        The ``anchor`` must itself be DOCKED (a column split needs a docked
        neighbor to split against). If the anchor is floating or not yet placed,
        this falls back to docking on the right edge (with a warning); dock the
        anchor first."""
        self._set_position(
            {
                "kind": "split",
                "anchor_uuid": self._resolve_anchor_uuid(anchor),
                "side": "below",
            }
        )

    def float(
        self,
        *,
        x: float | None = None,
        y: float | None = None,
        width: float | None = None,
        height: float | None = None,
    ) -> None:
        """Float this panel at an explicit position and size, in CSS pixels.

        ``x`` / ``y`` are measured relative to the **viewport** -- the canvas area
        inside any docked panels:

        * A non-negative value is a gap from the **left** / **top**:
          ``float(x=40)`` lands 40px from the canvas left edge (clear of a
          left-docked panel, not under it).
        * A **negative** value is a gap from the **right** / **bottom**:
          ``float(x=-15)`` puts the panel's right edge 15px from the canvas right
          edge. So ``float(x=-15, y=15)`` is the top-right corner, and
          ``float(x=-15, y=-15)`` the bottom-right.

        The panel re-resolves against these edges as the canvas changes (a dock
        added/removed, the window resized), so an edge-anchored panel stays put.
        Any argument left as ``None`` uses a client-chosen default (top-left);
        ``width`` / ``height`` set the floating window size."""
        _check_coordinate(x, "x")
        _check_coordinate(y, "y")
        _check_dimension(width, "width")
        _check_dimension(height, "height")
        self._set_position({"kind": "float", "x": x, "y": y})
        if width is not None:
            self.set_width(width)
        if height is not None:
            self.set_height(height)

    def set_width(self, width: float) -> None:
        """Set the panel width in pixels (region width when docked, window width
        when floating)."""
        if width is None:  # type: ignore[unreachable]
            # _check_dimension permits None (the message-level "clear override"
            # used internally by gui.reset()), but the public command requires a
            # real width -- None would silently no-op for standalone panels.
            raise TypeError("set_width requires a width in pixels.")
        _check_dimension(width, "width")
        self._queue_placement(
            GuiSetPanelWidthMessage(self._placement_uuid, width, counter=0, run_id="")
        )

    def set_height(self, height: float) -> None:
        """Set the panel height in pixels.

        Applies only to **floating** panels (sets the window height). A docked
        panel -- whether solo or stacked via :meth:`dock_above` /
        :meth:`dock_below` -- sizes to its split weights, so ``set_height`` has no
        effect there."""
        _check_dimension(height, "height")
        self._queue_placement(
            GuiSetPanelHeightMessage(
                self._placement_uuid, height, counter=0, run_id=""
            )
        )

    def minimize(self) -> None:
        """Minimize the panel (collapse it to a handle / strip).

        Imperative, like the ``dock_*`` / :meth:`float` commands: it always
        minimizes -- the first call sets the initial collapsed state, and a later
        call re-minimizes a panel even if the user expanded it in the browser.
        Replayed to clients that connect later.

        TODO: add a matching imperative collapse/expand method for folders
        (:meth:`GuiApi.add_folder`), which today only has the
        ``expand_by_default`` creation kwarg.
        """
        self._queue_placement(
            GuiSetPanelCollapsedMessage(
                self._placement_uuid, True, counter=0, run_id=""
            )
        )

    def expand(self) -> None:
        """Expand (un-minimize) the panel, the inverse of :meth:`minimize`.

        Imperative like :meth:`minimize`: it always expands, even if the user
        minimized the panel in the browser. Replayed to clients that connect
        later."""
        self._queue_placement(
            GuiSetPanelCollapsedMessage(
                self._placement_uuid, False, counter=0, run_id=""
            )
        )


class PanelHandle(
    _PlacementMixin,
    _TabContainerMixin,
    AssignablePropsBase[_GuiHandleState],
    GuiPanelProps,
):
    """Handle for a standalone panel: a dockable / floating GUI container that
    lives outside the main control panel.

    Create with :meth:`GuiApi.add_panel`. Add content with :meth:`add_tab`, and
    place it with the imperative ``dock_*`` / :meth:`float` commands. A panel is a
    dedicated top-level entity (like a modal) -- it is NOT part of the inline GUI
    tree -- that carries its own tabs; a single-tab panel renders as a plain
    header.

    Placement and sizing are **imperative commands, not synced state**: they
    apply to connected clients and replay to clients that connect later, but the
    current layout is never read back from clients. There are no readable
    ``.width`` / position properties, and a user dragging the panel afterward wins
    until the next explicit command. (This is why sizing is ``set_width()`` rather
    than a ``.width`` property.) Collapse is imperative too: :meth:`minimize` /
    :meth:`expand`.

    The server owns a panel's existence: users can rearrange, drag, minimize, and
    resize a panel, but cannot close it from the UI. A panel disappears only when
    :meth:`remove` is called."""

    def __init__(self, _impl: _GuiHandleState[None]) -> None:
        super().__init__(impl=_impl)
        self._tab_handles: list[GuiTabHandle] = []
        self._placement_uuid = _impl.uuid
        self._placement_gui_api = _impl.gui_api
        assert isinstance(_impl.props, GuiPanelProps)
        # A panel is a top-level entity tracked in its own registry (parallel to
        # modals), NOT under any parent container's `_children`. Its TABS register
        # themselves in `_container_handle_from_uuid` (keyed by tab id), so the
        # panel itself doesn't need a container entry.
        _impl.gui_api._panel_handle_from_uuid[_impl.uuid] = self

    @override
    def _queue_update(self, name: str, value: Any) -> None:
        self._impl.gui_api._websock_interface.queue_message(
            GuiUpdateMessage(self._impl.uuid, {name: value})
        )

    def add_tab(self, label: str, icon: IconName | None = None) -> GuiTabHandle:
        """Add a tab to the panel, returning a handle to populate it as a context.

        A single-tab panel renders as a plain header; multiple tabs render as a
        tab strip. Raises if the panel has been removed (the shared
        :class:`_TabContainerMixin` guard)."""
        return super().add_tab(label, icon)

    def __enter__(self) -> "PanelHandle":
        # A panel is a container for TABS, not a GUI context itself: you populate
        # its tabs (`with panel.add_tab(...):`), not the panel. Catch the natural
        # `with server.gui.add_panel():` mistake with a clear message instead of a
        # bare `AttributeError: __exit__`. Both `__enter__` AND `__exit__` must be
        # defined: CPython's `with` looks up `__exit__` on the type *before*
        # calling `__enter__`, so omitting it surfaces `AttributeError: __exit__`
        # and this helpful message never runs.
        raise TypeError(
            "A panel is not a context manager. Add content via its tabs, e.g.\n"
            "    panel = server.gui.add_panel()\n"
            '    with panel.add_tab("Tab"):\n'
            "        server.gui.add_markdown(...)"
        )

    def __exit__(self, *args) -> None:
        # Never reached (`__enter__` always raises), but must exist so the `with`
        # statement's pre-flight `__exit__` lookup finds it and lets `__enter__`
        # raise the helpful TypeError above.
        del args

    def remove(self) -> None:
        """Permanently remove this panel and all its tabs / contained elements.

        This is the only way a panel disappears -- there is no UI close button
        (see :class:`PanelHandle`)."""
        if self._impl.removed:
            warnings.warn(
                "Attempted to remove an already removed PanelHandle.",
                stacklevel=2,
            )
            return
        # Remove tabs first: each tab.remove() writes back to this panel's tab
        # tuples, which the removed-guard in props_setattr would reject once the
        # panel is marked removed (mirrors GuiTabGroupHandle.remove).
        for tab in tuple(self._tab_handles):
            tab.remove()
        self._impl.removed = True
        gui_api = self._impl.gui_api
        gui_api._websock_interface.queue_message(GuiPanelRemoveMessage(self._impl.uuid))
        gui_api._panel_handle_from_uuid.pop(self._impl.uuid)
        # Drain the panel's layout-update counter too, so a create/remove cycle
        # doesn't leave a stale entry (matches the file's leak-hygiene elsewhere).
        gui_api._layout_update_count_from_uuid.pop(self._impl.uuid, None)


class MainPanelHandle(_PlacementMixin):
    """Handle for the main control panel. Returned by :attr:`GuiApi.main_panel`.

    Supports the same placement / sizing commands as :class:`PanelHandle`, but
    has no tabs and cannot be removed. Because the control panel renders on every
    client, it is a legal anchor for other panels' ``dock_*`` commands from any
    scope.

    A fresh handle is returned on each access; placement state is keyed off the
    control panel's fixed uuid, so handles are interchangeable."""

    def __init__(self, gui_api: GuiApi) -> None:
        # Placement is write-only (per-axis messages keyed by CONTROL_PANEL_ID);
        # no state to hold, so the throwaway handles `main_panel` returns are all
        # equivalent.
        self._placement_uuid = CONTROL_PANEL_ID
        self._placement_gui_api = gui_api


PlaceableHandle: TypeAlias = "PanelHandle | MainPanelHandle"
"""A handle that can be used as a dock anchor: a standalone panel or the main
panel."""


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

    def __enter__(self) -> Self:
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
        gui_api._websock_interface.queue_message(GuiRemoveMessage(self._impl.uuid))
        for child in tuple(self._children.values()):
            child.remove()
        parent = gui_api._container_handle_from_uuid[self._impl.parent_container_id]
        parent._children.pop(self._impl.uuid)
        gui_api._container_handle_from_uuid.pop(self._impl.uuid)


class GuiFormHandle(GuiFolderHandle):
    """Use as a context to place GUI elements into a form.

    A form is a folder whose children's values can be committed together by
    calling :meth:`submit` (typically from a button's ``on_click`` handler) or
    by pressing Enter in a single-line text input inside the form.

    Children of a form behave exactly like children of a folder. ``on_update``
    callbacks on individual inputs continue to fire on every keystroke; the
    form's :meth:`on_submit` callback fires only when the form is submitted.
    Register one or both depending on whether you want live or commit
    semantics.

    The form's client-side dirty indicator highlights when any descendant
    input has been edited since the last submit.

    Forms cannot be nested. Calling :meth:`GuiApi.add_form` inside an
    existing form's context will raise :class:`ValueError`, because nested
    ``<form>`` elements are invalid HTML on the client.

    Example::

        with server.gui.add_form("Profile") as form:
            name = server.gui.add_text("Name", "")
            age = server.gui.add_number("Age", 0)
            save = server.gui.add_button("Save")

        save.on_click(lambda _: form.submit())

        @form.on_submit
        def _(event):
            print(name.value, age.value)
    """

    def __init__(self, _impl: _GuiHandleState[None]) -> None:
        super().__init__(_impl)
        self._submit_cb: list[
            Callable[[GuiEvent[GuiFormHandle]], None | Coroutine]
        ] = []

    def on_submit(
        self,
        func: Callable[[GuiEvent[GuiFormHandle]], NoneOrCoroutine],
    ) -> Callable[[GuiEvent[GuiFormHandle]], NoneOrCoroutine]:
        """Attach a function to call when the form is submitted.

        ``on_submit`` is independent from ``on_update`` callbacks on child
        inputs: child ``on_update`` callbacks fire on every keystroke (as
        normal), and the form's ``on_submit`` fires when commit happens (via
        ``form.submit()`` or Enter in a single-line text input).

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.
        """
        self._submit_cb.append(func)
        return func

    def remove_submit_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove submit callbacks from the form.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._submit_cb.clear()
        else:
            self._submit_cb = [cb for cb in self._submit_cb if cb != callback]

    def submit(self) -> None:
        """Programmatically submit this form.

        Fires all registered ``on_submit`` callbacks and broadcasts a
        :class:`GuiFormSubmitMessage` to all clients so their dirty indicators
        are cleared.
        """
        gui_api = self._impl.gui_api
        # Fire on_submit callbacks. Server-initiated submits have no client.
        for cb in self._submit_cb:
            cb_out = cb(GuiEvent(client_id=None, client=None, target=self))
            if isinstance(cb_out, Coroutine):
                gui_api._event_loop.create_task(cb_out)
        # Broadcast to clients so they reset dirty state.
        gui_api._websock_interface.queue_message(
            GuiFormSubmitMessage(uuid=self._impl.uuid)
        )


@dataclasses.dataclass
class GuiModalHandle:
    """Use as a context to place GUI elements into a modal."""

    _gui_api: GuiApi
    _uuid: str  # Used as container ID of children.
    _container_uuid_restore: str | None = None
    _children: dict[str, SupportsRemoveProtocol] = dataclasses.field(
        default_factory=dict
    )
    closed: bool = False

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
        if self.closed:
            warnings.warn(
                "Attempted to close an already closed GuiModalHandle.",
                stacklevel=2,
            )
            return
        self.closed = True
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
        import imageio.v3 as iio

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


class GuiDividerHandle(_GuiHandle[None], GuiDividerProps):
    """Handle for updating and removing dividers."""


class GuiPlotlyHandle(_GuiHandle[None], GuiPlotlyProps):
    """Handle for updating and removing Plotly figures."""

    def __init__(
        self,
        _impl: _GuiHandleState,
        _figure: go.Figure,
        _config: Mapping[str, Any] | None = None,
    ):
        super().__init__(impl=_impl)
        self._figure = _figure
        self._config = _config

    @property
    def figure(self) -> go.Figure:
        """Current Plotly figure. Synchronized automatically when assigned."""
        assert self._figure is not None
        return self._figure

    @figure.setter
    def figure(self, figure: go.Figure) -> None:
        self._figure = figure
        json_str = figure.to_json()
        assert isinstance(json_str, str)
        if self._config is not None:
            plot_dict = json.loads(json_str)
            plot_dict["config"] = {**plot_dict.get("config", {}), **self._config}
            json_str = json.dumps(plot_dict)
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
        self._user_format: Literal["auto", "jpeg", "png"] = (
            "auto"  # Default if not set.
        )

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


@dataclasses.dataclass(frozen=True)
class CommandEvent:
    """Information associated with a command trigger from the command palette.

    Passed as input to callback functions.

    ``client`` and ``client_id`` are typed Optional for parity with
    :class:`GuiEvent` (which can fire server-side) and to leave room for a
    future programmatic ``handle.trigger()`` path. In practice, every command
    trigger today originates from a real client -- the dispatcher drops the
    event if the client can't be resolved, so callbacks only see non-None
    values."""

    client: ClientHandle | None
    """Client that triggered this command."""
    client_id: int | None
    """ID of client that triggered this command."""
    target: CommandHandle
    """Command handle that was triggered."""


@dataclasses.dataclass
class _CommandHandleState:
    """Internal state for a registered command."""

    uuid: str
    gui_api: GuiApi
    props: CommandProps
    icon: IconName | None
    trigger_cb: list[Callable[[CommandEvent], None | Coroutine]] = dataclasses.field(
        default_factory=list
    )
    removed: bool = False


class CommandHandle(AssignablePropsBase[_CommandHandleState], CommandProps):
    """Handle for a command registered in the command palette.

    Commands are shown in a command palette (Ctrl/Cmd+K, also Ctrl/Cmd+Shift+P
    on non-Firefox browsers) and can optionally be triggered via hotkeys.

    (Experimental) The command palette API may change in future releases."""

    def __init__(self, _impl: _CommandHandleState) -> None:
        super().__init__(impl=_impl)

    @property
    def icon(self) -> IconName | None:
        """Icon displayed in the command palette."""
        return self._impl.icon

    @icon.setter
    def icon(self, icon: IconName | None) -> None:
        # Removed-guard enforced upstream by AssignablePropsBase.__setattr__.
        self._impl.icon = icon
        self._impl.props._icon_html = None if icon is None else svg_from_icon(icon)
        self._queue_update("_icon_html", self._impl.props._icon_html)

    def _queue_update(self, name: str, value: Any) -> None:
        self._impl.gui_api._websock_interface.queue_message(
            CommandUpdateMessage(uuid=self._impl.uuid, updates={name: value})
        )

    def on_trigger(
        self, func: Callable[[CommandEvent], NoneOrCoroutine]
    ) -> Callable[[CommandEvent], NoneOrCoroutine]:
        """Attach a function to call when this command is triggered.

        Note:
        - If `func` is a regular function (defined with `def`), it will be executed in a thread pool.
        - If `func` is an async function (defined with `async def`), it will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        if self._impl.removed:
            raise RuntimeError(
                "Cannot attach a trigger callback to a removed CommandHandle."
            )
        self._impl.trigger_cb.append(func)
        return func

    def remove(self) -> None:
        """Remove this command from the command palette."""
        if self._impl.removed:
            warnings.warn(
                "Attempted to remove an already removed CommandHandle.",
                stacklevel=2,
            )
            return
        self._impl.removed = True
        gui_api = self._impl.gui_api
        gui_api._websock_interface.queue_message(RemoveCommandMessage(self._impl.uuid))
        gui_api._command_handle_from_uuid.pop(self._impl.uuid, None)
