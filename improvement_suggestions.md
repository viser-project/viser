# Improvement Suggestions for Prop Update Performance

## Problem Summary

Updating `batched_wxyzs` (and similar per-instance props like `batched_positions`,
`batched_scales`) on batched meshes is **~2-3x slower** than updating `wxyz` on
regular meshes, even though the actual Three.js GPU work is comparable. The
bottleneck is React re-rendering overhead.

**Benchmark results** (67 meshes, 60 Hz target, headless SwiftShader):
- `glb` mode (imperative `wxyz`/`position`): ~25 FPS mean, ~30 FPS median
- `batched_glb` mode (declarative `batched_wxyzs`/`batched_positions`): ~11 FPS mean, ~20 FPS median, P99 = 2117ms

**Profiling results** (67 batched_glb meshes, instrumented zustand store):

| Metric | Value |
|--------|-------|
| Frame duration (mean) | ~58 ms (17 FPS) |
| `setState` calls per frame | ~537-646 (67 meshes × 2 props × ~4 server batches) |
| `setState` time per frame | ~35 ms (**60% of frame budget**) |
| Time per `setState` call | ~54 μs |
| Zustand subscriber count | 550 |
| Total listener invocations per frame | **~355,000** |
| Scene nodes with changed `message` ref | 67 per frame (all meshes) |

The profiling reveals the precise bottleneck: each `store.setState()` call
synchronously notifies **all 550 zustand subscribers** to check their selectors.
With ~537+ setState calls per frame, this produces **355,000 selector evaluations
per frame** — an O(N_subscribers × N_setState_calls) cost that consumes 60% of
the frame budget before any React rendering even begins.

## Root Cause Analysis

When `handle.batched_wxyzs = new_array` is called on the Python side:

1. A `SceneNodeUpdateMessage` is sent to the client
2. `updateSceneNodeProps()` does a triple-spread to create new `node.message.props`:
   ```typescript
   { ...node, message: { ...node.message, props: { ...node.message.props, ...updates } } }
   ```
3. Each call does a separate `store.setState()`, which synchronously notifies all
   550 zustand subscribers to re-evaluate their selectors
4. This creates a new `message` reference, triggering the zustand selector in
   `SceneNodeThreeObject`: `state[name]?.message`
5. **Full re-render cascade**: `SceneNodeThreeObject` → `createObjectFactory` (useMemo)
   → `makeObject` (useMemo) → `BatchedMesh`/`BatchedGlbAsset` → `BatchedMeshBase`
6. `BatchedMeshBase` has **7 useEffect hooks** whose dependency arrays are all checked
7. Only 1-2 effects actually fire (the transform update), but the overhead of
   re-rendering all components + checking all deps is significant

In contrast, `wxyz` updates:
1. Are stored as top-level attributes on the `SceneNode` (NOT in `message.props`)
2. The `message` reference never changes → **zero React re-renders**
3. Applied directly in `useFrame` via `objRef.current.quaternion.set()`

Additionally, with 67 meshes in the benchmark, each getting 2 prop updates per
frame (`batched_wxyzs` + `batched_positions`), that's **134 individual
`store.setState()` calls per frame**. Each one notifies all zustand subscribers
to check their selectors. Compare with the `glb` mode where all wxyz/position
updates are accumulated and applied in **one** `store.setState()` call.

---

## Option 1: Keep Everything Declarative — Optimize Inefficiencies

### 1A: Batch `SceneNodeUpdateMessage` handling like `SetOrientationMessage`

**Current:** Each `SceneNodeUpdateMessage` immediately calls `updateSceneNodeProps()`
which does a separate `store.setState()`. With 67 meshes × 2 props = 134 calls/frame.

**Proposed:** Accumulate `SceneNodeUpdateMessage` updates and apply them in a single
`store.setState()`, matching how `SetOrientationMessage` already works:

```typescript
// In handleMessage for SceneNodeUpdateMessage:
case "SceneNodeUpdateMessage": {
  return {
    targetNode: message.name,
    propsUpdates: message.updates,  // New field for props-level updates
  };
}

// In the accumulation step:
// Merge both attribute updates AND props updates, then apply in one setState
```

