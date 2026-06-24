# Viser: Feature Inventory & Gap Analysis

*A survey of what Viser does today and what's missing, prioritized. Generated 2026-06-24 against `v1.0.30`.*

Viser is an imperative, web-based 3D visualization library for computer vision
and robotics in Python. A WebSocket server (Python) drives a React/Three.js
client (TypeScript). State can be **shared** across all clients
(`server.scene` / `server.gui`) or **per-client** (`client.scene` /
`client.gui`).

---

## Part 1 — Existing Features

### 1.1 Scene / 3D primitives

| Category | Capabilities |
|---|---|
| **Meshes** | `add_mesh_simple`, `add_mesh_trimesh`, `add_glb`, `add_mesh_skinned` (skeletal animation, ≤4 bone influences/vertex) |
| **Batched / instanced** | `add_batched_meshes_simple`, `add_batched_meshes_trimesh`, `add_batched_glb`, `add_batched_axes` — GPU instancing with per-instance pose/color/opacity/scale, optional **LOD** (auto/off/custom) |
| **Primitives** | `add_box`, `add_icosphere`, `add_cylinder` |
| **Point clouds** | `add_point_cloud` — point shapes (square/diamond/circle/rounded/sparkle), flat/gradient shading, float16/float32 precision |
| **Gaussian splats** | `add_gaussian_splats` — WebGL renderer with sorted compositing (experimental) |
| **Lines / curves** | `add_line_segments`, `add_arrows`, `add_spline_catmull_rom`, `add_spline_cubic_bezier` |
| **Frames / grids** | `add_frame`, `add_grid` (finite/infinite, fade, shadow), `add_label` |
| **Cameras** | `add_camera_frustum` (with optional image on near plane) |
| **Images** | `add_image` (3D billboard), `set_background_image` (with optional depth compositing) |
| **Lighting** | directional/ambient/hemisphere/point/rectarea/spot, `configure_default_lights`, **shadows** (cast/receive, per-object opacity), `configure_environment_map` (10 HDRI presets), `configure_fog` |
| **Materials** | standard PBR, toon3/toon5, wireframe, flat shading, opacity, single/double side |
| **GUI-in-scene** | `add_3d_gui_container` to anchor 2D widgets at 3D positions |

### 1.2 Scene interaction

- **Transform gizmos** — `add_transform_controls` (translate/rotate, axis masking, limits, drag start/end events).
- **Click / pointer** — scene-level `on_click`, per-node click handlers, instance-level raycast on batched objects, modifier-key filtering.
- **Rectangle selection** — `on_rect_select`.
- **Node dragging** — drag handlers on scene nodes (incl. batched).
- **Hierarchy** — kinematic tree via `/parent/child` naming.

### 1.3 GUI (2D control panel)

- **Inputs**: button, upload button, checkbox, text (incl. multiline), number, slider, multi-slider, vector2, vector3, rgb, rgba, dropdown, button group, progress bar.
- **Layout/containers**: folder, form (`on_submit`), modal, tab group, divider.
- **Display**: markdown, HTML, image, Plotly, uPlot (high-perf time-series).
- **Command palette**: `add_command` with hotkeys.
- **Events**: `.on_update`, `.on_click`, `.on_hold`, `.on_upload`; sync (thread-pool) or async callbacks.
- **Theming**: `configure_theme` (dark mode, control layout/width, brand color, titlebar/logo/share button), `set_panel_label`.
- **Notifications**: `client.add_notification` (loading/auto-close/color).
- **File transfer**: chunked upload (`UploadedFile`) and `send_file_download`.

### 1.4 Server / client / camera

- **Server**: multi-client WebSocket, shared vs per-client namespaces, `atomic()` batching, `flush()`, broadcast buffer + garbage collection, `on_client_connect/disconnect`.
- **Camera**: read/write `position`, `wxyz`, `look_at`, `up_direction`, `fov`, `near`, `far`; read-only `aspect`/`image_width`/`image_height`; `on_update`.
- **Offscreen rendering**: `get_render(height, width, ...)` → numpy (JPEG RGB / PNG RGBA), with custom camera params.
- **Sharing**: `request_share_url()` tunnel to `share.viser.studio` (24h).
- **Export**: `get_scene_serializer()` → `.viser` files and `as_html()` standalone embeds; `insert_sleep` for animations.
- **Jupyter**: `.show()` / inline notebook display.

### 1.5 Auxiliary libraries

- **`viser.transforms`**: pure-NumPy SO2/SO3/SE2/SE3 Lie groups (jaxlie port) with batch broadcasting, quaternion/matrix/Euler conversions, exp/log/adjoint.
- **`viser.extras`**: `Record3dLoader` (RGBD), `ViserUrdf` (robot URDF + joint control, via optional `yourdfpy`), COLMAP binary/text readers, `StateSerializer`.
- **Icons**: full Tabler icon enum.

### 1.6 First-class demonstrated use cases (from `examples/`)

NeRF/Gaussian-splat viewing, COLMAP SfM, point clouds, URDF robotics, SMPL/SMPL-X
human bodies (incl. skinned), Record3D RGBD streaming, multiplayer game state.

---

## Part 2 — What's Missing (Prioritized)

Priorities reflect a blend of **user demand** (open GitHub issues, with numbers
cited), **breadth of impact**, and **alignment with Viser's CV/robotics focus**.

### 🔴 P0 — High impact / frequently requested

