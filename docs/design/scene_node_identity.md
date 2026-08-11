# Scene node identity: per-name variant slots with client-wins display

Status: **implemented** (same branch, after an interim rejection-based
design; the "where we are" section below describes the state this replaced).
Code map: owner/virtual fields in `_messages.py`; owner stamping via
`SceneApi._queue_scene_message` and virtual anchors via
`_ensure_ancestors_exist` in `_scene_api.py` / `_scene_handles.py`; variant
slots, display rule, and frozen-pose inheritance in the frontend's
`SceneTreeState.ts` with owner routing in `MessageHandler.tsx`. Tests:
`tests/test_scene_scopes.py`, `SceneTreeState.test.ts`,
`tests/e2e/test_cross_scope_handles.py`. Not yet implemented: a scene-tree
panel badge for shadowing/local variants (cosmetic follow-up).

## Where this started

Scene nodes were identified by name alone, everywhere: the frontend scene
tree was a single store keyed by node name with no record of which scope
created an entry, and every name-keyed message (updates, removes, clicks,
drags) resolved against that one namespace. Because `server.scene`
(broadcast) and each `client.scene` (per-client) both feed the same tree, a
name claimed by two scopes visible to the same viewer silently corrupted
state.

An interim fix (a `SceneNameIndex`, since removed) kept name-only identity
and **rejected** overlapping-scope claims at the add site (`ValueError`),
with an audience-subset rule for cross-scope parenting and cross-scope
cascade on broadcast removals. That was sound, but it made the collision
class *forbidden* rather than *unrepresentable*, and it forced server and
client code to coordinate names.

## The model

Each scene-tree **name** becomes a slot holding up to two **variants**: a
broadcast variant and a client variant. Both variants keep independent state
(props, pose, visibility, interaction bindings), fed independently by their
scopes' messages. Exactly one variant is **effective** (rendered,
interactive) per name, chosen by a local display rule:

> Pick the variant maximizing ``(is_real, is_client)``:
> real client > real broadcast > virtual client > virtual broadcast.

"Virtual" marks auto-created intermediate ancestors (see below). The rule
gives client-over-server supersede semantics -- a client-scoped add of a name
the server owns *shadows* the broadcast node for that one viewer -- without
any of the machinery that made shadowing expensive under name-only identity:

- **No per-client filtering of broadcast sends.** Updates to a shadowed
  broadcast node land in the broadcast variant's state; they're simply not
  displayed while shadowed. Nothing clobbers the client variant.
- **No resurrection machinery.** Removing the client variant un-hides the
  broadcast variant, which has been accumulating state all along -- the
  display rule is recomputed locally from data already in the store.
- **Deterministic removal in both directions.** Server removes its `/x`:
  the broadcast variant leaves the slot; a client variant is unaffected.
  Client removes its `/x`: the broadcast variant (if any) shows again.
- **Late joiners are trivially correct**: broadcast replay populates only
  broadcast variants.

**Hierarchy stays name-based.** One tree edge structure per name; children
attach to their parent *name*, not to a specific variant, and pose composes
through whichever variant is effective. This is what keeps the frontend
change small: no per-variant tree, no parent-edge resolution rules.

### Virtual intermediates

Ancestor auto-creation (`_ensure_ancestors_exist`) becomes **unconditional
per scope**: every add creates anchors for all missing *same-scope*
ancestors, even when another scope's variant of that name exists. These
anchors are flagged **virtual** -- a field on the create message -- and:

- Virtual variants yield to real ones in the display rule, so a client
  auto-ancestor for `/a` never shadows the server's real `/a` (its axes, its
  pose visuals). A later explicit add of the same name from the same scope
  supersedes the virtual variant with a real one (ordinary within-scope
  supersede).
- Virtual variants render nothing and are never interactive; while a real
  variant of the name exists, the anchor is pure lifecycle bookkeeping.

Unconditional anchors give every node a complete same-scope ancestor chain,
which is what makes scope-local cascade (below) orphan-free: the two scopes
are two complete overlaid trees, merged per name by the display rule. The
cost is a handful of tiny anchor messages per deep add.

Virtual intermediates also dissolve the audience-subset rule: a broadcast add
of `/a/b` where `/a` exists only in some client's scope auto-creates a
*virtual broadcast* `/a`. Other clients see the child under an invisible
anchor; the owning client's real `/a` shadows the anchor. No error needed in
either direction, so **both `ValueError`s from the name index are relaxed**
(non-breaking: code that raised starts working, with defined semantics).

## Wire protocol