**Impact:** Reduces ~537-646 `setState` calls to 1 per frame. Profiling shows
this would reduce selector evaluations from **355,000 to 550 per frame** and
recover **~35 ms per frame** (60% of current frame budget). This is a massive
win on its own. However, it does NOT solve the React re-render cascade — each
node whose props changed will still re-render (~67 components × full cascade).

**Effort:** Low. ~50 lines changed in `MessageHandler.tsx`.

**Verdict:** **Highest-impact, lowest-effort change.** Should be done first
regardless of which other option is chosen. The profiling data shows this single
change would likely more than double the FPS for the batched_glb benchmark.

### 1B: Split `message` from mutable props in the zustand selector

**Current:** `SceneNodeThreeObject` subscribes to the entire `message` object:
```typescript
const message = viewer.useSceneTree((state) => state[props.name]?.message);
```
Any prop change creates a new `message` → re-render.

**Proposed:** Split the SceneNode store so `message` only contains the
*structural* definition (type, name, and immutable props like vertices/faces),
and mutable props are stored separately:

```typescript
type SceneNode = {
  message: SceneNodeMessage;     // Only changed on addSceneNode
  mutableProps: Record<string, any>;  // Changed on updateSceneNodeProps
  // ... other fields
};
```

Then `SceneNodeThreeObject` subscribes only to `message` (which never changes for
prop updates), and child components subscribe to specific mutable props they need.

**Problem:** This requires each child component to know which zustand selector to
use for each prop, AND requires custom equality functions for typed array props.
The `createObjectFactory` pattern (which creates JSX with `{...message}` spread)
would need significant refactoring.

**Effort:** High. Would require rearchitecting `createObjectFactory`, all scene
node components, and the `SceneTreeState`.

**Verdict:** Architecturally clean but a large refactor. The fundamental issue is
that React's rendering model (props → render → effects) has inherent overhead
per re-render that can't be fully eliminated. Even with perfect memoization,
each component that reads a mutable prop will re-render when it changes.

### 1C: Use `React.memo` with custom comparators + useRef for fast-path props

**Proposed:** Wrap `BatchedMeshBase` in `React.memo` with a custom comparator that
does reference equality for typed arrays and only triggers re-renders when
structurally-important props change:

```typescript
const BatchedMeshBase = React.memo(
  function BatchedMeshBase(props) { ... },
  (prev, next) => {
    // Only re-render if geometry, material, or LOD changed
    return prev.geometry === next.geometry
        && prev.material === next.material
        && prev.lod === next.lod;
  }
);
```

For fast-changing props (`batched_wxyzs`, etc.), use a ref-based approach:
```typescript
const propsRef = useRef(props);
propsRef.current = props;

useFrame(() => {
  // Read from ref — no dependency array needed
  updateInstancesFromRef(propsRef.current, mesh);
});
```

**Problem:** This breaks React's declarative contract — useEffect hooks that
depend on `batched_wxyzs` would never fire because the component doesn't
re-render. You'd need to convert all those effects to `useFrame` checks, which
is essentially the imperative approach.

**Effort:** Medium. Targeted to batched mesh components.

**Verdict:** This is a hybrid that moves toward Option 2 but tries to stay within
the existing component structure. It would work but is somewhat hacky — you're
fighting React's model rather than working with it.

### 1D: Make `wxyz` and other imperative props declarative (if declarative is fast enough)

If we successfully optimize the declarative path (via 1A + 1B), we could
consider making `wxyz` and `position` declarative too, for consistency.

**Verdict:** Only viable if Options 1A-1C bring the declarative path to near-zero
overhead. Unlikely to be competitive with the imperative path in the general
case. Not recommended as a standalone strategy.

### Overall Assessment of Option 1

Option 1A (batching SceneNodeUpdateMessages) is a clear win and should be done.
Options 1B and 1C can reduce the overhead but cannot eliminate it — React's
component model inherently does work proportional to the number of re-rendering
components × their dependency complexity. For 67 nodes with 7 useEffects each,
that's ~469 effect dependency checks per frame even in the best case.

