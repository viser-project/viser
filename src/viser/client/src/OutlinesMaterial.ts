import * as THREE from "three";
import { shaderMaterial } from "@react-three/drei";
import { version } from "@react-three/drei/helpers/constants";

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
     #include <fog_vertex>
   }`,
  `uniform vec3 color;
   uniform float opacity;
   #include <fog_pars_fragment>
   void main(){
     gl_FragColor = vec4(color, opacity);
     #include <tonemapping_fragment>
     #include <${version >= 154 ? "colorspace_fragment" : "encodings_fragment"}>
     #include <fog_fragment>
   }`,
);
