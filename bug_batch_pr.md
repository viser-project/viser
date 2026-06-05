# Pull request

## Title

Fix a batch of client + server bugs (lifecycle, wire safety, input handling)

## Description

A batch of correctness fixes across the React/three.js client and the Python
server. Each change is reproduced by a test and was reviewed for regressions
against `main`.

**Client (React / three.js)**
- Input components: RGBA/RGB no longer fight typing and Enter closes the color
  picker; slider precision; vector field tolerates an empty value; multi-slider
  honors a mid-drag disable; controlled tab groups keep their selection; the
  scene-tree prop editor commits fields independently and ignores stale keys.
- Render correctness: fix dark-mode first-paint flash, global-visibility on the
  root node, instanced-axes culling/bounds, and a theme change cancelling an
  in-flight scene-pointer gesture.
- Resource leaks: dispose Gaussian-splat sorters, skinned-mesh bones, Plotly
  plots, and stale background textures; coalesce camera-send timeouts.

**Python server**
- Wire safety: array-prop updates (incl. point clouds and splat buffers) now
  queue a private copy, preventing torn reads / caller aliasing during the
  event loop's lazy serialization.
- Handle lifecycle: scene-node remove cascade unified behind a shared
  `_on_remove()` hook, so transform-controls / 3D-GUI-container registries are
  cleaned up even on ancestor-cascade removal; per-instance GUI container
  scoping; populated tab-group removal; transform-controls drag-end after
  mid-drag removal; zero-byte file uploads now complete.
- Validation: clearer errors for out-of-range dropdown values, mismatched
  batched-mesh colors, and degenerate skinned meshes; HTTP serving 404s on
  directories.
- RGB/RGBA values follow the matplotlib convention: float channels are `[0,1]`
  scaled to `[0,255]`, integer channels are absolute, and the result is clamped
  to `[0,255]`. Consistent with scene colors.

**Behavior changes to note**
- A few previously-silent invalid inputs now raise (dropdown initial value,
  batched-mesh color length, zero-bone skinned mesh).
- Float RGB/RGBA values are now scaled, so `1.0` -> white (integer values are
  unchanged).

**Testing**
- New Python regression tests (`tests/test_handle_lifecycle_bugs.py`,
  `tests/test_tab_group.py`) and Playwright e2e (`tests/e2e/test_bug_*.py`).
- Full suite green: pytest (unit + e2e), pyright, ruff, eslint, tsc.
- `repro_bugs.py` is an optional manual repro/verification script (not CI).
