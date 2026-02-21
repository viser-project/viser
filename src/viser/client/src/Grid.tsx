/**
 * Grid component with fog support.
 *
 * Forked from @react-three/drei's Grid component to add Three.js fog
 * integration via standard shader chunks.
 * https://github.com/pmndrs/drei
 *
 * MIT License
 * Copyright (c) 2020 react-spring
 */

import * as React from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";
import { version } from "@react-three/drei/helpers/constants";

const GridMaterial = /* @__PURE__ */ shaderMaterial(
  {
    cellSize: 0.5,
    sectionSize: 1,
    fadeDistance: 100,
    fadeStrength: 1,
    fadeFrom: 1,
    cellThickness: 0.5,
    sectionThickness: 1,
    cellColor: /* @__PURE__ */ new THREE.Color(),
    sectionColor: /* @__PURE__ */ new THREE.Color(),
    infiniteGrid: false,
    followCamera: false,
    worldCamProjPosition: /* @__PURE__ */ new THREE.Vector3(),
    worldPlanePosition: /* @__PURE__ */ new THREE.Vector3(),
    fogColor: /* @__PURE__ */ new THREE.Color(1, 1, 1),
    fogNear: 0.0,
    fogFar: 1000.0,
  },
  /* glsl */ `
    varying vec3 localPosition;
    varying vec4 worldPosition;

    uniform vec3 worldCamProjPosition;
    uniform vec3 worldPlanePosition;
    uniform float fadeDistance;
    uniform bool infiniteGrid;
    uniform bool followCamera;

    #include <fog_pars_vertex>

    void main() {
      localPosition = position.xzy;
      if (infiniteGrid) localPosition *= 1.0 + fadeDistance;

      worldPosition = modelMatrix * vec4(localPosition, 1.0);
      if (followCamera) {
        worldPosition.xyz += (worldCamProjPosition - worldPlanePosition);
        localPosition = (inverse(modelMatrix) * worldPosition).xyz;
      }

      gl_Position = projectionMatrix * viewMatrix * worldPosition;

      #ifdef USE_FOG
        vec4 mvPosition = viewMatrix * worldPosition;
        vFogDepth = -mvPosition.z;
      #endif
    }
  `,
  /* glsl */ `
    varying vec3 localPosition;
    varying vec4 worldPosition;

    uniform vec3 worldCamProjPosition;
    uniform float cellSize;
    uniform float sectionSize;
    uniform vec3 cellColor;
    uniform vec3 sectionColor;
    uniform float fadeDistance;
    uniform float fadeStrength;
    uniform float fadeFrom;
    uniform float cellThickness;
    uniform float sectionThickness;

    #include <fog_pars_fragment>

    float getGrid(float size, float thickness) {
      vec2 r = localPosition.xz / size;
      vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
      float line = min(grid.x, grid.y) + 1.0 - thickness;
      return 1.0 - min(line, 1.0);
    }

    void main() {
      float g1 = getGrid(cellSize, cellThickness);
      float g2 = getGrid(sectionSize, sectionThickness);

      vec3 from = worldCamProjPosition*vec3(fadeFrom);
      float dist = distance(from, worldPosition.xyz);
      float d = 1.0 - min(dist / fadeDistance, 1.0);
      vec3 color = mix(cellColor, sectionColor, min(1.0, sectionThickness * g2));

      gl_FragColor = vec4(color, (g1 + g2) * pow(d, fadeStrength));
      gl_FragColor.a = mix(0.75 * gl_FragColor.a, gl_FragColor.a, g2);
      if (gl_FragColor.a <= 0.0) discard;

      #include <tonemapping_fragment>
      #include <${version >= 154 ? "colorspace_fragment" : "encodings_fragment"}>
      #include <fog_fragment>
    }
  `,
);

interface GridProps {
  args?: [number, number];
  cellColor?: THREE.ColorRepresentation;
  sectionColor?: THREE.ColorRepresentation;
  cellSize?: number;
  sectionSize?: number;
  followCamera?: boolean;
  infiniteGrid?: boolean;
  fadeDistance?: number;
  fadeStrength?: number;
  fadeFrom?: number;
  cellThickness?: number;
  sectionThickness?: number;
  side?: THREE.Side;
  quaternion?: THREE.Quaternion;
  renderOrder?: number;
}

const _plane = new THREE.Plane();
const _upVector = new THREE.Vector3(0, 1, 0);
const _zeroVector = new THREE.Vector3(0, 0, 0);

export const Grid = React.forwardRef<THREE.Mesh, GridProps>(
  (
    {
      args,
      cellColor = "#000000",
      sectionColor = "#2080ff",
      cellSize = 0.5,
      sectionSize = 1,
      followCamera = false,
      infiniteGrid = false,
      fadeDistance = 100,
      fadeStrength = 1,
      fadeFrom = 1,
      cellThickness = 0.5,
      sectionThickness = 1,
      side = THREE.BackSide,
      ...props
    },
    fRef,
  ) => {
    const ref = React.useRef<THREE.Mesh>(null);
    React.useImperativeHandle(fRef, () => ref.current!, []);

    const material = React.useMemo(() => {
      return new GridMaterial({
        transparent: true,
        side,
        fog: true,
      } as any);
    }, []);

    // Update material uniforms when props change.
    React.useEffect(() => {
      material.uniforms.cellSize.value = cellSize;
      material.uniforms.sectionSize.value = sectionSize;
      material.uniforms.cellColor.value.set(cellColor);
      material.uniforms.sectionColor.value.set(sectionColor);
      material.uniforms.cellThickness.value = cellThickness;
      material.uniforms.sectionThickness.value = sectionThickness;
      material.uniforms.fadeDistance.value = fadeDistance;
      material.uniforms.fadeStrength.value = fadeStrength;
      material.uniforms.fadeFrom.value = fadeFrom;
      material.uniforms.infiniteGrid.value = infiniteGrid;
      material.uniforms.followCamera.value = followCamera;
      material.side = side;
      material.needsUpdate = true;
    }, [
      material,
      cellSize,
      sectionSize,
      cellColor,
      sectionColor,
      cellThickness,
      sectionThickness,
      fadeDistance,
      fadeStrength,
      fadeFrom,
      infiniteGrid,
      followCamera,
      side,
    ]);

    useFrame((state) => {
      const mesh = ref.current;
      if (!mesh) return;
      _plane
        .setFromNormalAndCoplanarPoint(_upVector, _zeroVector)
        .applyMatrix4(mesh.matrixWorld);
      _plane.projectPoint(
        state.camera.position,
        material.uniforms.worldCamProjPosition.value,
      );
      material.uniforms.worldPlanePosition.value
        .set(0, 0, 0)
        .applyMatrix4(mesh.matrixWorld);
    });

    return (
      <mesh ref={ref} frustumCulled={false} material={material} {...props}>
        <planeGeometry args={args} />
      </mesh>
    );
  },
);
