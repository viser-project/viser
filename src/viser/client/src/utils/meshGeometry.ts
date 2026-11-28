import * as THREE from "three";

/** Equivalent to `THREE.BufferGeometry.computeVertexNormals()` for indexed
 * geometries, but several times faster. Returns area-weighted vertex normals.
 *
 * @param out - Optional output array, for reuse. */
export function computeVertexNormals(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  out?: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  const normals = out ?? new Float32Array(positions.length);
  if (out !== undefined) normals.fill(0);

  // Accumulate in double precision, like three.js does within each step.
  const numIndices = index.length - (index.length % 3);
  for (let i = 0; i < numIndices; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cbx = positions[c] - bx;
    const cby = positions[c + 1] - by;
    const cbz = positions[c + 2] - bz;
    const abx = positions[a] - bx;
    const aby = positions[a + 1] - by;
    const abz = positions[a + 2] - bz;
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }

  for (let i = 0; i + 2 < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 0) {
      normals[i] = x / length;
      normals[i + 1] = y / length;
      normals[i + 2] = z / length;
    }
  }
  return normals;
}

/** Equivalent to `THREE.BufferGeometry.computeBoundingSphere()`, but several
 * times faster. */
export function computeBoundingSphere(
  positions: ArrayLike<number>,
  out: THREE.Sphere = new THREE.Sphere(),
): THREE.Sphere {
  if (positions.length === 0) return out.makeEmpty();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  let maxDistanceSq = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq > maxDistanceSq) maxDistanceSq = distanceSq;
  }
  out.center.set(cx, cy, cz);
  out.radius = Math.sqrt(maxDistanceSq);
  return out;
}

/** Indexed geometry with vertex normals and a bounding sphere. */
export function makeMeshGeometry(
  vertices: Float32Array,
  faces: Uint32Array,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(computeVertexNormals(vertices, faces), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(faces, 1));
  geometry.boundingSphere = computeBoundingSphere(vertices);
  return geometry;
}
