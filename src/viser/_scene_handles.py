from __future__ import annotations

import asyncio
import copy
import dataclasses
import warnings
from collections.abc import Coroutine
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Generic,
    Literal,
    Optional,
    Protocol,
    Tuple,
    TypeVar,
    Union,
    cast,
    get_args,
    overload,
)

import numpy as np
import numpy.typing as npt
from typing_extensions import Self, deprecated, override

from . import _messages
from ._assignable_props_api import AssignablePropsBase
from .infra._infra import (
    WebsockClientConnection,
    WebsockMessageHandler,
    WebsockServer,
)

if TYPE_CHECKING:
    from ._gui_api import GuiApi
    from ._scene_api import SceneApi
    from ._viser import ClientHandle
    from .infra import ClientId


_PoseTupleT = TypeVar("_PoseTupleT", bound=Tuple[float, ...])


def _set_pose_vector(
    current: np.ndarray,
    value: _PoseTupleT | np.ndarray,
    length: int,
    websock: WebsockMessageHandler,
    make_message: Callable[[_PoseTupleT], _messages.Message],
) -> None:
    """Shared write path for the scene-node and skinned-bone pose setters.

    Casts and validates ``value``, no-ops if it is numerically unchanged from
    ``current``, and otherwise writes it into ``current`` in place and queues the
    message built from the cast value. Keeping this in one place stops the four
    near-identical wxyz/position setters from drifting apart.
    """
    from ._scene_api import cast_vector

    value_cast: _PoseTupleT = cast_vector(value, length)
    if np.allclose(value_cast, current):
        return
    current[:] = np.asarray(value)
    websock.queue_message(make_message(value_cast))


