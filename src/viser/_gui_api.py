from __future__ import annotations

import asyncio
import builtins
import colorsys
import dataclasses
import functools
import threading
import time
from asyncio import AbstractEventLoop
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Protocol,
    Sequence,
    Tuple,
    TypeVar,
    cast,
    overload,
)

import numpy as np
from typing_extensions import (
    Literal,
    LiteralString,
    TypeAlias,
    TypedDict,
    get_type_hints,
)

from viser import theme
from viser._backwards_compat_shims import deprecated_positional_shim

from . import _messages, uplot
from ._gui_handles import (
    GuiButtonGroupHandle,
    GuiButtonHandle,
    GuiCheckboxHandle,
    GuiContainerProtocol,
    GuiDropdownHandle,
    GuiEvent,
    GuiFolderHandle,
    GuiHtmlHandle,
    GuiImageHandle,
    GuiMarkdownHandle,
    GuiModalHandle,
    GuiMultiSliderHandle,
    GuiNumberHandle,
    GuiPlotlyHandle,
    GuiProgressBarHandle,
    GuiRgbaHandle,
    GuiRgbHandle,
    GuiSliderHandle,
    GuiTabGroupHandle,
    GuiTextHandle,
    GuiUploadButtonHandle,
    GuiUplotHandle,
    GuiVector2Handle,
    GuiVector3Handle,
    SupportsRemoveProtocol,
    UploadedFile,
    _GuiButtonHandleState,
    _GuiHandleState,
    _GuiInputHandle,
    _make_uuid,
)
from ._icons import svg_from_icon
from ._icons_enum import IconName
from ._messages import FileTransferPartAck, GuiBaseProps, GuiSliderMark
from ._scene_api import cast_vector
from ._threadpool_exceptions import print_threadpool_errors

if TYPE_CHECKING:
    import plotly.graph_objects as go

    from ._viser import ClientHandle, ViserServer
    from .infra import ClientId

GuiInputPropsType = TypeVar("GuiInputPropsType", bound=GuiBaseProps)
IntOrFloat = TypeVar("IntOrFloat", int, float)
TString = TypeVar("TString", bound=str)
TLiteralString = TypeVar("TLiteralString", bound=LiteralString)
T = TypeVar("T")
LengthTenStrTuple: TypeAlias = Tuple[str, str, str, str, str, str, str, str, str, str]
LiteralColor: TypeAlias = Literal[
    "dark",
    "gray",
    "red",
    "pink",
    "grape",
    "violet",
    "indigo",
    "blue",
    "cyan",
    "green",
    "lime",
    "yellow",
    "orange",
    "teal",
]


def _hex_from_hls(h: float, l: float, s: float) -> str:
    """Converts HLS values in [0.0, 1.0] to a hex-formatted string, eg 0xffffff."""
    return "#" + "".join(
        [
            int(min(255, max(0, channel * 255.0)) + 0.5).to_bytes(1, "little").hex()
            for channel in colorsys.hls_to_rgb(h, l, s)
        ]
    )


def _compute_step(x: float | None) -> float:  # type: ignore
    """For number inputs: compute an increment size from some number.

    Example inputs/outputs:
        100 => 1
        12 => 1
        12.1 => 0.1
        12.02 => 0.01
        0.004 => 0.001
    """
    return 1 if x is None else 10 ** (-_compute_precision_digits(x))


def _compute_precision_digits(x: float) -> int:
    """For number inputs: compute digits of precision from some number.

    Example inputs/outputs:
        100 => 0
        12 => 0
        12.1 => 1
        10.2 => 1
        0.007 => 3
    """
    digits = 0
    while x != round(x, ndigits=digits) and digits < 7:
        digits += 1
    return digits


@dataclasses.dataclass
class _RootGuiContainer:
    _children: dict[str, SupportsRemoveProtocol]


_global_order_counter = 0


def _apply_default_order(order: float | None) -> float:
    """Apply default ordering logic for GUI elements.

    If `order` is set to a float, this function is a no-op and returns it back.
    Otherwise, we increment and return the value of a global counter.
    """
    if order is not None:
        return order

    global _global_order_counter
    _global_order_counter += 1
    return _global_order_counter


@functools.lru_cache(maxsize=None)
def get_type_hints_cached(cls: type[Any]) -> dict[str, Any]:
    return get_type_hints(cls)  # type: ignore


class _FileUploadState(TypedDict):
    filename: str
    mime_type: str
    part_count: int
    parts: dict[int, bytes]
    total_bytes: int
    transferred_bytes: int
    lock: threading.Lock