**Recommendation:** Do 1A. Consider 1C as a targeted optimization for batched
meshes. But don't rely on Option 1 alone for the full solution.

---

## Option 2: Special-Case Some Properties for Imperative Updates

### Approach

Extend the existing imperative update pattern (used for `wxyz`, `position`,
`visible`) to cover `batched_wxyzs`, `batched_positions`, `batched_scales`, and
potentially other high-frequency props.

### Design

**Server side:** Add new message types:
```python
@dataclasses.dataclass
class SetBatchedTransformsMessage(Message):
    name: str
    batched_wxyzs: npt.NDArray[np.float32] | None = None
    batched_positions: npt.NDArray[np.float32] | None = None
    batched_scales: npt.NDArray[np.float32] | None = None
```

Or, more generally, introduce a `SceneNodeImperativeUpdateMessage` that can carry
any combination of "fast" props without going through the declarative pipeline.

**Client side:**
1. Handle the message imperatively in `FrameSynchronizedMessageHandler` — store the
   updated values as top-level attributes on the `SceneNode` (like `wxyz` already is):
   ```typescript
   return {
     targetNode: message.name,
     updates: {
       _batched_wxyzs: message.batched_wxyzs,
       _batched_positions: message.batched_positions,
       poseUpdateState: "needsUpdate",  // Reuse existing mechanism
     },
   };
   ```

2. In `BatchedMeshBase`, read these from the store in `useFrame` instead of via props:
   ```typescript
   useFrame(() => {
     const node = viewer.useSceneTree.getState()[name];
     if (node?._batched_wxyzs && mesh) {
       updateTransforms(mesh, node._batched_wxyzs, node._batched_positions, ...);
     }
   });
   ```

3. The zustand `message` reference never changes → **zero React re-renders** for
   transform-only updates.

### Pros
- Matches the proven pattern for `wxyz` — known to be fast
- Targeted change — only affects the specific props that need it
- No architectural upheaval
- Type-safe: new message types are auto-generated from Python dataclasses

### Cons
- Each new "fast" property requires plumbing in multiple places:
  - Python message definition
  - Python handle setter
  - Client message handler
  - Client component useFrame reader
- Growing list of special cases creates maintenance burden
- Inconsistency: some props are declarative, some are imperative, and the
  boundary is not always obvious
- Props that are "mostly static but occasionally updated at high frequency"
  don't fit neatly into either category

### Effort
Medium. ~200-300 lines across Python + TypeScript for the batched transform case.
Each additional prop adds ~50-100 lines.

### Verdict
This is the **most pragmatic short-term solution**. It directly solves the
benchmark problem with minimal risk. The main concern is long-term maintenance
as more props need the fast path.

---

## Option 3: Re-architect to Always-Imperative Prop Updates

### Core Idea

Separate "what kind of object to render" (structural, declarative) from "what are
its current property values" (data, imperative). The zustand store's `message`
only changes when the node is *created or replaced*. All property updates are
stored in a separate, non-reactive data structure and read imperatively.

### Detailed Design

#### 3A: Mutable Props Store

```typescript
// New: separate store for mutable props, keyed by node name
type MutablePropsStore = {
  [nodeName: string]: {
    props: Record<string, any>;  // Current prop values
    version: number;             // Incremented on each update
  };
};

// Stored on ViewerMutable (no React reactivity):
viewerMutable.mutableProps: { [name: string]: { props: Record<string, any>, version: number } }
```

When a `SceneNodeUpdateMessage` arrives:
```typescript
case "SceneNodeUpdateMessage": {
  // Update mutable props store (no React re-render)
  const entry = viewerMutable.mutableProps[message.name];
  Object.assign(entry.props, message.updates);
  entry.version++;
  return; // No return value → no zustand setState
}
```

When a scene node is *created* (`addSceneNode`):
```typescript
// Initialize mutable props from the creation message
viewerMutable.mutableProps[message.name] = {
  props: { ...message.props },
  version: 0,
};
// The zustand store only gets the structural message
store.setState({ [name]: { message, ... } });
```

