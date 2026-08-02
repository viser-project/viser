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

### 2. LOD level assignment must not assume an ascending sort

- **File:** `core/feature/FrustumCulling.ts` (`frustumCullingLOD`)
- **What:** when `sortObjects` is on, the sorted render list is bucketed into
  LOD levels via `getObjectLODIndexForDistance()` per item, instead of a
  forward-only cursor that advances at most one level per item.
- **Why:** the cursor assumes the sort left depths ascending, which holds only
  for `sortOpaque`. Viser sorts transparent batches back-to-front (see
  `mesh/batchedDepthSort.ts`, needed so instances in one batch composite
  correctly), and under that descending order the cursor steps off level 0 on
  the first -- farthest -- item and can never come back: every near instance
  ends up rendering at the coarsest LOD. The per-item lookup is the same one
  the unsorted path already uses and is correct for either direction. Covered
  by `core/feature/FrustumCulling.lod.test.ts`.
- **Re-apply check:** if upstream reworks the sorted LOD path to handle
  descending order itself (the block carries an `improve this condition` TODO),
  drop this patch -- but verify with the test above, since dropping it
  silently degrades LOD quality rather than breaking anything outright.