@dataclasses.dataclass(frozen=True)
class SceneClickEvent:
    """Event passed to scene-level click callbacks (``SceneApi.on_click``)."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    ray_origin: tuple[float, float, float]
    """Origin of the 3D ray corresponding to this click, in world coordinates."""
    ray_direction: tuple[float, float, float]
    """Direction of the 3D ray corresponding to this click, in world coordinates."""
    screen_pos: tuple[float, float]
    """Screen position of the click in OpenCV image coordinates (0 to 1).
    (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner."""
    modifier: _messages.KeyModifier | None
    """Modifier-combo held at click time. ``None`` if no modifiers
    were held; otherwise a canonical :data:`KeyModifier` string."""


@dataclasses.dataclass(frozen=True)
class SceneRectSelectEvent:
    """Event passed to scene rectangle-select callbacks
    (``SceneApi.on_rect_select``)."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    screen_min: tuple[float, float]
    """Min-corner of the selection rectangle in OpenCV image coordinates
    (0 to 1)."""
    screen_max: tuple[float, float]
    """Max-corner of the selection rectangle."""
    modifier: _messages.KeyModifier | None
    """Modifier-combo held at gesture start. ``None`` if no modifiers
    were held; otherwise a canonical :data:`KeyModifier` string."""


@dataclasses.dataclass(frozen=True)
class ScenePointerEvent:
    """Event passed to scene pointer callbacks (legacy ``on_pointer_event``).

    .. deprecated::
        Use :meth:`SceneApi.on_click` with :class:`SceneClickEvent` or
        :meth:`SceneApi.on_rect_select` with :class:`SceneRectSelectEvent`
        instead. This shape unions the click and rect-select cases into a
        single dataclass with awkward Optional/variable-length fields.
    """

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    event_type: _messages.ScenePointerEventType
    """Type of event that was triggered. Currently we only support clicks and box selections."""
    ray_origin: tuple[float, float, float] | None
    """Origin of 3D ray corresponding to this click, in world coordinates."""
    ray_direction: tuple[float, float, float] | None
    """Direction of 3D ray corresponding to this click, in world coordinates."""
    screen_pos: tuple[tuple[float, float], ...]
    """Screen position of the click on the screen (OpenCV image coordinates, 0 to 1).
    (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner.
    For a box selection, this includes the min- and max- corners of the box."""
    modifier: _messages.KeyModifier | None
    """Modifier-combo held when this event fired. ``None`` if no
    modifiers were held; otherwise a canonical :data:`KeyModifier`
    string."""

    @property
    @deprecated("The `event` property is deprecated. Use `event_type` instead.")
    def event(self):
        """Deprecated. Use `event_type` instead.

        .. deprecated:: 0.2.23
            The `event` property is deprecated. Use `event_type` instead.
        """
        return self.event_type


TSceneNodeHandle = TypeVar("TSceneNodeHandle", bound="SceneNodeHandle")


DragPhase = Literal["start", "update", "end"]
"""Which point in a scene-node drag lifecycle a callback fires on."""


@dataclasses.dataclass(frozen=True)
class _DragInput:
    """Pointer input state at the moment of a drag event.

    Private -- consolidates the button + modifier pair that would
    otherwise move as separate positional args through every dispatch
    function."""

    button: Literal["left", "middle", "right"]
    modifier: _messages.KeyModifier | None


@dataclasses.dataclass
class _DragCallbackEntry:
    """One registered drag callback + its filter.

    Private to the handle; exposed to dispatch via ``_dispatch_drag``."""

    callback: Callable[
        [SceneNodeDragEvent[_RaycastSupportedSceneNodeHandle]], None | Coroutine
    ]
    button: _messages.DragButton
    modifier: _messages.KeyModifier | None


@dataclasses.dataclass
class _ClickCallbackEntry:
    """One registered click callback + its modifier filter.

    Private to the handle; exposed to dispatch via ``_dispatch_click``."""

    callback: Callable[
        [SceneNodePointerEvent[_RaycastSupportedSceneNodeHandle]], None | Coroutine
    ]
    modifier: _messages.KeyModifier | None


@dataclasses.dataclass
class _SceneNodeHandleState:
    name: str
    props: Any  # _messages.*Prop object.
    """Message containing properties of this scene node that are sent to the
    client."""
    api: SceneApi
    wxyz: np.ndarray = dataclasses.field(
        default_factory=lambda: np.array([1.0, 0.0, 0.0, 0.0])
    )
    position: np.ndarray = dataclasses.field(
        default_factory=lambda: np.array([0.0, 0.0, 0.0])
    )
    visible: bool = True
    click_cb: list[_ClickCallbackEntry] = dataclasses.field(default_factory=list)
    drag_cb: list[_DragCallbackEntry] = dataclasses.field(default_factory=list)
    removed: bool = False
    # Last bindings tuple published to the client. Used to dedup
    # redundant ``SetSceneNodeClickBindingsMessage`` emits — without
    # this, a no-op ``remove_click_callback("foo")`` for an
    # unregistered callback resends an empty bindings tuple.
    # ``None`` until the first publish.
    _last_published_click_bindings: tuple[_messages.DragBinding, ...] | None = None


def _normalize_node_name(name: str) -> str:
    """Scene node names are canonicalized to always start with "/"."""
    return name if name.startswith("/") else "/" + name


class _SceneNodeMessage(Protocol):
    name: str
    props: Any


class SceneNodeHandle(AssignablePropsBase[_SceneNodeHandleState]):
    """Handle base class for interacting with scene nodes."""

    @override
    def _queue_update(self, name: str, value: Any) -> None:
        self._impl.api._websock_interface.queue_message(
            _messages.SceneNodeUpdateMessage(self._impl.name, {name: value})
        )

    @property
    def name(self) -> str:
        """Read-only name of the scene node."""
        return self._impl.name

    @classmethod
    def _make(
        cls: type[TSceneNodeHandle],
        api: SceneApi,
        message: _SceneNodeMessage,
        name: str,
        wxyz: tuple[float, float, float, float] | np.ndarray,
        position: tuple[float, float, float] | np.ndarray,
        visible: bool,
    ) -> TSceneNodeHandle:
        """Create scene node: send state to client(s) and set up
        server-side state."""
        # Normalize name to always start with "/".
        name = _normalize_node_name(name)
        message.name = name

        # Ensure all ancestor nodes exist (creates intermediate frames as needed).
        api._ensure_ancestors_exist(name)

        # Send message.
        assert isinstance(message, _messages.Message)
        api._websock_interface.queue_message(message)

        out = cls(_SceneNodeHandleState(name, copy.deepcopy(message.props), api))
        api._handle_from_node_name[name] = out

        # Track parent -> child relationship.
        parent = name.rsplit("/", 1)[0]
        api._children_from_node_name.setdefault(parent, set()).add(name)
        api._children_from_node_name.setdefault(name, set())

        out.wxyz = wxyz
        out.position = position

        # Toggle visibility to make sure we send a
        # SetSceneNodeVisibilityMessage to the client.
        out._impl.visible = not visible
        out.visible = visible
        return out

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the scene node. This is the quaternion representation of the R
        in `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.wxyz

    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        # wxyz is assumed to be a unit quaternion (the client applies it to the
        # object's rotation without normalizing).
        _set_pose_vector(
            self._impl.wxyz,
            wxyz,
            4,
            self._impl.api._websock_interface,
            lambda v: _messages.SetOrientationMessage(self._impl.name, v),
        )

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the scene node. This is equivalent to the t in
        `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        _set_pose_vector(
            self._impl.position,
            position,
            3,
            self._impl.api._websock_interface,
            lambda v: _messages.SetPositionMessage(self._impl.name, v),
        )

    @property
    def visible(self) -> bool:
        """Whether the scene node is visible or not. Synchronized to clients automatically when assigned."""
        return self._impl.visible

    @visible.setter
    def visible(self, visible: bool) -> None:
        if visible == self._impl.visible:
            return
        self._impl.api._websock_interface.queue_message(
            _messages.SetSceneNodeVisibilityMessage(self._impl.name, visible)
        )
        self._impl.visible = visible

    def remove(self) -> None:
        """Remove the node from the scene."""
        # Warn if already removed.
        if self._impl.removed:
            warnings.warn(f"Attempted to remove already removed node: {self.name}")
            return

        # Collect all descendants via BFS.
        api = self._impl.api
        to_remove = [self._impl.name]
        i = 0
        while i < len(to_remove):
            children = api._children_from_node_name.get(to_remove[i], ())
            to_remove.extend(children)
            i += 1

        # Clear stale per-node interaction state (click + drag) before
        # we tear down handles. The bindings messages are name-keyed in
        # the persistent buffer and aren't purged by
        # ``RemoveSceneNodeMessage``, so without an empty replacement a
        # future node created with the same name would inherit stale
        # interaction state on late-joining clients. Has to run for
        # every node in ``to_remove`` (not just ``self``) so cascading
        # parent removal cleans up interactive descendants too.
        #
        # Drag callbacks are preserved when a drag is in flight: the
        # client will send a final ``phase="end"`` message after it
        # observes the removal (via ``stopIfNodeIs``), and the user's
        # ``on_drag_end`` MUST fire so per-drag state can be released.
        # ``_handle_node_drag`` looks the handle up in the active-drag
        # registry for non-start phases, so preserving ``drag_cb`` on
        # the handle keeps the dispatch path alive until end.
        for node_name in to_remove:
            handle = api._handle_from_node_name.get(node_name)
            if handle is None:
                continue
            impl = handle._impl
            if len(impl.click_cb) > 0:
                # Empty the per-node click-binding set so a re-created
                # node with the same name doesn't inherit the prior
                # node's modifier filters from the persistent buffer.
                api._websock_interface.queue_message(
                    _messages.SetSceneNodeClickBindingsMessage(node_name, ())
                )
            if impl.drag_cb:
                if not api._is_drag_active_for(node_name):
                    impl.drag_cb.clear()
                api._websock_interface.queue_message(
                    _messages.SetSceneNodeDragBindingsMessage(node_name, ())
                )

        # Tear down each descendant from both dicts and let it release any
        # subclass-specific registries via the polymorphic ``_on_remove`` hook.
        # This runs once per node -- for direct removal, ``reset()``, and
        # cascading parent removal alike -- because a node removed via an
        # ancestor never has its own ``remove()`` called.
        for node_name in to_remove:
            handle = api._handle_from_node_name.pop(node_name, None)
            api._children_from_node_name.pop(node_name, None)
            if handle is None:
                continue
            handle._impl.removed = True
            handle._on_remove()

        # Remove from parent's children set.
        parent = self._impl.name.rsplit("/", 1)[0]
        parent_children = api._children_from_node_name.get(parent)
        if parent_children is not None:
            parent_children.discard(self._impl.name)

        # Send a RemoveSceneNodeMessage per descendant so redundancy keys
        # clean up their creation messages from the broadcast buffer.
        for node_name in to_remove:
            api._websock_interface.queue_message(
                _messages.RemoveSceneNodeMessage(node_name)
            )

    def _on_remove(self) -> None:
        """Release any subclass-specific registries for this node.

        Called once per node during removal -- including when the node is
        removed via an ancestor's cascade, where a subclass ``remove()`` would
        never run. The base node holds no extra registries, so this is a no-op;
        subclasses override it to clean up their own state."""


@dataclasses.dataclass(frozen=True)
class SceneNodePointerEvent(Generic[TSceneNodeHandle]):
    """Event passed to pointer callbacks for scene nodes (currently only clicks)."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    event: Literal["click"]
    """Type of event that was triggered. Currently we only support clicks."""
    target: TSceneNodeHandle
    """Scene node that was clicked."""
    ray_origin: tuple[float, float, float]
    """Origin of 3D ray corresponding to this click, in world coordinates."""
    ray_direction: tuple[float, float, float]
    """Direction of 3D ray corresponding to this click, in world coordinates."""
    screen_pos: tuple[float, float]
    """Screen position of the click on the screen (OpenCV image coordinates, 0 to 1).
    (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner."""
    instance_index: int | None
    """Instance ID of the clicked object, if applicable. Currently this is `None` for all objects except for the output of :meth:`SceneApi.add_batched_axes()`."""
    modifier: _messages.KeyModifier | None
    """Modifier-combo held when this event fired. ``None`` if no
    modifiers were held; otherwise a canonical :data:`KeyModifier`
    string."""


@dataclasses.dataclass(frozen=True)
class TransformControlsEvent:
    """Event passed to callbacks for transform control updates."""

    client: ClientHandle | None
    """Client that triggered this event."""
    client_id: int | None
    """ID of client that triggered this event."""
    target: TransformControlsHandle
    """Transform controls handle that was affected."""
    phase: DragPhase
    """Drag lifecycle phase: ``"start"`` when the user grabs a handle,
    ``"update"`` on every pose change while dragging, ``"end"`` at
    release. ``target.wxyz`` and ``target.position`` reflect the
    current pose on every phase (start/end fire at the same pose as
    the surrounding update)."""


NoneOrCoroutine = TypeVar("NoneOrCoroutine", None, Coroutine)


@dataclasses.dataclass(frozen=True)
class SceneNodeDragEvent(Generic[TSceneNodeHandle]):
    """Event passed to scene-node drag callbacks."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    target: TSceneNodeHandle
    """Scene node that is being dragged."""
    phase: DragPhase
    """Drag lifecycle phase: ``"start"`` once a press is confirmed as a
    drag (the pointer travels past a small motion threshold -- a
    stationary press/release fires nothing), ``"update"`` on every
    throttled pointermove (~20Hz), ``"end"`` at release.

    A gesture is partitioned into one *segment* per held modifier-combo.
    Each segment fires exactly one ``"start"``, zero or more
    ``"update"``s, and exactly one ``"end"``. If the user changes the
    held modifier mid-drag, the current segment ends and a new one
    starts under the new modifier (see :attr:`modifier`) -- so a single
    physical drag can produce more than one ``start``/``end`` pair. When
    the modifier doesn't change, this collapses to the common case of a
    single ``start`` ... ``end`` per gesture."""
    instance_index: int | None
    """Instance index within a batched scene node (e.g. batched meshes,
    batched GLBs, batched axes); ``None`` for non-batched nodes. Frozen
    at drag-start -- the drag always refers to the instance that was
    under the cursor when the gesture began."""
    start_position: Tuple[float, float, float]
    """World-coords position of the click point on the object. *Live* --
    updates each event as the object moves, so it always reflects where
    the grab point currently is in world coords (useful for
    rotate-around-grab gestures)."""
    start_screen_pos: Tuple[float, float]
    """Live OpenCV screen-space projection of the click point."""
    end_position: Tuple[float, float, float]
    """Current pointer projected onto the camera-aligned drag plane,
    in world coords."""
    end_screen_pos: Tuple[float, float]
    """Current pointer in OpenCV screen-space coordinates."""
    button: Literal["left", "middle", "right"]
    """Mouse button that initiated the drag."""
    modifier: _messages.KeyModifier | None
    """Modifier-combo that owns the current drag segment. Constant within
    a segment and matches the binding this callback was registered for;
    if the user changes the held modifier mid-drag the segment ends and a
    new one begins under the new combo (see :attr:`phase`). ``None`` if no
    modifiers are held; otherwise a canonical :data:`KeyModifier`
    string."""


_VALID_DRAG_BUTTONS: Tuple[_messages.DragButton, ...] = get_args(_messages.DragButton)


class _RaycastSupportedSceneNodeHandle(SceneNodeHandle):
    def _sync_drag_bindings(self) -> None:
        """Recompute the union of registered (button, modifiers) and
        push it to the client as a full binding set."""
        seen: set[Tuple[_messages.DragButton, _messages.KeyModifier | None]] = set()
        bindings: list[_messages.DragBinding] = []
        for entry in self._impl.drag_cb:
            key = (entry.button, entry.modifier)
            if key in seen:
                continue
            seen.add(key)
            bindings.append(
                _messages.DragBinding(button=entry.button, modifier=entry.modifier)
            )
        self._impl.api._websock_interface.queue_message(
            _messages.SetSceneNodeDragBindingsMessage(self._impl.name, tuple(bindings))
        )

    def _has_any_drag_callbacks(self) -> bool:
        return bool(self._impl.drag_cb)

    def _dispatch_drag(
        self, input: _DragInput
    ) -> list[
        Callable[
            [SceneNodeDragEvent[_RaycastSupportedSceneNodeHandle]], None | Coroutine
        ]
    ]:
        """Return the callbacks whose filter matches this input."""
        from ._scene_api import _drag_input_matches_filter

        return [
            entry.callback
            for entry in self._impl.drag_cb
            if _drag_input_matches_filter(input, entry.button, entry.modifier)
        ]

    @staticmethod
    def _validate_button(button: _messages.DragButton) -> None:
        if button not in _VALID_DRAG_BUTTONS:
            raise ValueError(
                f"Unknown drag button {button!r}. "
                f"Valid buttons: {list(_VALID_DRAG_BUTTONS)!r}."
            )

    def _register_drag_callback(
        self: Self,
        button: _messages.DragButton,
        modifier: _messages.KeyModifier | None = None,
    ) -> Callable[
        [Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine]],
        Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine],
    ]:
        self._validate_button(button)
        normalized = _messages._normalize_key_modifier(modifier)

        def decorator(
            func: Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine],
        ) -> Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine]:
            entry = _DragCallbackEntry(
                callback=cast(
                    Callable[
                        [SceneNodeDragEvent[_RaycastSupportedSceneNodeHandle]],
                        Union[None, Coroutine],
                    ],
                    func,
                ),
                button=button,
                modifier=normalized,
            )
            # Skip duplicate registration -- without this, the same
            # callback fires twice per matching event. Equality is by
            # tuple/dataclass value.
            if entry not in self._impl.drag_cb:
                self._impl.drag_cb.append(entry)
                self._sync_drag_bindings()
            return func

        return decorator

    @overload
    def on_drag(
        self: Self,
        button: Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine],
    ) -> Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine]: ...

    @overload
    def on_drag(
        self: Self,
        button: _messages.DragButton = ...,
        *,
        modifier: _messages.KeyModifier | None = ...,
    ) -> Callable[
        [Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine]],
        Callable[[SceneNodeDragEvent[Self]], NoneOrCoroutine],
    ]: ...

    def on_drag(
        self: Self,
        button: Union[_messages.DragButton, Callable[..., Any]] = "left",
        *,
        modifier: _messages.KeyModifier | None = None,
    ) -> Any:
        """Attach a callback for the full drag lifecycle.

        Fires once with ``event.phase == "start"`` when a press is
        confirmed as a drag (the pointer travels past a small motion
        threshold; a stationary press/release fires nothing), zero or
        more times with ``"update"`` (throttled pointermove), and once
        with ``"end"`` at release. ``end`` fires even on cancellation
        paths (window blur, pointer cancel, node removed mid-drag) so
        per-drag state can be released.

        Modifiers are live: if the user changes the held modifier
        mid-drag, the current segment ends and a new one begins under
        the new combo, routing to whichever callback that combo is bound
        to. A callback therefore sees a clean ``start`` ... ``end`` pair
        for *its* modifier each time that modifier is engaged, and a
        single physical drag may fire more than one such pair. To switch
        behavior mid-drag (e.g. changing the drag plane), register a
        separate ``on_drag`` for each modifier combo. ``event.modifier``
        identifies the active segment.

        A switch-created segment's ``start`` is confirmed briefly
        (~100ms, or sooner on pointer motion) before it fires; releasing
        the mouse button within that window discards the segment
        entirely. In particular, releasing the modifier a beat before
        the button -- the natural way to end a modifier-drag -- does
        *not* fire a spurious start/end pair on the combo left behind
        (e.g. a bare ``on_drag`` registered alongside a modifier
        binding).

        Usable as a bare decorator (``@handle.on_drag``, defaults to
        ``button="left"`` and no modifiers) or with arguments
        (``@handle.on_drag("left", modifier="cmd/ctrl")``).

        Args:
            button: Mouse button that triggers the drag. One of
                ``"left" | "middle" | "right"``. Defaults to ``"left"``.
            modifier: Modifier keys that must be held, as a canonically
                ordered ``"+"``-separated string like ``"cmd/ctrl"``,
                ``"shift"``, or ``"cmd/ctrl+shift"``. ``None`` matches
                "no modifiers held". Matching is exact: listed modifiers
                must be held and others must not be. The match is
                re-evaluated whenever the held modifier changes mid-drag,
                so this callback is entered and exited as its combo is
                engaged and released. Left-drag on this node intercepts
                the gesture -- the camera only orbits on empty-space
                drags.

        Note on ordering: synchronous (``def``) callbacks are submitted
        to a thread pool fire-and-forget and can run out of order -- an
        ``"update"`` phase may begin before ``"start"`` finishes,
        leaving any state set in ``"start"`` ``None`` when ``"update"``
        reads it. To get strict ordering, define your callback as
        ``async def``; async callbacks are awaited on the event loop,
        which preserves phase order so long as you don't ``await``
        inside them.
        """
        if callable(button):
            # Bare-decorator form: @handle.on_drag -- defaults to
            # button="left" and no modifiers.
            return self._register_drag_callback("left", modifier)(
                button  # type: ignore[arg-type]
            )
        return self._register_drag_callback(button, modifier)

    def remove_drag_callback(self, callback: Literal["all"] | Callable = "all") -> None:
        """Remove drag callbacks from the scene node.

        ``callback="all"`` removes every drag callback; a specific
        function removes only entries whose callback identity matches.
        """
        if callback == "all":
            self._impl.drag_cb.clear()
        else:
            self._impl.drag_cb = [
                entry for entry in self._impl.drag_cb if entry.callback != callback
            ]
        self._sync_drag_bindings()

    @overload
    def on_click(
        self: Self,
        func: Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine],
    ) -> Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine]: ...

    @overload
    def on_click(
        self: Self,
        *,
        modifier: _messages.KeyModifier | None = ...,
    ) -> Callable[
        [Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine]],
        Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine],
    ]: ...

    def on_click(
        self: Self,
        func: Optional[Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine]] = None,
        *,
        modifier: _messages.KeyModifier | None = None,
    ) -> Any:
        """Attach a callback for when a scene node is clicked.

        Usable as a bare decorator (``@handle.on_click``) or with a
        modifier filter (``@handle.on_click(modifier="cmd/ctrl")``).

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.
        Using async functions can be useful for reducing race conditions.

        Args:
            modifier: Modifier-combo filter. Default ``None`` matches
                "no modifiers held". ``"cmd/ctrl"``, ``"shift"``,
                ``"cmd/ctrl+shift"``, etc. are exact matches (listed
                modifiers held, others not). ``cmd/ctrl`` matches
                whenever either Cmd or Ctrl is held.
        """
        # Validate eagerly so a bad string raises at the call site,
        # not when the user later applies the returned decorator.
        normalized_modifier = _messages._normalize_key_modifier(modifier)

        def register(callback: Callable) -> Callable:
            self._impl.click_cb.append(
                _ClickCallbackEntry(
                    callback=cast(
                        Callable[
                            [SceneNodePointerEvent[_RaycastSupportedSceneNodeHandle]],
                            Union[None, Coroutine],
                        ],
                        callback,
                    ),
                    modifier=normalized_modifier,
                )
            )
            self._publish_click_state()
            return callback

        if func is None:
            return register
        return register(func)

    def remove_click_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove click callbacks from scene node.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl.click_cb.clear()
        else:
            self._impl.click_cb = [
                entry for entry in self._impl.click_cb if entry.callback != callback
            ]
        self._publish_click_state()

    def _publish_click_state(self) -> None:
        """Publish ``SetSceneNodeClickBindingsMessage`` to the client
        only when the bindings tuple has changed since the last
        publish. Without the dedup, a no-op
        ``remove_click_callback("nonexistent")`` would still emit an
        empty bindings tuple.

        The client derives `clickable` from `bindings.length > 0`; no
        separate flag is sent.
        """
        bindings = tuple(
            _messages.DragBinding(button="left", modifier=entry.modifier)
            for entry in self._impl.click_cb
        )
        if self._impl._last_published_click_bindings == bindings:
            return
        # Queue the message BEFORE committing the cache. If
        # ``queue_message`` raises, the cache stays at its previous
        # value so the next state change retries the publish.
        self._impl.api._websock_interface.queue_message(
            _messages.SetSceneNodeClickBindingsMessage(self._impl.name, bindings)
        )
        self._impl._last_published_click_bindings = bindings


class CameraFrustumHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.CameraFrustumProps,
):
    """Handle for camera frustums."""

    _image: np.ndarray | None
    _jpeg_quality: int | None
    _user_format: Literal["auto", "jpeg", "png"]

    @property
    def image(self) -> np.ndarray | None:
        """Current content of the image. Synchronized automatically when assigned."""
        return self._image

    @image.setter
    def image(self, image: np.ndarray | None) -> None:
        from ._scene_api import _encode_image_binary

        if image is None:
            self._image = None
            self._image_data = None
            return

        self._image = image
        resolved_format, data = _encode_image_binary(
            image, self._user_format, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._image_data = data

    @property
    def format(self) -> Literal["auto", "jpeg", "png"]:
        """Image format. 'auto' will use PNG for RGBA images and JPEG for RGB."""
        return self._user_format

    @format.setter
    def format(self, value: Literal["auto", "jpeg", "png"]) -> None:
        import warnings

        from ._scene_api import _encode_image_binary

        # Skip if format isn't changing.
        if self._user_format == value:
            return

        self._user_format = value

        # Re-encode image. if we have one.
        if self._image is not None:
            if value == "jpeg" and self._image.shape[2] == 4:
                warnings.warn(
                    "Converting RGBA image to JPEG will discard the alpha channel."
                )
            resolved_format, data = _encode_image_binary(
                self._image, value, jpeg_quality=self._jpeg_quality
            )
            self._format = resolved_format
            self._image_data = data

    def compute_canonical_frustum_size(self) -> tuple[float, float, float]:
        """Compute the X, Y, and Z dimensions of the frustum if it had
        `.scale=1.0`. These dimensions will change whenever `.fov` or `.aspect`
        are changed.

        To set the distance between a frustum's origin and image plane to 1, we
        can run:

        .. code-block:: python

            frustum.scale = 1.0 / frustum.compute_canonical_frustum_size()[2]


        `.scale` can be a float for uniform scaling or a 3-tuple for per-axis
        scaling of the X, Y, and Z dimensions. It aims to preserve the visual
        volume of the frustum regardless of the aspect ratio or FOV. This
        method allows more precise computation and control of the frustum's
        dimensions.
        """
        # Math used in the client implementation.
        y = np.tan(self.fov / 2.0)
        x = y * self.aspect
        z = 1.0
        volume_scale = np.cbrt((x * y * z) / 3.0)

        z /= volume_scale

        # x and y need to be doubled, since on the client they correspond to
        # NDC-style spans [-1, 1].
        return x * 2.0, y * 2.0, z


class DirectionalLightHandle(
    SceneNodeHandle,
    _messages.DirectionalLightProps,
):
    """Handle for directional lights."""


class AmbientLightHandle(
    SceneNodeHandle,
    _messages.AmbientLightProps,
):
    """Handle for ambient lights."""


class HemisphereLightHandle(
    SceneNodeHandle,
    _messages.HemisphereLightProps,
):
    """Handle for hemisphere lights."""


class PointLightHandle(
    SceneNodeHandle,
    _messages.PointLightProps,
):
    """Handle for point lights."""


class RectAreaLightHandle(
    SceneNodeHandle,
    _messages.RectAreaLightProps,
):
    """Handle for rectangular area lights."""


class SpotLightHandle(
    SceneNodeHandle,
    _messages.SpotLightProps,
):
    """Handle for spot lights."""


class PointCloudHandle(
    SceneNodeHandle,
    _messages.PointCloudProps,
):
    """Handle for point clouds. Does not support click events."""

    @override
    def _on_prop_assigned(self, name: str) -> None:
        # `points` is stored at the dtype named by `precision`, so re-cast the
        # buffer in place whenever `precision` changes. This both keeps the
        # cloud consistent and means a subsequent `points` assignment won't be
        # pinned back to the old dtype by the generic setter -- so `precision`
        # and `points` can be assigned in either order.
        if name != "precision":
            return
        dtype = {"float16": np.float16, "float32": np.float32}[
            self._impl.props.precision
        ]
        points = self._impl.props.points
        if points.dtype != dtype:
            new_points = points.astype(dtype)
            self._impl.props.points = new_points
            # Queue a private snapshot, not the stored array (a later same-shape
            # `points` update mutates the stored buffer in place, which could
            # corrupt this still-unsent message). Mirrors props_setattr.
            self._queue_update("points", new_points.copy())


class BatchedAxesHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.BatchedAxesProps,
):
    """Handle for batched coordinate frames."""


class FrameHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.FrameProps,
):
    """Handle for coordinate frames."""


class MeshHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.MeshProps,
):
    """Handle for mesh objects."""


class BoxHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.BoxProps,
):
    """Handle for box objects."""


class IcosphereHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.IcosphereProps,
):
    """Handle for icosphere objects."""


class CylinderHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.CylinderProps,
):
    """Handle for cylinder objects."""


class BatchedMeshHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.BatchedMeshesProps,
):
    """Handle for batched mesh objects."""


class BatchedGlbHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.BatchedGlbProps,
):
    """Handle for batched GLB objects."""


class GaussianSplatHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.GaussianSplatsProps,
):
    """Handle for Gaussian splatting objects.

    **Work-in-progress.** Gaussian rendering is still under development.

    Buffer layout per Gaussian (8 uint32 elements = 32 bytes):
        - [0:3]: centers (3x float32)
        - [3]: reserved for renderer
        - [4:7]: covariance upper-triangular (6x float16)
        - [7]: RGBA (4x uint8)
    """

    def _ensure_buffer_size(self, num_gaussians: int) -> None:
        """Ensure the internal buffer can hold the specified number of Gaussians.

        If the buffer is already the correct size, this is a no-op. Otherwise,
        a new buffer is allocated with default values (white color, full opacity,
        small identity-like covariances, centers at origin).
        """
        if self.buffer.shape[0] == num_gaussians:
            return

        # Create new buffer with default values.
        new_buffer = np.zeros((num_gaussians, 8), dtype=np.uint32)

        # Set default RGBA to white, fully opaque (255, 255, 255, 255).
        new_buffer[:, 7] = 0xFFFFFFFF

        # Set default covariances to small identity-like values.
        # Store as 6 float16 values: [cov00, cov01, cov02, cov11, cov12, cov22].
        default_cov = np.array([0.01, 0.0, 0.0, 0.01, 0.0, 0.01], dtype=np.float16)
        new_buffer[:, 4:7] = np.tile(default_cov.view(np.uint32), (num_gaussians, 1))

        self.buffer = new_buffer

    @property
    def centers(self) -> npt.NDArray[np.float32]:
        """Centers of the Gaussians. Shape: (N, 3). Synchronized automatically when assigned."""
        return self.buffer[:, 0:3].view(np.float32)

    @centers.setter
    def centers(self, centers: np.ndarray) -> None:
        assert centers.ndim == 2 and centers.shape[1] == 3, (
            f"centers must have shape (N, 3), got {centers.shape}"
        )
        self._ensure_buffer_size(centers.shape[0])
        self.buffer[:, 0:3] = centers.astype(np.float32).view(np.uint32)
        # Queue a private snapshot: the stored buffer is mutated in place by
        # later sub-property assignments, possibly while the event loop is still
        # serializing this message. Matches the guard in props_setattr.
        self._queue_update("buffer", self.buffer.copy())

    @property
    def rgbs(self) -> npt.NDArray[np.uint8]:
        """Colors of the Gaussians. Shape: (N, 3). Values in [0, 1]. Synchronized automatically when assigned."""
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        return rgba[:, :3]

    @rgbs.setter
    def rgbs(self, rgbs: np.ndarray) -> None:
        from ._assignable_props_api import colors_to_uint8

        assert rgbs.ndim == 2 and rgbs.shape[1] == 3, (
            f"rgbs must have shape (N, 3), got {rgbs.shape}"
        )
        self._ensure_buffer_size(rgbs.shape[0])
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        rgba[:, :3] = colors_to_uint8(rgbs)
        self.buffer[:, 7:8] = rgba.view(np.uint32)
        self._queue_update("buffer", self.buffer.copy())

    @property
    def opacities(self) -> npt.NDArray[np.uint8]:
        """Opacities of the Gaussians. Shape: (N, 1). Values in [0, 1]. Synchronized automatically when assigned."""
        buffer = self.buffer
        rgba = buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        return rgba[:, 3:4]

    @opacities.setter
    def opacities(self, opacities: np.ndarray) -> None:
        from ._assignable_props_api import colors_to_uint8

        assert opacities.ndim == 2 and opacities.shape[1] == 1, (
            f"opacities must have shape (N, 1), got {opacities.shape}"
        )
        self._ensure_buffer_size(opacities.shape[0])
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        rgba[:, 3:4] = colors_to_uint8(opacities)
        self.buffer[:, 7:8] = rgba.view(np.uint32)
        self._queue_update("buffer", self.buffer.copy())

    @property
    def covariances(self) -> npt.NDArray[np.float32]:
        """Covariances of the Gaussians. Shape: (N, 3, 3). Synchronized automatically when assigned."""
        # Extract upper-triangular terms stored as 6 float16 values.
        cov_triu_f16 = self.buffer[:, 4:7].view(np.float16).reshape(-1, 6)
        cov_triu = cov_triu_f16.astype(np.float32)
        # Reconstruct symmetric 3x3 matrix.
        n = cov_triu.shape[0]
        cov = np.zeros((n, 3, 3), dtype=np.float32)
        cov[:, 0, 0] = cov_triu[:, 0]
        cov[:, 0, 1] = cov_triu[:, 1]
        cov[:, 0, 2] = cov_triu[:, 2]
        cov[:, 1, 0] = cov_triu[:, 1]  # Symmetric.
        cov[:, 1, 1] = cov_triu[:, 3]
        cov[:, 1, 2] = cov_triu[:, 4]
        cov[:, 2, 0] = cov_triu[:, 2]  # Symmetric.
        cov[:, 2, 1] = cov_triu[:, 4]  # Symmetric.
        cov[:, 2, 2] = cov_triu[:, 5]
        return cov

    @covariances.setter
    def covariances(self, covariances: np.ndarray) -> None:
        assert covariances.ndim == 3 and covariances.shape[1:] == (3, 3), (
            f"covariances must have shape (N, 3, 3), got {covariances.shape}"
        )
        self._ensure_buffer_size(covariances.shape[0])
        # Extract upper-triangular terms: indices [0,1,2,4,5,8] from flattened 3x3.
        cov_triu = covariances.reshape((-1, 9))[:, np.array([0, 1, 2, 4, 5, 8])]
        cov_triu_f16 = cov_triu.astype(np.float16)
        self.buffer[:, 4:7] = np.ascontiguousarray(cov_triu_f16).view(np.uint32)
        self._queue_update("buffer", self.buffer.copy())


class MeshSkinnedHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.SkinnedMeshProps,
):
    """Handle for skinned mesh objects."""

    def __init__(
        self, impl: _SceneNodeHandleState, bones: tuple[MeshSkinnedBoneHandle, ...]
    ):
        super().__init__(impl)
        self.bones = bones


@dataclasses.dataclass
class BoneState:
    name: str
    websock_interface: WebsockServer | WebsockClientConnection
    bone_index: int
    wxyz: np.ndarray
    position: np.ndarray


@dataclasses.dataclass
class MeshSkinnedBoneHandle:
    """Handle for reading and writing the poses of bones in a skinned mesh."""

    _impl: BoneState

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the bone. This is the quaternion representation of the R
        in `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.wxyz

    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        # wxyz is assumed to be a unit quaternion (see SceneNodeHandle.wxyz).
        _set_pose_vector(
            self._impl.wxyz,
            wxyz,
            4,
            self._impl.websock_interface,
            lambda v: _messages.SetBoneOrientationMessage(
                self._impl.name, self._impl.bone_index, v
            ),
        )

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the bone. This is equivalent to the t in
        `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        _set_pose_vector(
            self._impl.position,
            position,
            3,
            self._impl.websock_interface,
            lambda v: _messages.SetBonePositionMessage(
                self._impl.name, self._impl.bone_index, v
            ),
        )