#### 3B: Component Reading Pattern

Each component reads props imperatively in `useFrame`:

```typescript
function BatchedMeshBase({ name, geometry, material, lod, ... }) {
  const viewer = useContext(ViewerContext);
  const lastVersionRef = useRef(-1);
  const meshRef = useRef<InstancedMesh2 | null>(null);

  useFrame(() => {
    const entry = viewer.mutable.current.mutableProps[name];
    if (!entry || entry.version === lastVersionRef.current) return;
    lastVersionRef.current = entry.version;

    const props = entry.props;
    // Update transforms
    updateInstanceTransforms(meshRef.current, props.batched_wxyzs, ...);
    // Update colors if changed
    updateInstanceColors(meshRef.current, props.batched_colors, ...);
    // etc.
  });
}
```

#### 3C: Type Safety via Code Generation

The concern with imperative updates is that it's easy to forget to handle a prop,
or to read it with the wrong type. This can be mitigated:

1. **Auto-generate prop reader/applier functions** from the Python message
   definitions. For each `*Props` dataclass, generate a TypeScript function:
   ```typescript
   // Auto-generated
   function applyBatchedMeshesPropsUpdate(
     mesh: InstancedMesh2,
     prevProps: BatchedMeshesProps,
     nextProps: Partial<BatchedMeshesProps>,
   ): void {
     if (nextProps.batched_wxyzs !== undefined) { ... }
     if (nextProps.batched_positions !== undefined) { ... }
     // etc.
   }
   ```

2. **Exhaustiveness checking** via TypeScript's `satisfies` or mapped types:
   ```typescript
   // Compile error if a new prop is added to BatchedMeshesProps but not handled
   const BATCHED_MESH_PROP_HANDLERS: {
     [K in keyof BatchedMeshesProps]: (mesh: InstancedMesh2, value: BatchedMeshesProps[K]) => void
   } = { ... };
   ```

3. **Test that all props are handled**: A unit test can verify that for each
   message type, every prop in its Props definition has a corresponding handler.

#### 3D: When to Trigger React Re-renders

Some prop changes DO require React re-renders (e.g., changing `material` from
"standard" to "toon" requires recreating the Three.js material). The system needs
a way to distinguish:

- **Hot props**: Can be applied imperatively (transforms, colors, opacities,
  shadow flags). Updated every frame via `useFrame`.
- **Cold props**: Require React re-render (geometry vertices, material type,
  wireframe mode, LOD configuration). Updated by modifying the zustand `message`.

This distinction can be encoded in the Python message definitions:
```python
@dataclasses.dataclass
class BatchedMeshesProps:
    # Cold props (require React re-render)
    vertices: npt.NDArray[np.float32]  # @cold
    faces: npt.NDArray[np.uint32]      # @cold
    material: Literal["standard", "toon3", "toon5"]  # @cold
    wireframe: bool  # @cold
    lod: ...  # @cold

    # Hot props (imperative update)
    batched_wxyzs: npt.NDArray[np.float32]  # @hot
    batched_positions: npt.NDArray[np.float32]  # @hot
    batched_scales: ...  # @hot
    batched_colors: ...  # @hot
    opacity: float | None  # @hot
    batched_opacities: ...  # @hot
    cast_shadow: bool  # @hot
    receive_shadow: bool  # @hot
```

The `_queue_update` method on the Python handle would check whether the prop is
hot or cold and send either a `SceneNodeImperativeUpdateMessage` (for hot) or
`SceneNodeUpdateMessage` (for cold). This is transparent to the user — they
just write `handle.batched_wxyzs = new_array`.

### Pros
- **Maximum performance**: No React re-renders for any hot prop update
- **Consistent**: ALL props go through the same system, no ad-hoc special cases
- **Makes `wxyz`/`position`/`visible` consistent with other props** — they become
  just another hot prop rather than a separate mechanism
- **Type-safe with code generation**: The hot/cold distinction can be
  type-checked and tested
