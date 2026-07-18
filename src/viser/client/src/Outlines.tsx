/** This is a modified version of drei's <Outlines /> component. The primary
 * change is to add support for ref forwarding. https://github.com/pmndrs/drei
 * */

import * as THREE from "three";
import * as React from "react";
import {
  applyProps,
  ReactThreeFiber,
  useThree,
  ThreeElement,
} from "@react-three/fiber";
import { toCreasedNormals } from "three-stdlib";
import { OutlinesMaterial } from "./OutlinesMaterial";

type OutlinesProps = ThreeElement<typeof THREE.Group> & {
  /** Outline color, default: black */
  color?: ReactThreeFiber.Color;
  /** Line thickness is independent of zoom, default: false */
  screenspace?: boolean;
  /** Outline opacity, default: 1 */
  opacity?: number;
  /** Outline transparency, default: false */
  transparent?: boolean;
  /** Outline thickness, default 0.05 */
  thickness?: number;
  /** Geometry crease angle (0 === no crease), default: Math.PI */
  angle?: number;
  toneMapped?: boolean;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  renderOrder?: number;
};

export const Outlines = React.forwardRef<THREE.Group, OutlinesProps>(
  function Outlines(
    {
      color = "black",
      opacity = 1,
      transparent = false,
      screenspace = false,
      toneMapped = true,
      polygonOffset = false,
      polygonOffsetFactor = 0,
      renderOrder = 0,
      thickness = 0.05,
      angle = Math.PI,
      ...props
    },
    ref,
  ) {
    const localRef = React.useRef<THREE.Group | null>(null);

    const [material] = React.useState(
      () => new OutlinesMaterial({ side: THREE.BackSide, fog: true }),
    );
    const gl = useThree((state) => state.gl);
    const contextSize = gl.getDrawingBufferSize(new THREE.Vector2());

    const oldAngle = React.useRef(0);
    const oldGeometry = React.useRef<THREE.BufferGeometry>();
    const oldPosition = React.useRef<THREE.BufferAttribute>();
    const oldPositionVersion = React.useRef(-1);
    // The creased clone WE own for the current outline mesh, or null when the
    // mesh shares the parent's geometry. Recording the disposable resource
    // itself is what makes every dispose site correct by construction: gating
    // on the current `angle` prop was the original bug (PI->0 leaked the old
    // clone, 0->PI disposed the parent's live shared geometry), and the
    // unmount cleanup cannot re-derive the mesh from localRef -- React
    // detaches the ref (-> null) before passive cleanups run, so a
    // `localRef.current.children[0]` lookup there is always null and the
    // dispose would silently never happen (leaking the clone once per
    // unmount -- every hover cycle for unmountOnHide gizmos).
    const ownedGeometryRef = React.useRef<THREE.BufferGeometry | null>(null);
    React.useLayoutEffect(() => {
      const group = localRef.current;
      if (!group) return;

      const parent = group.parent as THREE.Mesh &
        THREE.SkinnedMesh &
        THREE.InstancedMesh;
      if (parent && parent.geometry) {
        // The parent's geometry can be updated in place (see
        // bufferGeometrySync), so geometry identity alone isn't enough to
        // detect changes. When `angle` is set we render a creased *clone* of
        // the geometry, which goes stale unless we also watch the position
        // attribute's identity (replaced on realloc) and version (bumped by
        // needsUpdate on in-place writes). When `angle` is unset the outline
        // shares the parent's geometry object, so updates flow through and
        // no rebuild is needed.
        const position = parent.geometry.attributes
          .position as THREE.BufferAttribute;
        if (
          oldAngle.current !== angle ||
          oldGeometry.current !== parent.geometry ||
          (angle !== 0 &&
            position !== undefined &&
            (oldPosition.current !== position ||
              oldPositionVersion.current !== position.version))
        ) {
          oldAngle.current = angle;
          oldGeometry.current = parent.geometry;
          oldPosition.current = position;
          oldPositionVersion.current = position?.version ?? -1;

          // Remove the old mesh, freeing the creased clone if we own one
          // (never the parent's shared geometry; see ownedGeometryRef above).
          let mesh = group.children[0] as any;
          if (mesh) {
            ownedGeometryRef.current?.dispose();
            ownedGeometryRef.current = null;
            group.remove(mesh);
          }

          if (parent.skeleton) {
            mesh = new THREE.SkinnedMesh();
            mesh.material = material;
            mesh.bind(parent.skeleton, parent.bindMatrix);
            group.add(mesh);
          } else if (parent.isInstancedMesh) {
            mesh = new THREE.InstancedMesh(
              parent.geometry,
              material,
              parent.count,
            );
            mesh.instanceMatrix = parent.instanceMatrix;
            group.add(mesh);
          } else {
            mesh = new THREE.Mesh();
            mesh.material = material;
            group.add(mesh);
          }
          mesh.geometry = angle
            ? toCreasedNormals(parent.geometry, angle)
            : parent.geometry;
          ownedGeometryRef.current = angle !== 0 ? mesh.geometry : null;
        }
      }
    });

    React.useLayoutEffect(() => {
      const group = localRef.current;
      if (!group) return;

      const mesh = group.children[0] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.Material
      >;
      if (mesh) {
        mesh.renderOrder = renderOrder;
        applyProps(mesh.material as any, {
          transparent,
          thickness,
          color,
          opacity,
          size: contextSize,
          screenspace,
          toneMapped,
          polygonOffset,
          polygonOffsetFactor,
        });
      }
    });

    React.useEffect(() => {
      return () => {
        // Dispose everything on unmount, reading only what was recorded at
        // build time (see ownedGeometryRef above): localRef is already null
        // here, and the first-render `angle` closure capture is stale on
        // flips.
        material.dispose();
        ownedGeometryRef.current?.dispose();
        ownedGeometryRef.current = null;
      };
    }, []);

    return (
      <group
        ref={(obj) => {
          localRef.current = obj;
          if (typeof ref === "function") ref(obj!);
          else if (ref) ref.current = obj;
        }}
        {...props}
      />
    );
  },
);
