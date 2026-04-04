/**
 * Component for rendering arrow meshes (shaft + head)
 */
import "./r3f-extend";
import * as React from "react";
import * as THREE from "three";
import { ArrowMessage } from "./WebsocketMessages";
import { normalizeScale } from "./utils/normalizeScale";

// Cache geometries based on parameters.
const shaftGeometryCache = new Map<number, THREE.CylinderGeometry>();
const headGeometryCache = new Map<number, THREE.ConeGeometry>();

function getShaftGeometry(radialSegments: number): THREE.CylinderGeometry {
  if (!shaftGeometryCache.has(radialSegments)) {
    shaftGeometryCache.set(
      radialSegments,
      new THREE.CylinderGeometry(1.0, 1.0, 1.0, radialSegments),
    );
  }
  return shaftGeometryCache.get(radialSegments)!;
}

function getHeadGeometry(radialSegments: number): THREE.ConeGeometry {
  if (!headGeometryCache.has(radialSegments)) {
    headGeometryCache.set(
      radialSegments,
      new THREE.ConeGeometry(1.0, 1.0, radialSegments),
    );
  }
  return headGeometryCache.get(radialSegments)!;
}

/**
 * Compute quaternion that rotates from +Y axis to the given direction.
 * Returns identity quaternion if dir is zero-length (degenerate).
 */
function quaternionFromYToDirection(dir: THREE.Vector3): THREE.Quaternion {
  const up = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  const normalized = dir.normalize();
  if (normalized.lengthSq() === 0) {
    // Degenerate case: zero-length direction, return identity
    return quaternion;
  }
  quaternion.setFromUnitVectors(up, normalized);
  return quaternion;
}

export const Arrows = React.forwardRef<
  THREE.Group,
  ArrowMessage & { children?: React.ReactNode }
>(function Arrows({ props, children }, ref) {
  const { points, colors, shaft_radius, head_radius, head_length, scale } =
    props;

  const s = normalizeScale(scale);

  // Determine if we have uniform color or per-vertex colors.
  const { color, vertexColors } = React.useMemo(() => {
    if (colors.length === 3) {
      // Uniform color: convert RGB uint8 to hex number.
      return {
        color: (colors[0] << 16) | (colors[1] << 8) | colors[2],
        vertexColors: undefined,
      };
    } else {
      // Per-vertex colors.
      return {
        color: undefined,
        vertexColors: colors,
      };
    }
  }, [colors]);

  // Number of arrows is points.length / 6 (each arrow has 2 points * 3 coords).
  const numArrows = points.length / 6;

  // Memoize arrow data computation.
  const arrowData = React.useMemo(() => {
    const data: Array<{
      start: THREE.Vector3;
      end: THREE.Vector3;
      dir: THREE.Vector3;
      headBase: THREE.Vector3;
      length: number;
    }> = [];

    for (let i = 0; i < numArrows; i++) {
      const start = new THREE.Vector3(
        points[i * 6],
        points[i * 6 + 1],
        points[i * 6 + 2],
      );
      const end = new THREE.Vector3(
        points[i * 6 + 3],
        points[i * 6 + 4],
        points[i * 6 + 5],
      );

      const dir = new THREE.Vector3().subVectors(end, start);
      const arrowLength = dir.length();

      // Guard against degenerate zero-length arrows.
      if (arrowLength < 1e-8) {
        dir.set(0, 1, 0); // Default direction if start === end
      } else {
        dir.normalize();
      }

      // Head base is offset from end along the direction, back toward start.
      const headBase = new THREE.Vector3()
        .copy(end)
        .sub(dir.clone().multiplyScalar(head_length));

      data.push({
        start,
        end,
        dir,
        headBase,
        length: arrowLength,
      });
    }

    return data;
  }, [points, numArrows, head_length]);

  // Memoize per-arrow shaft and head materials.
  const shaftMaterials = React.useMemo(() => {
    if (vertexColors) {
      // Per-vertex colors: create array of MeshStandardMaterial, one per arrow.
      const materials: THREE.MeshStandardMaterial[] = [];
      for (let i = 0; i < numArrows; i++) {
        const r = vertexColors[i * 6] / 255;
        const g = vertexColors[i * 6 + 1] / 255;
        const b = vertexColors[i * 6 + 2] / 255;
        materials.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b) }));
      }
      return materials;
    }
    return undefined;
  }, [vertexColors, numArrows]);

  const headMaterials = React.useMemo(() => {
    if (vertexColors) {
      // Per-vertex colors: create array of MeshStandardMaterial, one per arrow.
      const materials: THREE.MeshStandardMaterial[] = [];
      for (let i = 0; i < numArrows; i++) {
        const r = vertexColors[i * 6 + 3] / 255;
        const g = vertexColors[i * 6 + 4] / 255;
        const b = vertexColors[i * 6 + 5] / 255;
        materials.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b) }));
      }
      return materials;
    }
    return undefined;
  }, [vertexColors, numArrows]);

  // Cleanup: dispose materials when they change or component unmounts.
  React.useEffect(() => {
    return () => {
      shaftMaterials?.forEach((m) => m.dispose());
      headMaterials?.forEach((m) => m.dispose());
    };
  }, [shaftMaterials, headMaterials]);

  // Shaft geometry uses a fixed number of radial segments.
  const shaftGeometry = getShaftGeometry(16);
  const headGeometry = getHeadGeometry(16);

  return (
    <group ref={ref}>
      <group scale={s}>
        {arrowData.map((arrow, i) => {
          // Shaft runs from start to headBase.
          // Guard against negative shaft length when head_length >= arrow.length.
          const shaftLength = Math.max(arrow.length - head_length, 0);

          // We need to position and orient the shaft cylinder.
          // Cylinder geometry has height along Y by default.
          // We need to: translate to midpoint of shaft, rotate to align Y with dir.
          const shaftMidpoint = new THREE.Vector3()
            .addVectors(arrow.start, arrow.headBase)
            .multiplyScalar(0.5);
          const shaftQuaternion = quaternionFromYToDirection(arrow.dir);

          // Head (cone) is at the end, pointing in dir direction.
          const headQuaternion = quaternionFromYToDirection(arrow.dir);

          return (
            <group key={i}>
              {/* Shaft (cylinder) */}
              <mesh
                geometry={shaftGeometry}
                position={shaftMidpoint}
                quaternion={shaftQuaternion}
                scale={[shaft_radius, shaftLength, shaft_radius]}
              >
                {vertexColors && shaftMaterials ? (
                  <primitive object={shaftMaterials[i]} attach="material" />
                ) : (
                  <meshStandardMaterial color={color} />
                )}
              </mesh>

              {/* Head (cone) */}
              <mesh
                geometry={headGeometry}
                position={arrow.end}
                quaternion={headQuaternion}
                scale={[head_radius, head_length, head_radius]}
              >
                {vertexColors && headMaterials ? (
                  <primitive object={headMaterials[i]} attach="material" />
                ) : (
                  <meshStandardMaterial color={color} />
                )}
              </mesh>
            </group>
          );
        })}
      </group>
      {children}
    </group>
  );
});