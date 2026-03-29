# Current Prop Update Logic in Viser

This document traces the complete path of a prop update from the Python server to
the Three.js scene graph, with special attention to the difference between
`wxyz` (fast, imperative) and `batched_wxyzs` (slow, declarative).

## 1. Python Side: Sending Updates

### Property assignment (`_assignable_props_api.py`)

When a user writes `handle.batched_wxyzs = new_array`, the monkey-patched
`__setattr__` on `AssignablePropsBase`:

1. **Type cast** — Casts to `np.float32` via `_cast_value_recursive()`
2. **Change detection** — For arrays: `np.array_equal(current, new)`. Skips if unchanged.
3. **Local update** — In-place copy if same shape, else replaces the stored array
4. **Queue message** — Calls `_queue_update(name, value)` which sends:
   ```python
   SceneNodeUpdateMessage(self._impl.name, {"batched_wxyzs": value})
   ```

### Special-cased properties (`_scene_handles.py`)

`wxyz`, `position`, and `visible` have custom `@property` setters on
`SceneNodeHandle` that send dedicated messages:
- `SetOrientationMessage(name, wxyz=(w, x, y, z))` — 4 floats, not a numpy array
- `SetPositionMessage(name, position=(x, y, z))` — 3 floats
- `SetSceneNodeVisibilityMessage(name, visible=bool)`

These bypass the `SceneNodeUpdateMessage` path entirely.

### Wire protocol

Both message types go through `AsyncMessageBuffer`:
- Messages are batched into windows at ~60 fps
- Redundancy-based dedup: `SceneNodeUpdateMessage` uses key like
  `"SceneNodeUpdateMessage_/my_node"`, so only the latest per-node update survives
- Numpy arrays in `SceneNodeUpdateMessage` are extracted and sent as raw binary
  buffers (zero-copy on client)

## 2. Client Side: Receiving Messages

### Web Worker (`WebsocketClientWorker.ts`)

The WebSocket connection runs in a Web Worker. On each window:
1. Reads 8+8 byte header (decompressed/compressed sizes)
2. Decompresses the msgpack portion with zstd
3. Decodes msgpack, reconstructs binary placeholders as TypedArray views (zero-copy)
4. Posts the decoded message array to the main thread via `postMessage`

### WebSocket Interface (`WebsocketInterface.tsx`)

On worker message: pushes all messages onto `viewerMutable.messageQueue` (a plain
array on a ref — no React state).

### Frame-Synchronized Processing (`MessageHandler.tsx`)

`FrameSynchronizedMessageHandler` runs in a `useFrame` hook at priority `-100000`
(highest priority — runs before all other frame hooks). Each frame:

1. Splice messages from `messageQueue` (up to a render-request boundary)
2. Call `handleMessage()` for each message
3. Accumulate returned `{ targetNode, updates }` pairs
4. Apply accumulated attribute updates in a single `setState` call

## 3. Message Dispatch: The Two Paths

### Path A: `SceneNodeUpdateMessage` → Declarative (SLOW)

```
handleMessage("SceneNodeUpdateMessage")
  → updateSceneNode(message.name, message.updates)
    → SceneTreeState.updateSceneNodeProps(name, updates)
```

**`updateSceneNodeProps`** (`SceneTreeState.ts:144`):
```typescript
store.setState({
  [name]: {
    ...node,                    // Spread existing node (NEW object)
    message: {
      ...node.message,          // Spread existing message (NEW object)
      props: {
        ...node.message.props,  // Spread existing props (NEW object)
        ...(updates as any),    // Merge in updated props
      },
    },
  },
});
```

This creates new references for `node`, `node.message`, and `node.message.props`.

### Path B: `SetOrientationMessage` → Imperative (FAST)

```
handleMessage("SetOrientationMessage")
  → returns { targetNode: name, updates: { wxyz, poseUpdateState: "needsUpdate" } }
```

These are accumulated and applied later:
```typescript
const mergedUpdates = {};
for (const [k, v] of Object.entries(updates)) {
  mergedUpdates[k] = { ...currentState[k], ...v };
}
viewer.useSceneTree.setState(mergedUpdates);
```

This updates the SceneNode's **top-level attributes** (`wxyz`, `poseUpdateState`)
but does NOT touch `node.message`. The `message` reference stays the same.

## 4. React Re-render Cascade (Declarative Path)

### Step 1: Zustand notifies subscribers

When `store.setState({ [name]: newNode })` is called, zustand notifies all
subscribers. Each subscriber runs its selector:

- `SceneNodeThreeObject` subscribes via:
  ```typescript
  const message = viewer.useSceneTree((state) => state[props.name]?.message);
  ```
  For Path A: `message` is a new reference → **TRIGGERS RE-RENDER**
  For Path B: `message` is the same reference → **NO RE-RENDER**

- Other nodes' `SceneNodeThreeObject` instances: their selectors return the same
  references → no re-render (good).

### Step 2: SceneNodeThreeObject re-renders

```typescript
const { makeObject, ... } = React.useMemo(
  () => createObjectFactory(message, viewer, ContextBridge),
  [message, viewer, ContextBridge],
);
```

Since `message` changed, `createObjectFactory` runs again. For `BatchedMeshesMessage`:
```typescript
return {
  makeObject: (ref, children) => (
    <BatchedMesh ref={ref} {...message}>
      {children}
    </BatchedMesh>
  ),
};
```

This creates a **new closure** capturing the new `message`.

### Step 3: Object node re-created

```typescript
const objNode = React.useMemo(() => {
  return makeObject(refCallback, children);
}, [makeObject, children]);
```

