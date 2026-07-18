import * as THREE from "three";

/**
 * Declarative, in-place sync of a persistent THREE.BufferGeometry.
 *
 * Reusing GPU buffers across data updates matters because three.js tracks each
 * attribute's GL buffer in a WeakMap keyed by the attribute object. Two failure
 * modes bite naive update code:
 *
 *   1. `setAttribute(name, new BufferAttribute(...))` on every update orphans
 *      the old attribute's GL buffer -- three never calls `gl.deleteBuffer` on a
 *      replaced attribute, so it leaks until (and only if) the JS GC reclaims
 *      the wrapper. For a streaming source that's megabytes of GPU memory leaked
 *      per update and eventual WebGL context loss.
 *
 *   2. Swapping `attribute.array` to a DIFFERENT-length array and bumping
 *      `needsUpdate` makes three throw on the next render: "THREE.WebGLAttributes:
 *      The size of the buffer attribute's array buffer does not match the
 *      original size. Resizing buffer attributes is not supported." (Resizing a
 *      live GL buffer in place is genuinely unsupported.)
 *
 * `syncBufferGeometry` threads the needle:
 *
 *   - Fast path (layout unchanged -- same typed-array kind, length, itemSize,
 *     float16-ness): swap the backing array and bump `needsUpdate`. three
 *     re-uploads via `bufferSubData` into the SAME GL buffer. No allocation, no
 *     leak, no throw.
 *
 *   - Realloc path (first call, length change, or precision change): call
 *     `geometry.dispose()` once. That deletes every attribute's GL buffer AND
 *     unregisters the attributes (see three's WebGLGeometries.onGeometryDispose
 *     -> WebGLAttributes.remove), so the next render allocates fresh buffers at
 *     the new size. The whole-geometry dispose is deliberate: the only leak-free
 *     way to free a single attribute's GL buffer is to dispose the geometry that
 *     owns it. We then attach fresh attributes for everything we were given.
 *
 * The fast path is the zero-cost case we optimize for -- a same-size streaming
 * update touches no GPU allocator and no JS heap beyond a `needsUpdate` flag.
 */

export type SyncTypedArray =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

export interface AttributeSpec {
  /**
   * Backing data. For float16, pass a Uint16Array of packed half-float bits and
   * set `float16: true`.
   */
  array: SyncTypedArray;
  itemSize: number;
  normalized?: boolean;
  /** Treat a Uint16Array as packed half-floats (THREE.Float16BufferAttribute). */
  float16?: boolean;
}

/**
 * Can `existing` be reused in place for `spec`, or does its GL buffer have to be
 * reallocated? Reusable only when nothing about the buffer's GPU layout changes.
 */
function layoutMatches(
  existing: THREE.BufferAttribute,
  spec: AttributeSpec,
): boolean {
  const existingIsF16 =
    (existing as { isFloat16BufferAttribute?: boolean })
      .isFloat16BufferAttribute ?? false;
  return (
    existing.array.constructor === spec.array.constructor &&
    existing.array.length === spec.array.length &&
    existing.itemSize === spec.itemSize &&
    existingIsF16 === (spec.float16 ?? false)
  );
}

function makeAttribute(spec: AttributeSpec): THREE.BufferAttribute {
  if (spec.float16) {
    // Note: Float16BufferAttribute copies into a fresh Uint16Array internally.
    return new THREE.Float16BufferAttribute(
      spec.array as Uint16Array,
      spec.itemSize,
      spec.normalized,
    );
  }
  return new THREE.BufferAttribute(spec.array, spec.itemSize, spec.normalized);
}

/**
 * Sync a persistent BufferGeometry's attributes (and optional index) to new
 * data, reusing GL buffers in place when the layout is unchanged. See the file
 * header for the full rationale.
 *
 * Returns true if a reallocation occurred. Callers that rely on frustum culling
 * or raycasting should recompute bounding volumes / vertex normals when this
 * returns true (or whenever data moves) -- in-place updates leave the cached
 * boundingSphere/boundingBox stale.
 */
export function syncBufferGeometry(
  geometry: THREE.BufferGeometry,
  attributes: Record<string, AttributeSpec>,
  index?: SyncTypedArray,
): boolean {
  const names = Object.keys(attributes);

  // Phase 1: decide whether anything needs reallocation. This is geometry-wide
  // because freeing a single attribute's GL buffer leak-free requires disposing
  // the geometry that owns it -- which frees all of them at once.
  let needsRealloc = false;
  for (const name of names) {
    const existing = geometry.getAttribute(name) as
      THREE.BufferAttribute | undefined;
    if (existing === undefined || !layoutMatches(existing, attributes[name])) {
      needsRealloc = true;
      break;
    }
  }
  if (!needsRealloc && index !== undefined) {
    const existingIndex = geometry.getIndex();
    if (
      existingIndex === null ||
      existingIndex.array.constructor !== index.constructor ||
      existingIndex.array.length !== index.length
    ) {
      needsRealloc = true;
    }
  }

  if (needsRealloc) {
    // Free every existing GL buffer (a no-op before the first render) and
    // unregister the attributes, so the next render allocates fresh buffers at
    // the new size. Avoids both the resize throw and the orphaned-buffer leak.
    geometry.dispose();
    for (const name of names) {
      geometry.setAttribute(name, makeAttribute(attributes[name]));
    }
    if (index !== undefined) {
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
    }
  } else {
    // Fast path: same layout, so reuse the existing GL buffers. Swapping the
    // array reference is zero-copy; `needsUpdate` bumps the version so three
    // re-uploads via bufferSubData. Length is unchanged here, so `count` (a
    // plain field set at construction) stays correct.
    for (const name of names) {
      const spec = attributes[name];
      const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
      attr.array = spec.array;
      attr.normalized = spec.normalized ?? false;
      attr.needsUpdate = true;
    }
    if (index !== undefined) {
      const attr = geometry.getIndex()!;
      attr.array = index;
      attr.needsUpdate = true;
    }
  }
  return needsRealloc;
}