- **Scales well**: Adding new props doesn't require new plumbing — just annotate
  as hot or cold
- **Unifies the imperative path**: Today, `wxyz` is updated via a dedicated
  `SetOrientationMessage` with a specific handler. With this design, all hot
  props use the same generic mechanism.

### Cons
- **Large refactor**: Every scene node component needs to be modified to read
  hot props in `useFrame` instead of from React props
- **Complexity in the hot/cold boundary**: When a cold prop changes, we need to
  also ensure hot props are re-applied correctly (e.g., after recreating a mesh)
- **Debugging difficulty**: Imperative updates are harder to debug than
  declarative React state
- **R3F integration**: Some Three.js properties that R3F manages declaratively
  (like material uniforms) would need imperative wrappers
- **Risk of stale state**: If a component reads hot props in useFrame but the
  component was unmounted/remounted (due to a cold prop change), it needs to
  re-read all hot props on mount

### Effort
High. ~1000-2000 lines across the codebase. Probably 2-3 days of focused work.
Most of the effort is in converting existing components to the new pattern.

### Verdict
This is the **most architecturally sound long-term solution**. It eliminates the
performance problem entirely, unifies the update paths, and scales well. The
main cost is the upfront refactor effort.

A key design choice that makes this tractable: **the version counter**. Each
component just checks `if (version !== lastVersion)` in useFrame and re-applies
all hot props. This is simple, correct, and fast (a single integer comparison per
frame per component when nothing changed).

The hot/cold annotation system means the Python-side user experience doesn't
change at all — they just assign props and things work. The performance
optimization is fully internal to the client.

---

## Option 4: Keep Things As-Is

**Not recommended.** The benchmark shows a 2.3x FPS degradation with P99 spikes
over 2 seconds. This is clearly visible to users and makes batched meshes feel
sluggish compared to regular meshes.

---

## Option 5: Other Approaches

### 5A: Use Zustand's `subscribeWithSelector` + `equalityFn`

Instead of subscribing to the entire `message` object, each component could
subscribe to only the specific props it needs with custom equality:

```typescript
const batched_wxyzs = viewer.useSceneTree(
  (state) => state[name]?.message.props.batched_wxyzs,
  (a, b) => a === b  // Reference equality
);
```