Since `makeObject` changed, this creates new JSX: `<BatchedMesh {...message}>`.

### Step 4: BatchedMesh re-renders

`BatchedMesh` (`BatchedMesh.tsx`) receives the new message as props:

1. **material useMemo** — checks `message.props.material`, `wireframe`, `opacity`,
   `flat_shading`, `side`. If unchanged → reuses cached material.
2. **geometry useMemo** — checks `message.props.vertices.buffer` and
   `message.props.faces.buffer`. If unchanged → reuses cached geometry.
3. Renders `<BatchedMeshBase>` with the new typed array props.

### Step 5: BatchedMeshBase re-renders

`BatchedMeshBase` (`BatchedMeshBase.tsx`) has **7 useEffect hooks**:

| # | Dependencies | Purpose | Fires on `batched_wxyzs` change? |
|---|---|---|---|
| 1 | `[geometry, lod, material]` | Create InstancedMesh2 | No |
| 2 | `[batched_positions, batched_wxyzs, batched_scales, mesh]` | Update instance transforms | **Yes** |
| 3 | `[clickable, mesh]` | Compute BVH | No |
| 4 | `[batched_colors (broadcast), mesh, batched_positions.byteLength]` | Broadcast colors | No |
| 5 | `[batched_colors (per-instance), mesh]` | Per-instance colors | No |
| 6 | `[opacity, batched_opacities, mesh]` | Per-instance opacity | No |
| 7 | `[cast_shadow, receive_shadow, mesh]` | Shadow settings | No |

Even though only effect #2 fires, React still:
- Re-renders the component (runs the function body)
- Checks all 7 dependency arrays for changes
- Schedules effect #2 for post-commit execution
- Runs effect #2's cleanup (none in this case) then the new effect

### Step 6: useEffect runs updateInstances

```typescript
mesh.updateInstances((obj, index) => {
  // Read position, quaternion, scale from typed arrays
  // Apply to instance transform
});
```

This is the actual Three.js work — iterating over all instances and setting their
transforms on the InstancedMesh2. **The user confirmed this is NOT the bottleneck.**

## 5. Imperative Path in Detail (wxyz)

For comparison, here's what happens when `wxyz` is updated:

1. `SetOrientationMessage` → returns `{ targetNode, updates: { wxyz, poseUpdateState } }`
2. All such returns are accumulated, then applied in a single `setState`:
   ```typescript
   mergedUpdates[name] = { ...currentState[name], wxyz: newWxyz, poseUpdateState: "needsUpdate" }
   ```
3. Zustand notifies subscribers. `SceneNodeThreeObject`'s selector
   `state[name]?.message` returns the **same reference** → **no re-render**.
4. In the **same frame**, `SceneNodeThreeObject`'s `useFrame` (priority -1000) runs:
   ```typescript
   const node = viewer.useSceneTree.getState()[props.name];
   if (node.poseUpdateState == "needsUpdate") {
     updateNodeAttributes(props.name, { poseUpdateState: "updated" });
     objRef.current.quaternion.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
     objRef.current.position.set(position[0], position[1], position[2]);
   }
   ```
5. The Three.js object's quaternion/position are set **directly**. No React involved.

Total cost: one zustand setState (attribute-level, not message-level) + one
`getState()` read in useFrame + direct quaternion/position assignment.

## 6. Why the Declarative Path is Slow

The overhead is NOT from the Three.js operations (confirmed by the user). The
bottleneck is in the React rendering cycle:

1. **Unnecessary re-renders**: Changing ANY prop on a scene node (even just
   `batched_wxyzs`) creates a new `message` reference, which triggers a full
   re-render of `SceneNodeThreeObject` → `createObjectFactory` → child component.

2. **useMemo/useEffect overhead**: Even when most memoized values don't change,
   React still needs to:
   - Run the component function body
   - Check all `useMemo` dependency arrays
   - Check all `useEffect` dependency arrays (7 in BatchedMeshBase alone)
   - Schedule and execute the ones that changed

3. **Object creation churn**: Each re-render creates new closures
   (`makeObject`), new JSX trees, new dependency arrays, etc. This puts pressure
   on the garbage collector.

4. **No granular subscriptions**: `SceneNodeThreeObject` subscribes to the entire
   `message` object. There's no way to subscribe to just `message.props.batched_wxyzs`
   without also getting notified about all other prop changes. (Though in this
   case, the problem is that even a single prop change creates a new `message`
   reference.)

5. **Spread operator overhead**: The triple spread in `updateSceneNodeProps`:
   ```typescript
   { ...node, message: { ...node.message, props: { ...node.message.props, ...updates } } }
   ```
   creates three new objects every update, even if only one field changed.
   For large props objects (like `BatchedMeshesProps` with many fields), this
   is wasteful.

6. **React commit phase**: After computing what changed, React must reconcile
   the virtual DOM diff and commit updates to the real DOM/Three.js scene graph.
   Even if no actual DOM changes occur, the reconciliation work itself has cost.

## 7. Summary: Cost Comparison

| Operation | `wxyz` (imperative) | `batched_wxyzs` (declarative) |
|---|---|---|
| Zustand setState | Top-level attrs only | Full message.props spread |
| React re-renders | 0 | 3+ components |
| useMemo checks | 0 | ~5 |
| useEffect checks | 0 | 7 |
| useEffect executions | 0 | 1 (updateInstances) |
| Three.js work | Direct quaternion set | updateInstances() loop |
| GC pressure | Minimal | New closures, objects, arrays |

The declarative path does orders of magnitude more work than necessary for a
simple typed array prop change.