class GridHandle(
    SceneNodeHandle,
    _messages.GridProps,
):
    """Handle for grid objects."""


class LineSegmentsHandle(
    SceneNodeHandle,
    _messages.LineSegmentsProps,
):
    """Handle for line segments objects."""


class ArrowsHandle(
    SceneNodeHandle,
    _messages.ArrowProps,
):
    """Handle for arrow objects."""


class SplineCatmullRomHandle(
    SceneNodeHandle,
    _messages.CatmullRomSplineProps,
):
    """Handle for Catmull-Rom splines."""

    @property
    @deprecated("The 'positions' property is deprecated. Use 'points' instead.")
    def positions(self) -> tuple[tuple[float, float, float], ...]:
        """Get the spline positions. Deprecated: use 'points' instead.

        .. deprecated:: 1.0.0
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
        """
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return tuple(tuple(x) for x in self.points.tolist())  # type: ignore

    @positions.setter
    @deprecated("The 'positions' property is deprecated. Use 'points' instead.")
    def positions(self, positions: tuple[tuple[float, float, float], ...]) -> None:
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.points = np.asarray(positions)


class SplineCubicBezierHandle(
    SceneNodeHandle,
    _messages.CubicBezierSplineProps,
):
    """Handle for cubic Bezier splines."""

    @property
    @deprecated(
        "The 'positions' tuple property is deprecated. Use 'points' numpy array instead."
    )
    def positions(self) -> tuple[tuple[float, float, float], ...]:
        """Get the spline positions. Deprecated: use 'points' instead.

        .. deprecated:: 1.0.0
            The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.
        """
        return tuple(tuple(p) for p in self.points.tolist())  # type: ignore

    @positions.setter
    @deprecated(
        "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead."
    )
    def positions(self, positions: tuple[tuple[float, float, float], ...]) -> None:
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.points = np.asarray(positions)


class GlbHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.GlbProps,
):
    """Handle for GLB objects."""


class ImageHandle(
    _RaycastSupportedSceneNodeHandle,
    _messages.ImageProps,
):
    """Handle for 2D images, rendered in 3D."""

    _image: np.ndarray
    _jpeg_quality: int | None
    _user_format: Literal["auto", "jpeg", "png"]

    @property
    def image(self) -> np.ndarray:
        """Current content of the image. Synchronized automatically when assigned."""
        assert self._image is not None
        return self._image

    @image.setter
    def image(self, image: np.ndarray) -> None:
        from ._scene_api import _encode_image_binary

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

        from ._scene_api import _encode_image_binary

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


class LabelHandle(
    SceneNodeHandle,
    _messages.LabelProps,
):
    """Handle for 2D label objects. Does not support click events."""


@dataclasses.dataclass
class _TransformControlsState:
    last_updated: float
    update_cb: list[Callable[[TransformControlsEvent], None | Coroutine]]
    sync_cb: None | Callable[[ClientId, TransformControlsHandle], None] = None


def _phase_filtered_wrapper(
    phase: DragPhase,
    func: Callable[[TransformControlsEvent], NoneOrCoroutine],
) -> Callable[[TransformControlsEvent], None | Coroutine]:
    """Build an ``update_cb`` entry for the deprecated
    ``on_drag_start`` / ``on_drag_end`` methods. Tagged so
    ``remove_*`` can locate it by the original ``func`` identity."""

    if asyncio.iscoroutinefunction(func):

        async def async_wrapper(event: TransformControlsEvent) -> None:
            if event.phase == phase:
                await func(event)  # type: ignore[misc]

        async_wrapper._wraps = func  # type: ignore[attr-defined]
        async_wrapper._phase_filter = phase  # type: ignore[attr-defined]
        return async_wrapper

    def sync_wrapper(event: TransformControlsEvent) -> None:
        if event.phase == phase:
            func(event)

    sync_wrapper._wraps = func  # type: ignore[attr-defined]
    sync_wrapper._phase_filter = phase  # type: ignore[attr-defined]
    return sync_wrapper