| Gap | Evidence | Notes |
|---|---|---|
| **Smooth frontend camera animation** (`set_camera(..., duration=, smoothness=)`) | #548, #600 | Backend-loop interpolation stutters over latency; declarative client-side easing is the most-requested camera feature. Also needed for embedded/exported scenes. |
| **Mesh smooth (vertex-normal) shading & shading control** | #554, #620 | No way to render smooth normals; faceted look on dense meshes. Conversely, no way to fully disable shading while keeping per-vertex color. Two sides of the same normals/material gap. |
| **Trimesh RGBA transparency ignored** (bug) | #525 | `add_mesh_trimesh` drops per-face/vertex alpha → always opaque. Confirmed bug, `bug` label. |
| **Editable / dynamic Gaussian splats** | #405, #615, #539 | Buffer reassignment flickers (#615); SH view-dependent color not supported (#539); general splat editing (color/delete) requested (#405, #533). Core to the NeRF/3DGS audience. |
| **Interactive point-cloud / splat selection & editing** | #533, #510 | Box/lasso selection + delete/recolor for clouds & splats, mirroring mesh click selection. |
| **Reparenting scene nodes** | #559 | Parent is fixed at creation; no `scene.reparent()`. Forces costly remove+recreate to e.g. attach a gizmo. |

### 🟠 P1 — Clear demand, moderate scope

| Gap | Evidence | Notes |
|---|---|---|
| **Viewport / view-cube gizmo** (axis-aligned snap views) | #657 (`planned`) | Standard in 3D editors; three.js ships one. Already labeled planned. |
| **Scale (sim(3)) attribute for frames / nodes** | #531 (`planned`) | Enables binding clouds to a frame and correcting SLAM scale drift cheaply. Planned. |
| **Date/time picker GUI widget** | #599 (`planned`) | Returns `datetime`. Planned. |
| **Table / data-grid GUI widget** | #551 | Rows/cols, sorting, cell selection/editing. |
| **More flexible GUI layout** | #627, #655, #617 | Configurable/large panel width, GUI-only (no-scene) mode, side-by-side widgets, multiple simultaneous panels, larger modals, simple status (red/green) indicators. |
| **Batched URDF loading** | #658 | Efficient many-robot rendering (cf. site demo reel); no batched URDF path today. |
| **Image carousel / gallery widget** | #548 | Browse image datasets, optionally synced to camera poses (pairs with smooth camera anim). |
| **Depth-map rendering** | #532 | `get_render` returns RGB(A) only; no depth readback. |
| **Full session save/load** (scene + GUI state round-trip) | #542 | `StateSerializer` is export-for-playback only; no reload into a live server. |

### 🟡 P2 — Useful, narrower or larger-effort

| Gap | Evidence | Notes |
|---|---|---|
| **Camera control in embedded/exported HTML** (JS API) | #600, #591 | Drive camera/animation/overlays from JS in static deploys; `synchronizedVideoOverlay` reported missing. |
| **Live reload on Python code change** | #455 | Streamlit-style auto-refresh dev loop. |
| **Drag-and-drop file widget** (multi-file/folder) | #550 | Richer than the current upload button. |
| **`UploadedFile` temp-path / filesystem handle** | #574 | Only name + bytes exposed; users hand-roll temp files. |
| **Per-viewpoint visibility query** (which splats/points/verts are visible) | #510 | Frustum/occlusion query API. |
| **More human-rig models** (e.g. Meta MHR alongside SMPL) | #612 | Extras currently SMPL-centric. |
| **Async-callback example / docs** | #415 | Event-loop pitfalls (aiohttp, "future attached to different loop") undocumented. |

### 🟢 P3 — Strategic / large / niche

| Gap | Evidence | Notes |
|---|---|---|
| **C++ (and other non-Python) client/server** | #610 | Stable message schema as a public contract → MeshcatCpp-style bindings. Large architectural commitment. |
| **General 2D-canvas / infinite-canvas mode** | #626 | Treat the 3D viewer as one widget among 2D drawing primitives. Scope expansion beyond current mission. |
| **Single-port / pure-HTML deploy** (e.g. share Gradio's port) | #404 | Eases Hugging Face Spaces and other constrained hosts. |
| **HTML-export animation looping** (skinned mesh) (bug) | #728 (PR #729) | Exported animations freeze after first loop; minimal fix already proposed. |

### Documentation / DX gaps (low effort, recurring)

- **Coordinate-convention clarity** for camera frustums & COLMAP — repeated confusion (#622, #491). Worth a focused conventions doc with worked examples.
- **Async callbacks**, **embedded-export JS API**, and **dynamic-splat update** patterns lack examples (#415, #600, #615).
- Recurring "empty viewer / `no attribute ViserServer`" install issues (#459, #581) suggest a troubleshooting/FAQ page would cut support load.

---

## Summary

Viser's **core is mature**: a broad scene/GUI primitive set, batching+LOD, robust
multi-client sync, offscreen rendering, sharing tunnels, HTML export, and strong
CV/robotics demos. The gaps cluster in five themes:

1. **Camera UX** — smooth client-side animation, view-cube, embedded-export control.
2. **Mesh/material fidelity** — smooth normals, shading toggles, trimesh alpha (bug).
3. **Gaussian-splat maturity** — dynamic updates without flicker, SH view-dependence, editing/selection.
4. **GUI expressiveness** — tables, flexible layout/width, date picker, carousel, status indicators.
5. **Scene-graph flexibility** — reparenting and per-node scale.

The quickest high-value wins: fix **trimesh RGBA alpha (#525)** and **HTML-export
looping (#728, fix already in #729)**, ship the already-**`planned`** items
(view-cube #657, frame scale #531, date picker #599), and add **smooth frontend
camera animation (#548)** — the single most-requested capability.
