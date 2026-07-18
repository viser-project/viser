import * as THREE from "three";
import { toCreasedNormals } from "three-stdlib";

/** Build the geometry for an outline mesh: the parent's geometry as-is when
 * `angle` is 0, else a creased-normals copy the CALLER owns (and must
 * dispose). Owned is derived from identity, never inferred from `angle`:
 * three-stdlib's toCreasedNormals returns its input object unchanged -- and
 * mutates its normal attribute in place -- when the input is already
 * non-indexed, so a non-indexed parent is cloned first to keep the result
 * privately owned and the parent's normals untouched. */
export function buildOutlineGeometry(
  parentGeometry: THREE.BufferGeometry,
  angle: number,
): { geometry: THREE.BufferGeometry; owned: boolean } {
  if (angle === 0) return { geometry: parentGeometry, owned: false };
  const source =
    parentGeometry.index === null ? parentGeometry.clone() : parentGeometry;
  const geometry = toCreasedNormals(source, angle);
  return { geometry, owned: geometry !== parentGeometry };
}