class TransformControlsHandle(
    SceneNodeHandle,
    _messages.TransformControlsProps,
):
    """Handle for interacting with transform control gizmos."""

    def __init__(self, impl: _SceneNodeHandleState, impl_aux: _TransformControlsState):
        super().__init__(impl)
        self._impl_aux = impl_aux

    @override
    def _on_remove(self) -> None:
        # Drop the name-keyed gizmo registry entry.
        self._impl.api._handle_from_transform_controls_name.pop(self._impl.name, None)

    @property
    def update_timestamp(self) -> float:
        return self._impl_aux.last_updated

    def on_update(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Attach a callback for the full gizmo drag lifecycle.

        Fires three times per gesture: once with
        ``event.phase == "start"`` when the user grabs a handle, on
        every pose change with ``"update"``, and once with ``"end"`` at
        release. ``target.wxyz`` and ``target.position`` reflect the
        current pose on every phase.

        Callbacks may be ``def`` (run in a threadpool) or ``async def``
        (awaited on the event loop). Async preserves phase order so
        long as you don't ``await`` inside; threadpool callbacks may
        run out of order.
        """
        self._impl_aux.update_cb.append(func)
        return func

    def remove_update_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove update callbacks from the transform controls.

        ``callback="all"`` removes every callback regardless of which
        method registered it; a specific function removes entries
        whose identity matches (including wrappers installed by the
        deprecated :meth:`on_drag_start` / :meth:`on_drag_end`).
        """
        if callback == "all":
            self._impl_aux.update_cb.clear()
        else:
            self._impl_aux.update_cb = [
                cb
                for cb in self._impl_aux.update_cb
                if cb != callback and getattr(cb, "_wraps", None) is not callback
            ]

    @deprecated("Use `on_update` and check `event.phase == 'start'`.")
    def on_drag_start(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Deprecated. Use :meth:`on_update` and gate on
        ``event.phase == "start"`` inside the handler."""
        self._impl_aux.update_cb.append(_phase_filtered_wrapper("start", func))
        return func

    @deprecated("Use `on_update` and check `event.phase == 'end'`.")
    def on_drag_end(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Deprecated. Use :meth:`on_update` and gate on
        ``event.phase == "end"`` inside the handler."""
        self._impl_aux.update_cb.append(_phase_filtered_wrapper("end", func))
        return func

    @deprecated("Use `remove_update_callback`.")
    def remove_drag_start_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Deprecated. Use :meth:`remove_update_callback`."""
        self._remove_phase_wrappers("start", callback)

    @deprecated("Use `remove_update_callback`.")
    def remove_drag_end_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Deprecated. Use :meth:`remove_update_callback`."""
        self._remove_phase_wrappers("end", callback)

    def _remove_phase_wrappers(
        self, phase: DragPhase, callback: Literal["all"] | Callable
    ) -> None:
        def keep(cb: Callable[..., Any]) -> bool:
            tag = getattr(cb, "_phase_filter", None)
            if tag != phase:
                return True  # Not one of ours.
            if callback == "all":
                return False
            return getattr(cb, "_wraps", None) is not callback

        self._impl_aux.update_cb = [cb for cb in self._impl_aux.update_cb if keep(cb)]


class Gui3dContainerHandle(
    SceneNodeHandle,
    _messages.Gui3DProps,
):
    """Use as a context to place GUI elements into a 3D GUI container."""

    def __init__(self, impl: _SceneNodeHandleState, gui_api: GuiApi, container_id: str):
        super().__init__(impl)
        self._gui_api = gui_api
        self._container_id = container_id
        self._container_id_restore = None
        self._children = {}
        self._gui_api._container_handle_from_uuid[self._container_id] = self

    def __enter__(self) -> Gui3dContainerHandle:
        self._container_id_restore = self._gui_api._get_container_uuid()
        self._gui_api._set_container_uuid(self._container_id)
        return self

    def __exit__(self, *args) -> None:
        del args
        assert self._container_id_restore is not None
        self._gui_api._set_container_uuid(self._container_id_restore)
        self._container_id_restore = None

    @override
    def _on_remove(self) -> None:
        # Remove contained GUI elements, then drop the UUID-keyed container entry.
        for child in tuple(self._children.values()):
            child.remove()
        self._gui_api._container_handle_from_uuid.pop(self._container_id, None)
