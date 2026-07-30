# Local patches to the vendored `instanced-mesh` library

This directory is a vendored copy of the `@three.ez/instanced-mesh` library
(MIT, Copyright (c) 2024 Andrea Gargaro -- see `LICENSE`). It was vendored into
Viser in commit `49b2a7f9` ("Reversed depth buffer, material update fixes",
#674).

Because it is vendored rather than an npm dependency, any local changes will be
silently lost if these files are re-synced from upstream. **When re-vendoring,
re-apply the patches below.** Each patch site is also marked inline with a
`=== VISER LOCAL PATCH ===` / `=== END VISER LOCAL PATCH ===` comment block, so

```
grep -rn "VISER LOCAL PATCH" src/viser/client/src/vendor/instanced-mesh
```

lists every divergence from upstream.

## Patches

### 1. Free the raw `instanceIndex` GL buffer on dispose

- **Files:** `core/utils/GLInstancedBufferAttribute.ts`, `core/InstancedMesh2.ts`
- **What:** `GLInstancedBufferAttribute` gains a `dispose(gl)` method that calls
  `gl.deleteBuffer(this.buffer)`; `InstancedMesh2.dispose()` calls it for the
  mesh's `instanceIndex` and every LOD object's `instanceIndex`.
- **Why:** the `instanceIndex` buffer is created directly via `gl.createBuffer()`
  and is never tracked by three.js's `WebGLAttributes`, so three never frees it.
  Without this, every InstancedMesh2 recreation leaks that GL buffer until WebGL
  context loss. Covered by `core/InstancedMesh2.dispose.test.ts`.
- **Re-apply check:** confirm upstream still creates `instanceIndex` as a raw
  `GLInstancedBufferAttribute` (untracked by three). If upstream adds its own
  disposal for it, this patch may become redundant -- verify before dropping.

### 2. Make a frame drawn in the dispose->unmount window safe

- **File:** `core/InstancedMesh2.ts`
- **What:** three additions on top of patch 1's dispose hardening:
  `dispose()` nulls `instanceIndex` and deletes the geometry's
  `instanceIndex` attribute -- for the main mesh AND every LOD level's own
  geometry (LOD levels are separate meshes with per-level geometries);
  `onBeforeShadow()` gains the same `!this.instanceIndex` early-return that
  `onBeforeRender()` already had.
- **Why:** React commits the swap to a new mesh asynchronously, so a frame can
  render the old mesh after `dispose()`. Without the nulling, that frame binds
  the freed GL buffer (undefined behavior); without the shadow gate, it
  crashes -- the shadow pass runs BEFORE the main pass, `onBeforeShadow` only
  guarded its culling call with `instanceIndex &&`, and the unconditional
  `instanceIndex.update(...)` below it dereferences null (any shadow-casting
  batched mesh under a shadow-mapped light). `onAfterRender`'s re-init branch
  then restores a valid attribute for any later frames, at the accepted cost
  of one fresh buffer. Covered by `core/InstancedMesh2.dispose.test.ts`.
- **Re-apply check:** if upstream restructures the render/shadow hooks, the
  invariant to preserve is "every `instanceIndex` dereference in a hook is
  behind a null gate, and dispose leaves no geometry (main or LOD) retaining
  the attribute."