class GuiApi:
    """Interface for working with the 2D GUI in viser.

    Used by both our global server object, for sharing the same GUI elements
    with all clients, and by individual client handles."""

    _target_container_from_thread_id: dict[int, str] = {}
    """ID of container to put GUI elements into."""

    def __init__(
        self,
        owner: ViserServer | ClientHandle,  # Who do I belong to?
        thread_executor: ThreadPoolExecutor,
        event_loop: AbstractEventLoop,
    ) -> None:
        from ._viser import ViserServer

        self._owner = owner
        """Entity that owns this API."""
        self._thread_executor = thread_executor
        self._event_loop = event_loop

        self._websock_interface = (
            owner._websock_server
            if isinstance(owner, ViserServer)
            else owner._websock_connection
        )
        """Interface for sending and listening to messages."""

        self._gui_input_handle_from_uuid: dict[str, _GuiInputHandle[Any]] = {}
        self._container_handle_from_uuid: dict[str, GuiContainerProtocol] = {
            "root": _RootGuiContainer({})
        }
        self._modal_handle_from_uuid: dict[str, GuiModalHandle] = {}
        self._current_file_upload_states: dict[str, _FileUploadState] = {}

        # Set to True when plotly.min.js has been sent to client.
        self._setup_plotly_js: bool = False

        self._websock_interface.register_handler(
            _messages.GuiUpdateMessage, self._handle_gui_updates
        )
        self._websock_interface.register_handler(
            _messages.GuiButtonHoldMessage, self._handle_gui_button_hold
        )
        self._websock_interface.register_handler(
            _messages.FileTransferStartUpload, self._handle_file_transfer_start
        )
        self._websock_interface.register_handler(
            _messages.FileTransferPart,
            self._handle_file_transfer_part,
        )

    async def _handle_gui_updates(
        self, client_id: ClientId, message: _messages.GuiUpdateMessage
    ) -> None:
        """Callback for handling GUI messages."""
        handle = self._gui_input_handle_from_uuid.get(message.uuid, None)
        if handle is None:
            return
        handle_state = handle._impl

        has_changed = False
        updates_cast = {}
        for prop_name, prop_value in message.updates.items():
            assert hasattr(handle_state, prop_name)
            current_value = getattr(handle_state, prop_name)

            # Do some type casting. This is brittle, but necessary (1) when we
            # expect floats but the Javascript side gives us integers or (2)
            # when we expect tuples but the Javascript side gives us lists.
            if prop_name == "value":
                if isinstance(handle_state.value, tuple):
                    if len(handle_state.value) > 0:
                        # We currently assume non-empty tuple types have length
                        # greater than 0, and contents are all the same type.
                        typ = type(handle_state.value[0])
                        assert all([type(x) == typ for x in handle_state.value])
                        prop_value = tuple([typ(new) for new in prop_value])
                    else:
                        # Empty tuple.
                        prop_value = tuple(prop_value)
                else:
                    prop_value = type(handle_state.value)(prop_value)

            # Update handle property.
            if current_value != prop_value:
                has_changed = True
                setattr(handle_state, prop_name, prop_value)

            # Save value, which might have been cast.
            updates_cast[prop_name] = prop_value

        # Only call update when value has actually changed.
        if not handle_state.is_button and not has_changed:
            return

        # GUI element has been updated!
        handle_state.update_timestamp = time.time()
        for cb in handle_state.update_cb:
            from ._viser import ClientHandle, ViserServer

            # Get the handle of the client that triggered this event.
            if isinstance(self._owner, ClientHandle):
                client = self._owner
            elif isinstance(self._owner, ViserServer):
                client = self._owner._connected_clients.get(client_id, None)
                if client is None:
                    return
            else:
                assert False

            if asyncio.iscoroutinefunction(cb):
                await cb(GuiEvent(client, client_id, handle))
            else:
                self._thread_executor.submit(
                    cb, GuiEvent(client, client_id, handle)
                ).add_done_callback(print_threadpool_errors)

        if handle_state.sync_cb is not None:
            handle_state.sync_cb(client_id, updates_cast)

    async def _handle_gui_button_hold(
        self, client_id: ClientId, message: _messages.GuiButtonHoldMessage
    ) -> None:
        """Callback for handling button hold messages."""
        handle = self._gui_input_handle_from_uuid.get(message.uuid, None)
        if handle is None:
            return

        # Ensure this is a button handle with hold callbacks.
        if not isinstance(handle, GuiButtonHandle):
            return

        # Get callbacks registered for this frequency.
        callbacks = handle._button_impl.hold_cbs_from_freq.get(message.frequency, [])
        if not callbacks:
            return

        # Get the client handle.
        from ._viser import ClientHandle, ViserServer

        if isinstance(self._owner, ClientHandle):
            client = self._owner
        elif isinstance(self._owner, ViserServer):
            client = self._owner._connected_clients.get(client_id, None)
            if client is None:
                return
        else:
            assert False

        # Call all callbacks for this frequency.
        for cb in callbacks:
            if asyncio.iscoroutinefunction(cb):
                await cb(GuiEvent(client, client_id, handle))
            else:
                self._thread_executor.submit(
                    cb, GuiEvent(client, client_id, handle)
                ).add_done_callback(print_threadpool_errors)

    def _handle_file_transfer_start(
        self, client_id: ClientId, message: _messages.FileTransferStartUpload
    ) -> None:
        if message.source_component_uuid not in self._gui_input_handle_from_uuid:
            return
        self._current_file_upload_states[message.transfer_uuid] = {
            "filename": message.filename,
            "mime_type": message.mime_type,
            "part_count": message.part_count,
            "parts": {},
            "total_bytes": message.size_bytes,
            "transferred_bytes": 0,
            "lock": threading.Lock(),
        }

    def _handle_file_transfer_part(
        self, client_id: ClientId, message: _messages.FileTransferPart
    ) -> None:
        if message.transfer_uuid not in self._current_file_upload_states:
            return
        assert message.source_component_uuid in self._gui_input_handle_from_uuid

        state = self._current_file_upload_states[message.transfer_uuid]
        state["parts"][message.part_index] = message.content
        total_bytes = state["total_bytes"]

        with state["lock"]:
            state["transferred_bytes"] += len(message.content)

            # Send ack to the server.
            self._websock_interface.queue_message(
                FileTransferPartAck(
                    source_component_uuid=message.source_component_uuid,
                    transfer_uuid=message.transfer_uuid,
                    transferred_bytes=state["transferred_bytes"],
                    total_bytes=total_bytes,
                )
            )

            if state["transferred_bytes"] < total_bytes:
                return

        # Finish the upload.
        assert state["transferred_bytes"] == total_bytes
        state = self._current_file_upload_states.pop(message.transfer_uuid)

        handle = self._gui_input_handle_from_uuid.get(
            message.source_component_uuid, None
        )
        if handle is None:
            return

        handle_state = handle._impl

        value = UploadedFile(
            name=state["filename"],
            content=b"".join(state["parts"][i] for i in range(state["part_count"])),
        )

        # Update state.
        handle_state.value = value
        handle_state.update_timestamp = time.time()

        # Trigger callbacks.
        for cb in handle_state.update_cb:
            from ._viser import ClientHandle, ViserServer

            # Get the handle of the client that triggered this event.
            if isinstance(self._owner, ClientHandle):
                client = self._owner
            elif isinstance(self._owner, ViserServer):
                client = self._owner._connected_clients.get(client_id, None)
                if client is None:
                    return
            else:
                assert False

            if asyncio.iscoroutinefunction(cb):
                self._event_loop.create_task(cb(GuiEvent(client, client_id, handle)))
            else:
                self._thread_executor.submit(
                    cb, GuiEvent(client, client_id, handle)
                ).add_done_callback(print_threadpool_errors)

    def _get_container_uuid(self) -> str:
        """Get container ID associated with the current thread."""
        return self._target_container_from_thread_id.get(threading.get_ident(), "root")

    def _set_container_uuid(self, container_uuid: str) -> None:
        """Set container ID associated with the current thread."""
        self._target_container_from_thread_id[threading.get_ident()] = container_uuid

    def reset(self) -> None:
        """Reset the GUI."""
        root_container = self._container_handle_from_uuid["root"]
        while len(root_container._children) > 0:
            next(iter(root_container._children.values())).remove()
        while len(self._modal_handle_from_uuid) > 0:
            next(iter(self._modal_handle_from_uuid.values())).close()

    def set_panel_label(self, label: str | None) -> None:
        """Set the main label that appears in the GUI panel.

        Args:
            label: The new label.
        """
        self._websock_interface.queue_message(_messages.SetGuiPanelLabelMessage(label))

    def configure_theme(
        self,
        *,
        titlebar_content: theme.TitlebarConfig | None = None,
        control_layout: Literal["floating", "collapsible", "fixed"] = "floating",
        control_width: Literal["small", "medium", "large"] = "medium",
        dark_mode: bool = False,
        show_logo: bool = True,
        show_share_button: bool = True,
        brand_color: tuple[int, int, int] | None = None,
    ) -> None:
        """Configures the visual appearance of the viser front-end.

        Args:
            titlebar_content: Optional configuration for the title bar.
            control_layout: The layout of control elements, options are "floating",
                            "collapsible", or "fixed".
            control_width: The width of control elements, options are "small",
                           "medium", or "large".
            dark_mode: A boolean indicating if dark mode should be enabled.
            show_logo: A boolean indicating if the logo should be displayed.
            show_share_button: A boolean indicating if the share button should be displayed.
            brand_color: An optional tuple of integers (RGB) representing the brand color.
        """

        colors_cast: LengthTenStrTuple | None = None

        if brand_color is not None:
            assert len(brand_color) in (3, 10)
            if len(brand_color) == 3:
                assert all(map(lambda val: isinstance(val, int), brand_color)), (
                    "All channels should be integers."
                )

                # RGB => HLS.
                h, l, s = colorsys.rgb_to_hls(
                    brand_color[0] / 255.0,
                    brand_color[1] / 255.0,
                    brand_color[2] / 255.0,
                )

                # Automatically generate a 10-color palette.
                min_l = max(l - 0.08, 0.0)
                max_l = min(0.8 + 0.5, 0.9)
                l = max(min_l, min(max_l, l))

                primary_index = 8
                ls = tuple(
                    np.interp(
                        x=np.arange(10),
                        xp=np.array([0, primary_index, 9]),
                        fp=np.array([max_l, l, min_l]),
                    )
                )
                colors_cast = cast(
                    LengthTenStrTuple,
                    tuple(_hex_from_hls(h, float(ls[i]), s) for i in range(10)),
                )

        assert colors_cast is None or all(
            [isinstance(val, str) and val.startswith("#") for val in colors_cast]
        ), "All string colors should be in hexadecimal + prefixed with #, eg #ffffff."

        self._websock_interface.queue_message(
            _messages.ThemeConfigurationMessage(
                titlebar_content=titlebar_content,
                control_layout=control_layout,
                control_width=control_width,
                dark_mode=dark_mode,
                show_logo=show_logo,
                show_share_button=show_share_button,
                colors=colors_cast,
            ),
        )

    @deprecated_positional_shim
    def add_folder(
        self,
        label: str,
        *,
        order: float | None = None,
        expand_by_default: bool = True,
        visible: bool = True,
    ) -> GuiFolderHandle:
        """Add a folder, and return a handle that can be used to populate it.

        Args:
            label: Label to display on the folder.
            order: Optional ordering, smallest values will be displayed first.
            expand_by_default: Open the folder by default. Set to False to collapse it by
                default.
            visible: Whether the component is visible.

        Returns:
            A handle that can be used as a context to populate the folder.
        """
        folder_container_id = _make_uuid()
        order = _apply_default_order(order)
        props = _messages.GuiFolderProps(
            order=order,
            label=label,
            expand_by_default=expand_by_default,
            visible=visible,
        )
        self._websock_interface.queue_message(
            _messages.GuiFolderMessage(
                uuid=folder_container_id,
                container_uuid=self._get_container_uuid(),
                props=props,
            )
        )
        return GuiFolderHandle(
            _GuiHandleState(
                folder_container_id,
                self,
                None,
                props=props,
                parent_container_id=self._get_container_uuid(),
            )
        )

    @deprecated_positional_shim
    def add_modal(
        self,
        title: str,
        *,
        order: float | None = None,
    ) -> GuiModalHandle:
        """Show a modal window, which can be useful for popups and messages, then return
        a handle that can be used to populate it.

        Args:
            title: Title to display on the modal.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used as a context to populate the modal.
        """
        modal_container_id = _make_uuid()
        order = _apply_default_order(order)
        self._websock_interface.queue_message(
            _messages.GuiModalMessage(
                order=order,
                uuid=modal_container_id,
                title=title,
            )
        )
        return GuiModalHandle(
            _gui_api=self,
            _uuid=modal_container_id,
        )

    @deprecated_positional_shim
    def add_tab_group(
        self,
        *,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiTabGroupHandle:
        """Add a tab group.

        Args:
            order: Optional ordering, smallest values will be displayed first.
            visible: Whether the component is visible.

        Returns:
            A handle that can be used as a context to populate the tab group.
        """
        tab_group_id = _make_uuid()
        order = _apply_default_order(order)

        message = _messages.GuiTabGroupMessage(
            uuid=tab_group_id,
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiTabGroupProps(
                order=order,
                _tab_labels=(),
                visible=visible,
                _tab_icons_html=(),
                _tab_container_ids=(),
            ),
        )
        self._websock_interface.queue_message(message)
        return GuiTabGroupHandle(
            _GuiHandleState(
                message.uuid,
                self,
                value=None,
                props=message.props,
                parent_container_id=message.container_uuid,
            )
        )

    @deprecated_positional_shim
    def add_markdown(
        self,
        content: str,
        *,
        image_root: Path | None = None,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiMarkdownHandle:
        """Add markdown to the GUI.

        Args:
            content: Markdown content to display.
            image_root: Optional root directory to resolve relative image paths.
            order: Optional ordering, smallest values will be displayed first.
            visible: Whether the component is visible.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        message = _messages.GuiMarkdownMessage(
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiMarkdownProps(
                order=_apply_default_order(order),
                _markdown="",
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)

        handle = GuiMarkdownHandle(
            _GuiHandleState(
                message.uuid,
                self,
                None,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
            _content=content,
            _image_root=image_root,
        )

        # Logic for processing markdown, handling images, etc is all in the
        # `.content` setter, which should send a GuiUpdateMessage.
        handle.content = content
        return handle

    @deprecated_positional_shim
    def add_html(
        self,
        content: str,
        *,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiHtmlHandle:
        """Add HTML to the GUI.

        Args:
            content: HTML content to display.
            order: Optional ordering, smallest values will be displayed first.
            visible: Whether the component is visible.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        message = _messages.GuiHtmlMessage(
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiHtmlProps(
                order=_apply_default_order(order),
                content=content,
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)

        handle = GuiHtmlHandle(
            _GuiHandleState(
                message.uuid,
                self,
                None,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
        )
        return handle

    @deprecated_positional_shim
    def add_image(
        self,
        image: np.ndarray,
        *,
        label: str | None = None,
        format: Literal["auto", "png", "jpeg"] = "auto",
        jpeg_quality: int | None = None,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiImageHandle:
        """Add an image element to the GUI.

        Args:
            image: A numpy array representing the image to display.
            label: Label to display on the image element.
            format: Format to transport and display the image using. 'auto' will use PNG for RGBA images and JPEG for RGB.
            jpeg_quality: Quality of the jpeg image (if jpeg format is used).
            order: Order of the element for sorting.
            visible: Whether the image element is visible initially.

        Returns:
            Handle for manipulating the image element.
        """
        # Resolve format if auto.
        if format == "auto":
            resolved_format = "png" if image.shape[2] == 4 else "jpeg"
        else:
            resolved_format = format

        message = _messages.GuiImageMessage(
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiImageProps(
                _data=None,  # Sent in prop update later.
                label=label,
                _format=resolved_format,
                order=_apply_default_order(order),
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)

        handle = GuiImageHandle(
            _GuiHandleState(
                message.uuid,
                self,
                None,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
            _image=image,
            _jpeg_quality=jpeg_quality,
        )
        handle._user_format = format
        handle.image = image
        return handle

    @deprecated_positional_shim
    def add_plotly(
        self,
        figure: go.Figure,
        *,
        aspect: float = 1.0,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiPlotlyHandle:
        """Add a Plotly figure to the GUI. Requires the `plotly` package to be
        installed.

        .. note::
           Updates to Plotly figures can be slow when you have many plots or frequent updates. For real-time visualization, consider using
           :meth:`add_uplot` instead.

        Args:
            figure: Plotly figure to display.
            aspect: Aspect ratio of the plot in the control panel (width/height).
            order: Optional ordering, smallest values will be displayed first.
            visible: Whether the component is visible.

        Returns:
            A handle that can be used to interact with the GUI element.
        """

        # If plotly.min.js hasn't been sent to the client yet, the client won't be able
        # to render the plot. Send this large file now! (~3MB)
        if not self._setup_plotly_js:
            # Check if plotly is installed.
            try:
                import plotly
            except ImportError:
                raise ImportError(
                    "You must have the `plotly` package installed to use the Plotly GUI element."
                )

            # Check that plotly.min.js exists.
            plotly_path = (
                Path(plotly.__file__).parent / "package_data" / "plotly.min.js"
            )
            assert plotly_path.exists(), (
                f"Could not find plotly.min.js at {plotly_path}."
            )

            # Send it over!
            plotly_js = plotly_path.read_text(encoding="utf-8")
            self._websock_interface.queue_message(
                _messages.RunJavascriptMessage(source=plotly_js)
            )

            # Update the flag so we don't send it again.
            self._setup_plotly_js = True

        # After plotly.min.js has been sent, we can send the plotly figure.
        # Empty string for `plotly_json_str` is a signal to the client to render nothing.
        message = _messages.GuiPlotlyMessage(
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiPlotlyProps(
                order=_apply_default_order(order),
                _plotly_json_str="",
                aspect=1.0,
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)

        handle = GuiPlotlyHandle(
            _GuiHandleState(
                message.uuid,
                self,
                value=None,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
            _figure=figure,
        )

        # Set the plotly handle properties.
        handle.figure = figure
        handle.aspect = aspect
        return handle

    @deprecated_positional_shim
    def add_uplot(
        self,
        data: tuple[np.ndarray, ...],
        series: tuple[uplot.Series, ...],
        *,
        mode: Literal[1, 2] | None = None,
        title: str | None = None,
        bands: tuple[uplot.Band, ...] | None = None,
        scales: dict[str, uplot.Scale] | None = None,
        axes: tuple[uplot.Axis, ...] | None = None,
        legend: uplot.Legend | None = None,
        cursor: uplot.Cursor | None = None,
        focus: uplot.Focus | None = None,
        aspect: float = 1.0,
        order: float | None = None,
        visible: bool = True,
    ) -> GuiUplotHandle:
        """Add a uPlot chart to the GUI for high-performance time-series visualization.

        uPlot is optimized for plotting large datasets with smooth pan/zoom interactions.
        All configuration options follow the standard uPlot API. For comprehensive
        documentation, see: https://github.com/leeoniya/uPlot/tree/1.6.32/docs

        .. note::
           Configuration types are exposed under the :mod:`viser.uplot` module for convenience:
           :class:`viser.uplot.Series`, :class:`viser.uplot.Scale`, :class:`viser.uplot.Axis`,
           :class:`viser.uplot.Band`, :class:`viser.uplot.Legend`, :class:`viser.uplot.Cursor`,
           and :class:`viser.uplot.Focus`. These are :py:class:`~typing.TypedDict` types;
           standard dictionaries can also be used.

        Args:
            data: Tuple of 1D numpy arrays containing chart data. The first array provides
                x-axis values, and subsequent arrays contain y-axis data for
                each series. All arrays must have identical length. Minimum 2
                arrays.
            series: Series configuration objects defining visual appearance and behavior.
                Must match the length of data tuple.
            mode: Chart layout mode. 1 = aligned (default) where all series share axes,
                2 = faceted where each series gets its own subplot panel.
            title: Chart title displayed at the top.
            bands: High/low range visualizations between data series. Useful for showing
                confidence intervals, error bounds, or min/max ranges. Each band connects
                two adjacent series indices.
            scales: Scale definitions controlling data-to-pixel mapping and axis ranges.
                Key features include auto-ranging, manual min/max, time-based scaling,
                and logarithmic distributions. Multiple scales enable dual-axis charts.
            axes: Axis configuration for labels, ticks, grids, and positioning.
                Controls which side axes appear (top/right/bottom/left), tick formatting,
                grid line styling, and spacing between tick marks.
            legend: Legend display options including positioning, styling, and custom
                value formatting functions for hover states.
            cursor: Interactive cursor behavior including hover proximity detection,
                drag-to-zoom, and crosshair appearance. Controls how users interact
                with the chart through mouse/touch.
            focus: Visual highlighting when hovering over series. Controls the alpha
                transparency of non-focused series to emphasize the active one.
            aspect: Width-to-height ratio for the chart display in the control panel.
                1.0 creates a square chart, values > 1.0 create wider charts.
            order: Display ordering relative to other GUI elements (lower values first).
            visible: Whether the chart is visible in the interface.

        Returns:
            A handle for programmatically updating chart properties and data.
        """

        # Validate data structure
        assert len(data) >= 2, (
            "data must have at least 2 arrays (x-data + at least one y-data series)"
        )
        assert all(isinstance(arr, np.ndarray) for arr in data), (
            "all data elements must be numpy arrays"
        )

        # Validate data dimensions and shapes
        for i, arr in enumerate(data):
            assert arr.ndim == 1, f"data[{i}] must be a 1D array, got shape {arr.shape}"

        # Check that all arrays have the same length
        lengths = [len(arr) for arr in data]
        if not all(length == lengths[0] for length in lengths):
            raise ValueError(
                f"All data arrays must have the same length. Got lengths: {lengths}"
            )

        # Validate series configuration
        assert len(series) > 0, "series must not be empty"
        if len(series) != len(data):
            raise ValueError(
                f"Length of series ({len(series)}) must match length of data ({len(data)}). "
                f"Each array in data needs a corresponding series configuration."
            )

        # Convert arrays to float64 as expected by GuiUplotProps
        data_float64 = tuple(arr.astype(np.float64) for arr in data)

        message = _messages.GuiUplotMessage(
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiUplotProps(
                order=_apply_default_order(order),
                data=data_float64,
                mode=mode,
                title=title,
                series=series,
                bands=bands,
                scales=scales,
                axes=axes,
                legend=legend,
                cursor=cursor,
                focus=focus,
                aspect=aspect,
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)

        return GuiUplotHandle(
            _GuiHandleState(
                message.uuid,
                self,
                value=None,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
        )

    @deprecated_positional_shim
    def add_button(
        self,
        label: str,
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        color: LiteralColor | tuple[int, int, int] | None = None,
        icon: IconName | None = None,
        order: float | None = None,
    ) -> GuiButtonHandle:
        """Add a button to the GUI. The value of this input is set to `True` every time
        it is clicked; to detect clicks, we can manually set it back to `False`.

        Args:
            label: Label to display on the button.
            visible: Whether the button is visible.
            disabled: Whether the button is disabled.
            hint: Optional hint to display on hover.
            color: Optional color to use for the button.
            icon: Optional icon to display on the button.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """

        # Re-wrap the GUI handle with a button interface.
        uuid = _make_uuid()
        order = _apply_default_order(order)
        props = _messages.GuiButtonProps(
            order=order,
            label=label,
            hint=hint,
            color=color,
            _icon_html=None if icon is None else svg_from_icon(icon),
            _hold_callback_freqs=(),
            disabled=disabled,
            visible=visible,
        )
        message = _messages.GuiButtonMessage(
            value=False,
            uuid=uuid,
            container_uuid=self._get_container_uuid(),
            props=props,
        )

        # Send the message.
        self._websock_interface.queue_message(message)

        # Construct button-specific handle state with hold callback support.
        handle_state = _GuiButtonHandleState(
            props=props,
            gui_api=self,
            value=False,
            update_timestamp=time.time(),
            parent_container_id=self._get_container_uuid(),
            update_cb=[],
            is_button=True,
            sync_cb=None,
            uuid=uuid,
            hold_cbs_from_freq={},
        )

        return GuiButtonHandle(handle_state, _icon=icon)

    @deprecated_positional_shim
    def add_upload_button(
        self,
        label: str,
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        color: LiteralColor | tuple[int, int, int] | None = None,
        icon: IconName | None = None,
        mime_type: str = "*/*",
        order: float | None = None,
    ) -> GuiUploadButtonHandle:
        """Add a button to the GUI. The value of this input is set to `True` every time
        it is clicked; to detect clicks, we can manually set it back to `False`.

        Args:
            label: Label to display on the button.
            visible: Whether the button is visible.
            disabled: Whether the button is disabled.
            hint: Optional hint to display on hover.
            color: Optional color to use for the button.
            icon: Optional icon to display on the button.
            mime_type: Optional MIME type to filter the files that can be uploaded.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """

        # Re-wrap the GUI handle with a button interface.
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiUploadButtonHandle(
            self._create_gui_input(
                value=UploadedFile("", b""),
                message=_messages.GuiUploadButtonMessage(
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiUploadButtonProps(
                        disabled=disabled,
                        visible=visible,
                        order=order,
                        label=label,
                        hint=hint,
                        color=color,
                        mime_type=mime_type,
                        _icon_html=None if icon is None else svg_from_icon(icon),
                    ),
                ),
                is_button=True,
            ),
            _icon=icon,
        )

    @deprecated_positional_shim
    def add_button_group(
        self,
        label: str,
        options: Sequence[str],
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiButtonGroupHandle:
        """Add a button group to the GUI.

        Args:
            label: Label to display on the button group.
            options: Sequence of options to display as buttons.
            disabled: Whether the button group is disabled.
            visible: Whether the button group is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = options[0]
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiButtonGroupHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiButtonGroupMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiButtonGroupProps(
                        order=order,
                        label=label,
                        hint=hint,
                        options=tuple(options),
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
                is_button=True,
            ),
        )

    @deprecated_positional_shim
    def add_checkbox(
        self,
        label: str,
        initial_value: bool,
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiCheckboxHandle:
        """Add a checkbox to the GUI.

        Args:
            label: Label to display on the checkbox.
            initial_value: Initial value of the checkbox.
            disabled: Whether the checkbox is disabled.
            visible: Whether the checkbox is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        assert isinstance(value, bool)
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiCheckboxHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiCheckboxMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiCheckboxProps(
                        order=order,
                        label=label,
                        hint=hint,
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            )
        )

    @deprecated_positional_shim
    def add_text(
        self,
        label: str,
        initial_value: str,
        *,
        multiline: bool = False,
        update_on: Literal["change", "submit"] = "change",
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiTextHandle:
        r"""Add a text input to the GUI.

        Args:
            label: Label to display on the text input.
            initial_value: Initial value of the text input.
            multiline: Whether the text input supports multiple lines, delimited with
                the \n character.
            update_on: When to fire on_update callbacks. ``"change"`` fires on every
                keystroke (default). ``"submit"`` fires only on Enter key or blur.
            disabled: Whether the text input is disabled.
            visible: Whether the text input is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        assert isinstance(value, str)
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiTextHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiTextMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiTextProps(
                        order=order,
                        label=label,
                        hint=hint,
                        disabled=disabled,
                        visible=visible,
                        multiline=multiline,
                        update_on=update_on,
                    ),
                ),
            )
        )

    @deprecated_positional_shim
    def add_number(
        self,
        label: str,
        initial_value: IntOrFloat,
        *,
        min: IntOrFloat | None = None,
        max: IntOrFloat | None = None,
        step: IntOrFloat | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiNumberHandle[IntOrFloat]:
        """Add a number input to the GUI, with user-specifiable bound and precision parameters.

        Args:
            label: Label to display on the number input.
            initial_value: Initial value of the number input.
            min: Optional minimum value of the number input.
            max: Optional maximum value of the number input.
            step: Optional step size of the number input. Computed automatically if not
                specified.
            disabled: Whether the number input is disabled.
            visible: Whether the number input is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value

        assert isinstance(value, (int, float))

        if step is None:
            # It's ok that `step` is always a float, even if the value is an integer,
            # because things all become `number` types after serialization.
            step = float(  # type: ignore
                np.min(
                    [
                        _compute_step(value),
                        _compute_step(min),
                        _compute_step(max),
                    ]
                )
            )

        assert step is not None

        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiNumberHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiNumberMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiNumberProps(
                        order=order,
                        label=label,
                        hint=hint,
                        min=min,
                        max=max,
                        precision=_compute_precision_digits(step),
                        step=step,
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
                is_button=False,
            )
        )

    @deprecated_positional_shim
    def add_vector2(
        self,
        label: str,
        initial_value: tuple[float, float] | np.ndarray,
        *,
        min: tuple[float, float] | np.ndarray | None = None,
        max: tuple[float, float] | np.ndarray | None = None,
        step: float | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiVector2Handle:
        """Add a length-2 vector input to the GUI.

        Args:
            label: Label to display on the vector input.
            initial_value: Initial value of the vector input.
            min: Optional minimum value of the vector input.
            max: Optional maximum value of the vector input.
            step: Optional step size of the vector input. Computed automatically if not
            disabled: Whether the vector input is disabled.
            visible: Whether the vector input is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        value = cast_vector(value, 2)
        min = cast_vector(min, 2) if min is not None else None
        max = cast_vector(max, 2) if max is not None else None
        uuid = _make_uuid()
        order = _apply_default_order(order)

        if step is None:
            possible_steps: list[float] = []
            possible_steps.extend([_compute_step(x) for x in value])
            if min is not None:
                possible_steps.extend([_compute_step(x) for x in min])
            if max is not None:
                possible_steps.extend([_compute_step(x) for x in max])
            step = float(np.min(possible_steps))

        return GuiVector2Handle(
            self._create_gui_input(
                value,
                message=_messages.GuiVector2Message(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiVector2Props(
                        order=order,
                        label=label,
                        hint=hint,
                        min=min,
                        max=max,
                        step=step,
                        precision=_compute_precision_digits(step),
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            )
        )

    @deprecated_positional_shim
    def add_vector3(
        self,
        label: str,
        initial_value: tuple[float, float, float] | np.ndarray,
        *,
        min: tuple[float, float, float] | np.ndarray | None = None,
        max: tuple[float, float, float] | np.ndarray | None = None,
        step: float | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiVector3Handle:
        """Add a length-3 vector input to the GUI.

        Args:
            label: Label to display on the vector input.
            initial_value: Initial value of the vector input.
            min: Optional minimum value of the vector input.
            max: Optional maximum value of the vector input.
            step: Optional step size of the vector input. Computed automatically if not
            disabled: Whether the vector input is disabled.
            visible: Whether the vector input is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        value = cast_vector(value, 3)
        min = cast_vector(min, 3) if min is not None else None
        max = cast_vector(max, 3) if max is not None else None
        uuid = _make_uuid()
        order = _apply_default_order(order)

        if step is None:
            possible_steps: list[float] = []
            possible_steps.extend([_compute_step(x) for x in value])
            if min is not None:
                possible_steps.extend([_compute_step(x) for x in min])
            if max is not None:
                possible_steps.extend([_compute_step(x) for x in max])
            step = float(np.min(possible_steps))

        return GuiVector3Handle(
            self._create_gui_input(
                value,
                message=_messages.GuiVector3Message(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiVector3Props(
                        order=order,
                        label=label,
                        hint=hint,
                        min=min,
                        max=max,
                        step=step,
                        precision=_compute_precision_digits(step),
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            )
        )

    # See add_dropdown for notes on overloads.
    @overload
    def add_dropdown(
        self,
        label: str,
        options: Sequence[TLiteralString],
        *,
        initial_value: TLiteralString | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiDropdownHandle[TLiteralString]: ...

    @overload
    def add_dropdown(
        self,
        label: str,
        options: Sequence[TString],
        *,
        initial_value: TString | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiDropdownHandle[TString]: ...

    @deprecated_positional_shim
    def add_dropdown(
        self,
        label: str,
        options: Sequence[TLiteralString] | Sequence[TString],
        *,
        initial_value: TLiteralString | TString | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiDropdownHandle[Any]:  # Output type is specified in overloads.
        """Add a dropdown to the GUI.

        Args:
            label: Label to display on the dropdown.
            options: Sequence of options to display in the dropdown.
            initial_value: Initial value of the dropdown.
            disabled: Whether the dropdown is disabled.
            visible: Whether the dropdown is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        if value is None:
            value = options[0]
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiDropdownHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiDropdownMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiDropdownProps(
                        order=order,
                        label=label,
                        hint=hint,
                        options=tuple(options),
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            ),
        )

    @deprecated_positional_shim
    def add_progress_bar(
        self,
        value: float,
        *,
        visible: bool = True,
        animated: bool = False,
        color: LiteralColor | tuple[int, int, int] | None = None,
        order: float | None = None,
    ) -> GuiProgressBarHandle:
        """Add a progress bar to the GUI.

        Args:
            value: Value of the progress bar. (0 - 100)
            visible: Whether the progress bar is visible.
            animated: Whether the progress bar is in a loading state (animated, striped).
            color: The color of the progress bar.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        assert value >= 0 and value <= 100
        message = _messages.GuiProgressBarMessage(
            value=value,
            uuid=_make_uuid(),
            container_uuid=self._get_container_uuid(),
            props=_messages.GuiProgressBarProps(
                order=_apply_default_order(order),
                animated=animated,
                color=color,
                visible=visible,
            ),
        )
        self._websock_interface.queue_message(message)
        handle = GuiProgressBarHandle(
            _GuiHandleState(
                message.uuid,
                self,
                value=value,
                props=message.props,
                parent_container_id=message.container_uuid,
            ),
        )
        return handle

    @deprecated_positional_shim
    def add_slider(
        self,
        label: str,
        min: IntOrFloat,
        max: IntOrFloat,
        step: IntOrFloat,
        initial_value: IntOrFloat,
        *,
        marks: tuple[IntOrFloat | tuple[IntOrFloat, str], ...] | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiSliderHandle[IntOrFloat]:
        """Add a slider to the GUI. Types of the min, max, step, and initial value should match.

        Args:
            label: Label to display on the slider.
            min: Minimum value of the slider.
            max: Maximum value of the slider.
            step: Step size of the slider.
            initial_value: Initial value of the slider.
            marks: tuple of marks to display below the slider. Each mark should
                either be a numerical or a (number, label) tuple, where the
                label is provided as a string.
            disabled: Whether the slider is disabled.
            visible: Whether the slider is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value: IntOrFloat = initial_value
        assert max >= min
        step = builtins.min(step, max - min)
        assert max >= value >= min

        # GUI callbacks cast incoming values to match the type of the initial value. If
        # the min, max, or step is a float, we should cast to a float.
        #
        # This should also match what the IntOrFloat TypeVar resolves to.
        if type(value) is int and (
            type(min) is float or type(max) is float or type(step) is float
        ):
            value = float(value)  # type: ignore

        # TODO: as of 6/5/2023, this assert will break something in nerfstudio. (at
        # least LERF)
        #
        # assert type(min) == type(max) == type(step) == type(value)

        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiSliderHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiSliderMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiSliderProps(
                        order=order,
                        label=label,
                        hint=hint,
                        min=min,
                        max=max,
                        step=step,
                        precision=_compute_precision_digits(step),
                        visible=visible,
                        disabled=disabled,
                        _marks=tuple(
                            GuiSliderMark(value=float(x[0]), label=x[1])
                            if isinstance(x, tuple)
                            else GuiSliderMark(value=x, label=None)
                            for x in marks
                        )
                        if marks is not None
                        else None,
                    ),
                ),
                is_button=False,
            )
        )

    @deprecated_positional_shim
    def add_multi_slider(
        self,
        label: str,
        min: IntOrFloat,
        max: IntOrFloat,
        step: IntOrFloat,
        initial_value: tuple[IntOrFloat, ...],
        *,
        min_range: IntOrFloat | None = None,
        fixed_endpoints: bool = False,
        marks: tuple[IntOrFloat | tuple[IntOrFloat, str], ...] | None = None,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiMultiSliderHandle[IntOrFloat]:
        """Add a multi slider to the GUI. Types of the min, max, step, and initial value should match.

        Args:
            label: Label to display on the slider.
            min: Minimum value of the slider.
            max: Maximum value of the slider.
            step: Step size of the slider.
            initial_value: Initial values of the slider.
            min_range: Optional minimum difference between two values of the slider.
            fixed_endpoints: Whether the endpoints of the slider are fixed.
            marks: tuple of marks to display below the slider. Each mark should
                either be a numerical or a (number, label) tuple, where the
                label is provided as a string.
            disabled: Whether the slider is disabled.
            visible: Whether the slider is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        assert max >= min
        step = builtins.min(step, max - min)
        assert all(max >= x >= min for x in initial_value)

        # GUI callbacks cast incoming values to match the type of the initial value. If
        # any of the arguments are floats, we should always use a float value.
        #
        # This should also match what the IntOrFloat TypeVar resolves to.
        if (
            type(min) is float
            or type(max) is float
            or type(step) is float
            or type(min_range) is float
        ):
            initial_value = tuple(float(x) for x in initial_value)  # type: ignore

        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiMultiSliderHandle(
            self._create_gui_input(
                value=initial_value,
                message=_messages.GuiMultiSliderMessage(
                    value=initial_value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiMultiSliderProps(
                        order=order,
                        label=label,
                        hint=hint,
                        min=min,
                        min_range=min_range,
                        max=max,
                        step=step,
                        visible=visible,
                        disabled=disabled,
                        fixed_endpoints=fixed_endpoints,
                        precision=_compute_precision_digits(step),
                        _marks=tuple(
                            GuiSliderMark(value=float(x[0]), label=x[1])
                            if isinstance(x, tuple)
                            else GuiSliderMark(value=x, label=None)
                            for x in marks
                        )
                        if marks is not None
                        else None,
                    ),
                ),
                is_button=False,
            )
        )

    @deprecated_positional_shim
    def add_rgb(
        self,
        label: str,
        initial_value: tuple[int, int, int],
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiRgbHandle:
        """Add an RGB picker to the GUI. All values should be in [0, 255].

        Args:
            label: Label to display on the RGB picker.
            initial_value: Initial value of the RGB picker.
            disabled: Whether the RGB picker is disabled.
            visible: Whether the RGB picker is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """

        value = initial_value
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiRgbHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiRgbMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiRgbProps(
                        order=order,
                        label=label,
                        hint=hint,
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            )
        )

    @deprecated_positional_shim
    def add_rgba(
        self,
        label: str,
        initial_value: tuple[int, int, int, int],
        *,
        disabled: bool = False,
        visible: bool = True,
        hint: str | None = None,
        order: float | None = None,
    ) -> GuiRgbaHandle:
        """Add an RGBA picker to the GUI. All values should be in [0, 255].

        Args:
            label: Label to display on the RGBA picker.
            initial_value: Initial value of the RGBA picker.
            disabled: Whether the RGBA picker is disabled.
            visible: Whether the RGBA picker is visible.
            hint: Optional hint to display on hover.
            order: Optional ordering, smallest values will be displayed first.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        value = initial_value
        uuid = _make_uuid()
        order = _apply_default_order(order)
        return GuiRgbaHandle(
            self._create_gui_input(
                value,
                message=_messages.GuiRgbaMessage(
                    value=value,
                    uuid=uuid,
                    container_uuid=self._get_container_uuid(),
                    props=_messages.GuiRgbaProps(
                        order=order,
                        label=label,
                        hint=hint,
                        disabled=disabled,
                        visible=visible,
                    ),
                ),
            )
        )

    class _GuiMessage(Protocol[GuiInputPropsType]):
        uuid: str
        props: GuiInputPropsType

    def _create_gui_input(
        self,
        value: T,
        message: _GuiMessage,
        is_button: bool = False,
    ) -> _GuiHandleState[T]:
        """Private helper for adding a simple GUI element."""

        # Send add GUI input message.
        assert isinstance(message, _messages.Message)
        self._websock_interface.queue_message(message)

        # Construct handle.
        handle_state = _GuiHandleState(
            props=message.props,
            gui_api=self,
            value=value,
            update_timestamp=time.time(),
            parent_container_id=self._get_container_uuid(),
            update_cb=[],
            is_button=is_button,
            sync_cb=None,
            uuid=message.uuid,
        )

        # For broadcasted GUI handles, we should synchronize all clients.
        # This will be a no-op for client handles.
        if not is_button:

            def sync_other_clients(
                client_id: ClientId, updates: dict[str, Any]
            ) -> None:
                message = _messages.GuiUpdateMessage(handle_state.uuid, updates)
                message.excluded_self_client = client_id
                self._websock_interface.queue_message(message)

            handle_state.sync_cb = sync_other_clients

        return handle_state
