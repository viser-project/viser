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
import { version } from "@react-three/drei/helpers/constants";
import { shaderMaterial } from "@react-three/drei";

export const OutlinesMaterial = /* @__PURE__ */ shaderMaterial(
  {
    screenspace: false as boolean,
    color: /* @__PURE__ */ new THREE.Color("black"),
    opacity: 1,
    thickness: 0.05,
    size: /* @__PURE__ */ new THREE.Vector2(),
  },
  `#include <common>
   #include <morphtarget_pars_vertex>
   #include <skinning_pars_vertex>
   #include <fog_pars_vertex>
   #include <logdepthbuf_pars_vertex>
   uniform float thickness;
   uniform float screenspace;
   uniform vec2 size;
   void main() {
     #if defined (USE_SKINNING)
	     #include <beginnormal_vertex>
       #include <morphnormal_vertex>
       #include <skinbase_vertex>
       #include <skinnormal_vertex>
       #include <defaultnormal_vertex>
     #endif
     #include <begin_vertex>
	   #include <morphtarget_vertex>
	   #include <skinning_vertex>
     #include <project_vertex>
     vec4 tNormal = vec4(normal, 0.0);
     vec4 tPosition = vec4(transformed, 1.0);
     #ifdef USE_INSTANCING
       tNormal = instanceMatrix * tNormal;
       tPosition = instanceMatrix * tPosition;
     #endif
     if (screenspace == 0.0) {
       vec3 newPosition = tPosition.xyz + tNormal.xyz * thickness;
       gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
     } else {
       vec4 clipPosition = projectionMatrix * modelViewMatrix * tPosition;
       vec4 clipNormal = projectionMatrix * modelViewMatrix * tNormal;
       vec2 offset = normalize(clipNormal.xy) * thickness / size * clipPosition.w * 2.0;
       clipPosition.xy += offset;
       gl_Position = clipPosition;
     }
     #include <logdepthbuf_vertex>
     #include <fog_vertex>
   }`,
  `uniform vec3 color;
   uniform float opacity;
   #include <fog_pars_fragment>
   #include <logdepthbuf_pars_fragment>
   void main(){
     gl_FragColor = vec4(color, opacity);
     #include <logdepthbuf_fragment>
     #include <tonemapping_fragment>
     #include <${version >= 154 ? "colorspace_fragment" : "encodings_fragment"}>
     #include <fog_fragment>
   }`,
);

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
    React.useLayoutEffect(() => {
      const group = localRef.current;
      if (!group) return;

      const parent = group.parent as THREE.Mesh &
        THREE.SkinnedMesh &
        THREE.InstancedMesh;
      if (parent && parent.geometry) {
        if (
          oldAngle.current !== angle ||
          oldGeometry.current !== parent.geometry
        ) {
          oldAngle.current = angle;
          oldGeometry.current = parent.geometry;

          // Remove old mesh
          let mesh = group.children[0] as any;
          if (mesh) {
            if (angle) mesh.geometry.dispose();
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
        // Dispose everything on unmount
        const group = localRef.current;
        if (!group) return;

        const mesh = group.children[0] as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.Material
        >;
        if (mesh) {
          if (angle) mesh.geometry.dispose();
          group.remove(mesh);
        }
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
