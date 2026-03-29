# Viser: Project Overview

## Purpose

Viser is a Python library for building interactive 3D web visualizers. It provides
a Python API for creating and manipulating 3D scene objects (meshes, point clouds,
lights, cameras, etc.) and 2D GUI controls (sliders, buttons, dropdowns, etc.),
which are rendered in real-time in a web browser using React Three Fiber. The
server and client communicate over WebSocket using a binary message protocol.

## Architecture

### High-Level Data Flow

```
Python Server                 WebSocket (binary)              Browser Client
─────────────                 ──────────────────              ──────────────
SceneApi / GuiApi  ──►  Message serialization  ──►  Web Worker  ──►  Message Queue
(user code)              (msgpack + zstd)           (decode)         │
                                                                    ▼
                                                              useFrame handler
                                                              (FrameSynchronizedMessageHandler)
                                                                    │
                                                    ┌───────────────┼──────────────┐
                                                    ▼               ▼              ▼
                                              Zustand Store     Imperative     Camera /
                                              (scene nodes,     Updates        Environment
                                               GUI state)       (mutable ref)  State
                                                    │
                                                    ▼
                                              React Three Fiber
                                              (declarative rendering)
                                                    │
                                                    ▼
                                              Three.js Scene Graph
```

### Server Side (Python)

**Key files:**
- `src/viser/_viser.py` — `ViserServer` class, client connection management
- `src/viser/_scene_api.py` — `SceneApi` for creating/manipulating 3D scene objects
- `src/viser/_gui_api.py` — `GuiApi` for creating GUI controls
- `src/viser/_scene_handles.py` — Handle classes for scene nodes (one per type)
- `src/viser/_messages.py` — All message dataclasses (~1900 lines, auto-generates TS)
- `src/viser/_assignable_props_api.py` — `AssignablePropsBase` with `__setattr__` monkey-patch
- `src/viser/infra/_infra.py` — WebSocket server, message batching, wire protocol
- `src/viser/infra/_messages.py` — Base `Message` class, serialization/deserialization
- `src/viser/infra/_async_message_buffer.py` — Dedup + windowed message batching

**Property system:** Each scene node type has a `*Props` dataclass (e.g.,
`BatchedMeshesProps`) and a handle class that inherits from both
`SceneNodeHandle` and the Props class. When a user assigns
`handle.batched_wxyzs = new_array`, the monkey-patched `__setattr__` in
`AssignablePropsBase`:
1. Casts the value to the correct dtype
2. Checks if the value actually changed (`np.array_equal` for arrays)
3. Updates the local copy
4. Sends a `SceneNodeUpdateMessage(name, {prop_name: value})`

Special properties `wxyz`, `position`, and `visible` bypass this system with
dedicated messages (`SetOrientationMessage`, `SetPositionMessage`,
`SetSceneNodeVisibilityMessage`).

**Wire protocol (API v1):** Messages are batched into windows (~60 fps, up to
128 messages per window). Each window is:
```
[8B decompressed size][8B compressed size][zstd-compressed msgpack][padding][raw binary buffers]
```
Numpy arrays are extracted from the msgpack and appended as raw bytes (zero-copy
on the client side). Redundancy-based dedup removes stale messages (e.g., if a
node's position is updated twice before a window is sent, only the latest is
kept).

### Client Side (TypeScript / React)

**Technology stack:** React 19, Three.js, React Three Fiber, Zustand (state
management), Mantine (UI components), Vite (build), vanilla-extract (CSS).

**Key files:**
- `src/viser/client/src/App.tsx` — Root component, canvas setup, layout
- `src/viser/client/src/WebsocketInterface.tsx` — WebSocket connection, message routing
- `src/viser/client/src/WebsocketClientWorker.ts` — Web Worker for WS + decoding
- `src/viser/client/src/BinaryMessageDecode.ts` — Zero-copy binary buffer reconstruction
- `src/viser/client/src/MessageHandler.tsx` — Frame-synchronized message processing
- `src/viser/client/src/SceneTreeState.ts` — Zustand store for the scene graph (flat map)
- `src/viser/client/src/SceneTree.tsx` — Scene node rendering, click/hover handling
- `src/viser/client/src/ViewerContext.ts` — Per-viewer-instance context and mutable state

**State management:**
- `useSceneTree` — Zustand store: flat `{ [name: string]: SceneNode }` map. Each
  `SceneNode` has `message` (the creation message + props), `children`, `clickable`,
  `wxyz`, `position`, `visibility`, `effectiveVisibility`, etc.
- `useGui` — Zustand store (with immer) for GUI component state
- `useEnvironment` — Zustand store for lights, fog, environment map
- `ViewerMutable` — Plain ref object for hot-path state (sendMessage, camera refs,
  messageQueue, skinnedMeshState, hoveredElementsCount). Mutations here do NOT
  trigger React re-renders.

**Rendering architecture:**
- `SceneNodeThreeObject` — One per scene node. Recursive via `SceneNodeChildren`.
  Uses `createObjectFactory()` (switch on message type) to create the appropriate
  React Three Fiber component.
- Per-frame updates via `useFrame` hooks at different priorities:
  - `-100000`: Message processing (FrameSynchronizedMessageHandler)
  - `-1000`: Pose/visibility updates (SceneNodeThreeObject)
  - `-100`: Gaussian splat transforms
  - Default: Labels, bones, camera, etc.

**Mesh components:**
- `BasicMesh` — Standard mesh from vertices/faces, fully declarative
- `BoxMesh`, `IcosphereMesh`, `CylinderMesh` — Cached primitive geometries
- `SkinnedMesh` — Skeletal animation, bone updates via imperative useFrame
- `SingleGlbAsset` — GLB/glTF with animations
- `BatchedMeshBase` — Core instanced rendering using vendored `InstancedMesh2`
  (LOD, BVH, per-instance colors/opacity). Used by:
  - `BatchedMesh` — User-defined batched meshes (vertices + faces)
  - `BatchedGlbAsset` — Batched GLB models (merged geometries)

### Dual Update Paths

The client has two distinct paths for updating scene node properties:

1. **Imperative path** (fast, no re-renders): `wxyz`, `position`, `visible`, and
   bone poses are stored as top-level attributes on the `SceneNode` and applied
   directly to Three.js objects in `useFrame`. The zustand selector
   `state[name]?.message` does not change, so no component re-renders.

2. **Declarative path** (slower, triggers React): All other props (including
   `batched_wxyzs`, `batched_positions`, `batched_colors`, etc.) are stored
   inside `node.message.props`. Updating them creates a new `message` reference,
   which triggers re-renders of `SceneNodeThreeObject` → `createObjectFactory` →
   child component → `useEffect` chains.

## Build System

- **Python:** hatchling build backend, pyproject.toml, Python 3.8+
- **Client:** Vite 5.2, TypeScript 5.0, single-file HTML output for production
- **Type generation:** `_typescript_interface_gen.py` generates `WebsocketMessages.ts`
  from Python message dataclasses
- **Sync:** `sync_client_server.py` keeps client/server in sync

## Testing

- **Unit tests:** `tests/` — transforms, scene tree, garbage collection, etc.
- **E2E tests:** `tests/e2e/` — Playwright-based browser tests with real server
- **Examples:** `examples/` — 35+ examples across 4 categories
