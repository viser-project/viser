"""Server-wide index of claimed scene-node names across scopes.

Scene elements can be created through two kinds of scope: the server's
broadcast scope (``server.scene``, visible to every client) and per-client
scopes (``client.scene``, visible to one client). The frontend merges both
into a single scene tree keyed by node name, so names from scopes that are
visible to the same viewer share one namespace -- but each scope keeps its
own Python-side registry. This index is the one structure that sees every
scope's claims, and it enforces two rules at add time:

1. **No overlapping-scope name reuse.** A name may not be claimed by two
   scopes that any single viewer can see simultaneously: the broadcast scope
   overlaps every client scope, while two different client scopes never
   overlap (their elements never meet on one frontend). Re-adding a name
   within one scope stays legal -- that is the documented supersede path.

2. **A child's audience must be a subset of its parent's.** A per-client
   child under a broadcast parent is fine; a broadcast child under a
   per-client parent (or a child under another client's parent) would dangle
   for every viewer that cannot see the parent, and is rejected. The rule is
   only enforced when the parent name is claimed somewhere -- viser allows
   adding nodes under not-yet-created parents, and those stay unchecked
   until the parent is claimed.

Thread safety: the index has no lock of its own. Every mutation and query
happens under the server-wide scene lifecycle lock (a reentrant lock shared
by ``server.scene`` and every ``client.scene`` -- see
``SceneApi._node_lifecycle_lock``), which also serializes the registry
operations the index mirrors.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ._scene_api import SceneApi
    from .infra import ClientId

ScopeKey = Optional["ClientId"]
"""Identifies a scope: ``None`` for the broadcast scope, a client id for a
per-client scope."""


def _scopes_overlap(a: ScopeKey, b: ScopeKey) -> bool:
    """Whether any single viewer can see both scopes at once."""
    if a is None or b is None:
        return True
    return a == b


def _scope_covers(parent: ScopeKey, child: ScopeKey) -> bool:
    """Whether ``parent``'s audience is a superset of ``child``'s."""
    return parent is None or parent == child


def _describe_scope(scope: ScopeKey) -> str:
    return "the server (broadcast) scope" if scope is None else f"client {scope}"


class SceneNameIndex:
    """Maps each claimed scene-node name to the scopes that claim it.

    Values are the owning ``SceneApi`` instances rather than handles: the
    per-scope registries stay the source of truth for the current (possibly
    subclass-typed, possibly superseded) handle, and cross-scope operations
    resolve through them at use time.
    """

    def __init__(self) -> None:
        self._scopes_from_name: dict[str, dict[ScopeKey, SceneApi]] = {}

    def check_claimable(self, name: str, scope: ScopeKey) -> None:
        """Raise ``ValueError`` if claiming ``name`` from ``scope`` would
        violate the overlap or audience-subset rule. Called before any side
        effect of an add, so a rejected add leaves no trace."""
        claimants = self._scopes_from_name.get(name)
        if claimants:
            for other in claimants:
                if other != scope and _scopes_overlap(other, scope):
                    raise ValueError(
                        f"Cannot add scene node {name!r} from "
                        f"{_describe_scope(scope)}: the name is already used "
                        f"by {_describe_scope(other)}, and the two are "
                        f"visible to the same client. Both scopes share one "
                        f"scene tree on the frontend, so this would silently "
                        f"corrupt the existing node's state. Remove the "
                        f"existing node first, or use a different name. "
                        f"(Re-adding a name from the SAME scope is supported "
                        f"and replaces the node.)"
                    )

        parent = name.rsplit("/", 1)[0]
        if parent:
            parent_claimants = self._scopes_from_name.get(parent)
            if parent_claimants and not any(
                _scope_covers(parent_scope, scope) for parent_scope in parent_claimants
            ):
                parent_scope = next(iter(parent_claimants))
                raise ValueError(
                    f"Cannot add scene node {name!r} from "
                    f"{_describe_scope(scope)}: its parent {parent!r} belongs "
                    f"to {_describe_scope(parent_scope)}, whose audience does "
                    f"not include every viewer of the new node. A child must "
                    f"be visible to a subset of its parent's viewers -- "
                    f"otherwise it would dangle in the scene tree for viewers "
                    f"who cannot see the parent."
                )

    def commit(self, name: str, scope: ScopeKey, api: SceneApi) -> None:
        """Record ``name`` as claimed by ``scope``. Idempotent for same-scope
        re-adds (supersede)."""
        self._scopes_from_name.setdefault(name, {})[scope] = api

    def release(self, name: str, scope: ScopeKey) -> None:
        """Drop ``scope``'s claim on ``name``, if any."""
        claimants = self._scopes_from_name.get(name)
        if claimants is None:
            return
        claimants.pop(scope, None)
        if not claimants:
            del self._scopes_from_name[name]

    def drop_scope(self, scope: ScopeKey) -> None:
        """Drop every claim held by ``scope`` (client disconnect)."""
        for name in list(self._scopes_from_name):
            self.release(name, scope)

    def exists_visible(self, name: str, scope: ScopeKey) -> bool:
        """Whether ``name`` is claimed by a scope whose elements every viewer
        of ``scope`` can see -- i.e. whether an add from ``scope`` may treat
        the node as an existing ancestor rather than creating it."""
        claimants = self._scopes_from_name.get(name)
        if not claimants:
            return False
        return any(_scope_covers(other, scope) for other in claimants)

    def foreign_descendants(
        self, name: str, scope: ScopeKey
    ) -> list[tuple[SceneApi, str]]:
        """Snapshot of (owning api, name) for every node claimed by a scope
        other than ``scope`` whose name sits strictly under ``name``. Used by
        broadcast removals to cascade into per-client subtrees the way the
        frontend's name-keyed tree already does."""
        prefix = name + "/"
        out: list[tuple[SceneApi, str]] = []
        for other_name, claimants in self._scopes_from_name.items():
            if not other_name.startswith(prefix):
                continue
            for other_scope, api in claimants.items():
                if other_scope != scope:
                    out.append((api, other_name))
        return out
