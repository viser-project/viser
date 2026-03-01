# Bug Fix Report

Three bugs were identified, tested, and fixed in viser's client-side code.

---

## Bug 1: Texture memory leak in `ViserImage`

**File:** `src/viser/client/src/ThreeAssets.tsx`

### Description

The `ViserImage` component creates a new `THREE.Texture` via
`TextureLoader.load` each time the image data changes. The `useEffect` that
handles this has no cleanup function, so the old texture is never disposed. For
applications that stream video or rapidly update images, GPU memory grows
unboundedly — one leaked texture per update.

```tsx
React.useEffect(() => {
    // ...
    new THREE.TextureLoader().load(image_url, (texture) => {
        setImageTexture(texture);  // Old texture is never disposed
        URL.revokeObjectURL(image_url);
    });
}, [message.props._format, message.props._data]);
```

### Test

**File:** `tests/e2e/test_bug_texture_leak.py`

The E2E test creates an image scene node, updates it 10 times with different
pixel data, and tracks texture UUIDs across updates by monkey-patching
`texture.dispose()` to record disposal. After all updates, it asserts that at
most 2 textures remain active (the current one, plus possibly one still loading).
Without the fix, all 11 textures remain active.

### Fix

Added a `textureRef` to track the current texture, and modified the
`TextureLoader.load` callback to dispose the previous texture before setting the
new one. A `cancelled` flag prevents setting state after the effect is cleaned
up, and the cleanup function disposes the current texture on unmount.

```tsx
const textureRef = React.useRef<THREE.Texture | undefined>();

React.useEffect(() => {
    let cancelled = false;
    // ...
    new THREE.TextureLoader().load(image_url, (texture) => {
        if (!cancelled) {
            if (textureRef.current) {
                textureRef.current.dispose();  // Dispose old texture
            }
            textureRef.current = texture;
            setImageTexture(texture);
        } else {
            texture.dispose();  // Cancelled — dispose the just-loaded texture
        }
        URL.revokeObjectURL(image_url);
    });
    return () => { cancelled = true; };
}, [message.props._format, message.props._data]);
```

---

## Bug 2: Hover count stuck when clickable node is hidden while hovered

**File:** `src/viser/client/src/SceneTree.tsx`

### Description

If a clickable node is hidden (via `visible = False`) while the cursor is
hovering over it, the `hoveredElementsCount` is never decremented. The count is
stuck at 1 permanently, and `document.body.style.cursor` stays as `"pointer"`.

The code already handles the case where `clickable` is toggled to `false` while
hovered, but there is no equivalent handling for visibility changes.

### Test

**File:** `tests/e2e/test_bug_hover_visibility.py`

The E2E test creates a large clickable box, moves the mouse to the canvas center
to trigger hover (verifying `hoveredElementsCount > 0` and `cursor === "pointer"`),
then sets `box.visible = False`. It asserts that after hiding,
`hoveredElementsCount` resets to 0 and cursor returns to `"auto"`.

### Fix

Added a check in the `useFrame` hook (which runs every render frame) that
detects when a clickable node's `effectiveVisibility` becomes `false` while
`hoveredRef.current.isHovered` is `true`. When this condition is detected, it
resets the hover state, decrements the count, and restores the cursor.

```tsx
// In useFrame callback, after setting objRef.current.visible:
if (!node.effectiveVisibility && hoveredRef.current.isHovered && clickable) {
    hoveredRef.current.isHovered = false;
    hoveredRef.current.instanceId = null;
    viewerMutable.hoveredElementsCount--;
    if (viewerMutable.hoveredElementsCount === 0) {
        document.body.style.cursor = "auto";
    }
}
```

---

## Bug 3: `ShadowMaterial` never disposed in `BasicMesh`

**File:** `src/viser/client/src/mesh/BasicMesh.tsx`

### Description

The `BasicMesh` component creates a `ShadowMaterial` via `useMemo` when a mesh
has a numeric `receive_shadow` value (float opacity). However, unlike the primary
`geometry` and `material` which both have `useEffect` cleanup calling `.dispose()`,
the `shadowMaterial` has no cleanup at all.

```tsx
const shadowMaterial = React.useMemo(() => {
    if (shadowOpacity === 0.0) return null;
    return new THREE.ShadowMaterial({
        opacity: shadowOpacity,
        color: 0x000000,
        depthWrite: false,
    });
}, [shadowOpacity]);
// No cleanup — old ShadowMaterials are leaked
```

When `shadowOpacity` changes or the component unmounts, old `ShadowMaterial`
instances are never freed.

### Test

**File:** `tests/e2e/test_bug_shadow_material_leak.py`

The E2E test creates and removes meshes with different `receive_shadow` float
values, then tracks material counts in the Three.js scene. After all removals,
it asserts the material count returns to the initial state and no
`ShadowMaterial` instances remain in the scene.

### Fix

Added a `useEffect` cleanup for `shadowMaterial`, following the exact same
pattern used for `geometry` and `material`:

```tsx
// Clean up shadow material when it changes.
React.useEffect(() => {
    return () => {
        if (shadowMaterial) shadowMaterial.dispose();
    };
}, [shadowMaterial]);
```