**Problem:** This doesn't help because the typed array reference DOES change on
every update (it's a new view from the WebSocket buffer). Content comparison
would be O(N) and defeat the purpose.

However, we COULD store a monotonically increasing version counter alongside the
props and use that for equality. But this starts looking like Option 3.

**Verdict:** Not viable on its own, but the idea of version-based selectors
informs Option 3's design.

### 5B: Web Worker for React Rendering (OffscreenCanvas)

Move the entire React Three Fiber rendering to a Web Worker using
`OffscreenCanvas`, so React's rendering work doesn't block the main thread.

**Problem:** R3F doesn't support OffscreenCanvas. This would be a massive
undertaking that goes well beyond viser's scope.

**Verdict:** Not feasible.

### 5C: Use Jotai or Other Fine-Grained Reactivity

Replace zustand with a more granular state library like Jotai (atoms) or
@preact/signals. Each prop would be its own atom/signal, allowing per-prop
subscriptions.

**Problem:** Major rewrite of all state management. Jotai atoms don't integrate
as naturally with R3F's render loop. The real bottleneck isn't the subscription
system — it's the React component re-rendering + useEffect machinery.

**Verdict:** High effort, uncertain benefit. Not recommended.

### 5D: Hybrid Declarative with `useSyncExternalStore` for Hot Props

Create a lightweight external store for hot props that bypasses zustand:

```typescript
const hotPropsStore = new Map<string, { props: any, version: number, listeners: Set<() => void> }>();

function useHotProp<T>(name: string, propKey: string): T {
  return useSyncExternalStore(
    (cb) => { /* subscribe to hotPropsStore[name] */ },
    () => hotPropsStore.get(name)?.props[propKey],
  );
}
```

This is essentially Option 3 but keeps React's declarative model by using
`useSyncExternalStore` instead of `useFrame`. The advantage is that React still
controls when components render. The disadvantage is that React still does the
rendering work.

**Verdict:** Provides better subscription granularity but doesn't eliminate the
core rendering overhead. Not recommended over Option 3.

---

## Recommended Approach

### Short-term (immediate, low risk):
1. **Do Option 1A**: Batch `SceneNodeUpdateMessage` handling into a single
   `setState` call. This is a pure optimization with no behavioral change.

### Medium-term (solves the problem):
2. **Do Option 2**: Special-case `batched_wxyzs`, `batched_positions`,
   `batched_scales` for imperative updates. This directly solves the
   benchmark problem with minimal risk.

### Long-term (best architecture):
3. **Do Option 3**: Implement the hot/cold prop system with version-based
   imperative updates. This eliminates the problem class entirely and provides
   a clean, scalable architecture.

Option 3 subsumes Option 2 — once the hot/cold system is in place, the
special-cased imperative properties from Option 2 become just another set of
hot props. Option 1A is compatible with all other options and should be done
first.

The recommended migration path:
1. Implement Option 1A (1 hour)
2. Implement Option 3 for batched meshes first as a proof of concept (1 day)
3. Extend Option 3 to all scene node types (1-2 days)
4. Migrate `wxyz`/`position`/`visible` to use the same hot prop system (optional cleanup)

This gets performance benefits quickly (step 1) while building toward the
right long-term architecture (steps 2-4).

---

## Appendix: Detailed Cost Breakdown (Measured)

The following data was collected via Playwright instrumentation of the zustand
store with 67 batched GLB meshes at 60 Hz server update rate.

### Per-frame cost with 67 batched meshes, current code:

| Step | Measured | Impact |
|---|---|---|
| `store.setState()` calls per frame | **537-646** | 67 meshes × 2 props × ~4 server batches |
| Zustand subscribers | **550** | One per `useSceneTree(selector)` call |
| Selector evaluations per frame | **~355,000** | 550 subscribers × ~646 setState calls |
| Time spent in setState per frame | **~35 ms** | **60% of frame budget** at ~54 μs/call |
| Scene nodes re-rendered | **67** | All batched meshes (message ref changed) |
| `createObjectFactory` runs | 67 | 67 × switch + closure allocation |
| `BatchedMeshBase` useEffect checks | 469 | 67 × 7 useEffect dependency arrays |
| useEffect executions | ~134 | 67 × ~2 effects fire (transforms) |
| Total frame time | **~58 ms** | ~17 FPS |

**Key insight from profiling:** The zustand subscriber notification alone (355K
selector evaluations at 60% of frame time) is a bigger bottleneck than the React
component re-rendering. Even if we perfectly optimize the React rendering, the
O(N_subscribers × N_setState_calls) zustand overhead would remain.

### Per-frame cost with Option 1A only (batched setState):

| Step | Estimated | Impact |
|---|---|---|
| `store.setState()` calls per frame | **1** (down from 537+) | All updates merged |
| Selector evaluations per frame | **550** (down from 355K) | 550 subscribers × 1 call |
| Time spent in setState per frame | **~54 μs** (down from 35 ms) | **99.8% reduction** |
| Scene nodes re-rendered | **67** | Still re-render (message ref changed) |
| React rendering overhead | ~same | Component cascade still happens |

This shows Option 1A alone would recover most of the setState overhead but not
the React rendering overhead.

### Per-frame cost with Option 3 (hot/cold props):

| Step | Estimated | Impact |
|---|---|---|
| Mutable props store update | 134 × Object.assign + version++ | ~0.1 ms |
| useFrame version checks | 67 × integer comparison | ~0.01 ms |
| Transform updates (actual work) | 67 × updateInstances | Same as current |
| `store.setState()` calls | **0** | No zustand involvement |
| Selector evaluations | **0** | No subscriber notifications |
| React re-renders | **0** | No message ref changes |
| Total overhead vs current | **~35 ms saved** | Would bring FPS from ~17 to near GPU limit |