`owner` is an **opaque string** stamped on scene-node messages, not a
boolean: today it takes two values ("broadcast" and a per-connection
identifier), but under the audience-set endgame (elements carry an audience;
`client.scene.add_*` becomes sugar) a client may see nodes from several
owners, and an opaque id avoids a second identity migration.

**Per-message owner field, not per-batch origin tagging.** Batch tagging
(each of the two producer tasks stamping the windows it drains) is cheaper
today, but it identifies owners with *buffers* -- and the endgame is a single
persistent buffer whose per-client window generator filters messages by
audience (precedent: `excluded_self_client` is already filtered per-client in
`AsyncMessageBuffer.window_generator`). In that world one batch carries mixed
owners. Pay the schema sweep once:

- Server→client: scene-node messages (`_CreateSceneNodeMessage` subclasses,
  `SceneNodeUpdateMessage`, `Set{Orientation,Position,...}`,
  `SetSceneNodeVisibilityMessage`, `RemoveSceneNodeMessage`, binding
  messages) gain `owner: str`, stamped by the queueing `SceneApi`. Create
  messages additionally gain the `virtual` flag. Changes go through
  `_messages.py` + `sync_client_server.py --sync-messages`.
- Client→server: interaction messages (`SceneNodeClickMessage`,
  `SceneNodeDragMessage`, transform-controls updates and drag start/end)
  echo the effective variant's owner, so dispatch resolves to exactly one
  scope's registry. Only the effective variant is interactive; a shadowed
  broadcast node's bindings lie dormant until it is unshadowed.
- Entity identity for redundancy keys and GC becomes (owner, name) -- a
  no-op while buffers are split per owner, load-bearing once merged.

## Frontend

- Store: per-name slot with `broadcast?` / `client?` variant entries; pose
  data and bindings move into the variant. Effective-variant selection is
  one pure function; only the effective variant is mounted (a shadow toggle
  remounts, which is acceptable churn -- same cost as today's same-name
  re-add).
- `nodeRefFromName` stays name-keyed (only the effective variant mounts).
- Scene-tree panel: one row per name (the effective variant), with a badge
  for local/shadowing variants.
- `.viser` serialization: unchanged (recordings already filter to the
  broadcast scope, which is collision-free on its own).

## Python side

- The `SceneNameIndex` keeps its bookkeeping roles (ancestor-existence
  checks, disconnect cleanup) and loses both claim-time rejections -- and,
  with scope-local cascade, its cross-scope cascade lookup.
- **Cascade is scope-local**: a server remove cascades through broadcast
  descendants only; a client remove cascades through that client's
  descendants only. Neither scope can destroy the other's state -- both
  scopes are driven by the same Python program, so when coupled teardown is
  wanted (a per-client annotation that should die with the mesh it
  annotates), the author removes it explicitly rather than the design doing
  it behind their back. Unconditional same-scope virtual anchors (above)
  guarantee no orphans: the surviving scope's subtree keeps a complete
  ancestor chain. This also deletes the cross-scope handle-invalidation
  machinery from the current branch -- the zombie problem is solved from
  the other side, by keeping the frontend node alive so handle and frontend
  agree by construction.
- **Frozen-pose inheritance**: children compose pose through the parent
  name's *effective* variant; virtual anchors contribute nothing while a
  real variant exists. When the effective variant is removed and a virtual
  anchor becomes effective, the anchor inherits the departing variant's
  last pose (a frontend-local copy) -- surviving children stay where they
  were instead of teleporting to identity. Accepted caveat: a client child
  can outlive the broadcast object it annotated, frozen in place, until its
  author removes it.
- `client.scene.add_frame("/WorldAxes")` becomes the sanctioned per-client
  world-axes override (shadowing the server's node), replacing the removed
  `client.scene.world_axes` handle.

## Migration and sequencing

1. (Done, current branch) Name-only identity + `SceneNameIndex` rejection.
   Errors are forward-compatible: relaxing them later breaks nobody.
2. Merged single producer per connection (planned): one ordered stream,
   cross-scope `atomic()`. Independent of this design but shares the
   filtered-window machinery.
3. This design: owner + virtual fields, variant slots + display rule on the
   frontend, both `ValueError`s relaxed, cascade rewired to scope-local
   semantics (the interim cross-scope cascade + handle invalidation from
   step 1 is deleted; handles that used to be invalidated stay valid, so the
   change is again a relaxation). The branch's rejection tests flip to
   coexistence/shadowing assertions. Client/server version gating already
   forces matched deploys; no wire compatibility shims needed.
4. Audience sets: `audience=` on add, per-client filtering in the window
   generator, audience mutation on live elements. Owner ids from step 3 are
   the identity substrate; the display rule generalizes by ranking owner
   specificity (more-specific audience wins).
