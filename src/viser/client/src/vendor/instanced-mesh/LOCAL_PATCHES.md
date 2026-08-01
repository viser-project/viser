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

### 2. Direction-aware LOD level assignment when `sortObjects` is enabled

- **File:** `core/feature/FrustumCulling.ts` (`frustumCullingLOD`)
- **What:** the walk that splits the sorted render list into per-LOD-level
  index arrays assumed the list was sorted in ascending depth order. That only
  holds for opaque materials; transparent materials sort back-to-front
  (descending depth), which assigned the farthest instances to the finest LOD
  level and scrambled the rest. The patch detects the actual ordering (by
  comparing the first and last depths) and walks the level thresholds in the
  matching direction, preserving draw order within each level. The ascending
  walk also advances with `while` where upstream used `if`: single-item and
  all-equal-depth lists (which the direction check routes to the ascending
  branch) can skip more than one level band per item, and upstream's `if`
  assigned them one level too fine.
- **Why:** Viser enables `sortObjects` for transparent batched meshes so that
  instances alpha-blend back-to-front (issue #752); without this patch,
  transparent meshes that also have LODs would render with wrong LOD levels.
  Covered by `core/FrustumCulling.sorting.test.ts`.
- **Re-apply check:** if upstream has made the sorted LOD-splitting loop
  order-aware (or sorts ascending and draws in reverse), this patch may be
  redundant -- run the sorting test against the re-vendored copy to verify.

### 3. BVH culling paths sort by transformed bounding-sphere center

- **File:** `core/feature/FrustumCulling.ts` (`BVHCulling`, `BVHCullingLOD`)
- **What:** when `sortObjects` is enabled, the BVH culling paths computed
  sort depth (and, in the LOD path, the LOD-selection distance) from the raw
  instance origin (`getPositionAt`), while the linear culling paths use the
  geometry bounding-sphere center transformed by the instance matrix. For
  off-center geometry the origin orders instances differently depending on
  their rotations, so BVH-enabled meshes (clickable/draggable/large) could
  draw transparent instances in a different order than the same mesh without
  a BVH. The patch mirrors linearCulling's sphere-center logic, keeping the
  cheap origin fast path when the geometry is centered.
- **Why:** viser enables `sortObjects` for transparent batched meshes
  (issue #752); sort order should not depend on whether a BVH happens to be
  built. Covered by `core/FrustumCulling.sorting.test.ts` (off-center
  geometry tests).
- **Re-apply check:** if upstream's BVH culling paths sort by the
  transformed bounding sphere (matching their linear paths), this patch is
  redundant -- the off-center geometry tests verify either way.
