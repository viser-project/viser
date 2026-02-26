/**
 * Grid component with fog, shadow, and plane color support.
 *
 * Forked from @react-three/drei's Grid component to add Three.js fog
 * integration, shadow receiving, and integrated plane color rendering.
 * https://github.com/pmndrs/drei
 *
 * MIT License
 * Copyright (c) 2020 react-spring
 */

import * as React from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <shadowmap_pars_vertex>
  #include <logdepthbuf_pars_vertex>

  varying vec3 localPosition;
  varying vec4 worldPosition;

  uniform vec3 worldCamProjPosition;
  uniform vec3 worldPlanePosition;
  uniform float fadeDistance;
  uniform bool infiniteGrid;
  uniform bool followCamera;

  void main() {
    localPosition = position.xzy;
    if (infiniteGrid) localPosition *= 1.0 + fadeDistance;

    worldPosition = modelMatrix * vec4(localPosition, 1.0);
    if (followCamera) {
      worldPosition.xyz += (worldCamProjPosition - worldPlanePosition);
      localPosition = (inverse(modelMatrix) * worldPosition).xyz;
    }

    gl_Position = projectionMatrix * viewMatrix * worldPosition;

    #include <logdepthbuf_vertex>

    // Required by shadowmap_vertex for shadow normal bias.
    vec3 transformedNormal = normalMatrix * vec3(0.0, 0.0, 1.0);
    #include <shadowmap_vertex>

    #ifdef USE_FOG
      vec4 mvPosition = viewMatrix * worldPosition;
      vFogDepth = -mvPosition.z;
    #endif
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <packing>
  #include <fog_pars_fragment>
  #include <bsdfs>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>
  #include <logdepthbuf_pars_fragment>

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
  uniform vec3 planeColor;
  uniform float planeOpacity;
  uniform float shadowOpacity;

  float getGrid(float size, float thickness) {
    vec2 r = localPosition.xz / size;
    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
    float line = min(grid.x, grid.y) + 1.0 - thickness;
    return 1.0 - min(line, 1.0);
  }

  void main() {
    float g1 = getGrid(cellSize, cellThickness);
    float g2 = getGrid(sectionSize, sectionThickness);

    vec3 from = worldCamProjPosition * vec3(fadeFrom);
    float dist = distance(from, worldPosition.xyz);
    float d = 1.0 - min(dist / fadeDistance, 1.0);
    float fade = pow(d, fadeStrength);

    vec3 gridColor = mix(cellColor, sectionColor, min(1.0, sectionThickness * g2));
    float gridAlpha = (g1 + g2) * fade;
    gridAlpha = mix(0.75 * gridAlpha, gridAlpha, g2);

    // Apply tone mapping to grid lines only (plane color should be exact).
    gl_FragColor = vec4(gridColor, 1.0);
    #include <tonemapping_fragment>
    vec3 toneMappedGridColor = gl_FragColor.rgb;

    // Shadow mask: 1.0 = fully lit, 0.0 = fully shadowed.
    // Only show shadows from the top of the grid plane. The position.xzy
    // swizzle in the vertex shader flips the winding order, so
    // gl_FrontFacing is inverted: !gl_FrontFacing corresponds to the top.
    float shadowMask = getShadowMask();
    float shadowAlpha = !gl_FrontFacing ? (1.0 - shadowMask) * shadowOpacity * fade : 0.0;

    // Apply fade to plane opacity.
    float fadedPlaneOpacity = planeOpacity * fade;

    // Composite layers using premultiplied alpha (bottom to top):
    // 1. Plane color
    vec3 premulRgb = planeColor * fadedPlaneOpacity;
    float alpha = fadedPlaneOpacity;
    // 2. Shadow (black) over plane
    premulRgb *= (1.0 - shadowAlpha);
    alpha = shadowAlpha + alpha * (1.0 - shadowAlpha);
    // 3. Grid lines over shaded plane
    premulRgb = toneMappedGridColor * gridAlpha + premulRgb * (1.0 - gridAlpha);
    alpha = gridAlpha + alpha * (1.0 - gridAlpha);

    if (alpha <= 0.0) discard;

    // Convert from premultiplied to straight alpha.
    gl_FragColor = vec4(premulRgb / alpha, alpha);

    #include <logdepthbuf_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

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
  planeColor?: THREE.ColorRepresentation;
  planeOpacity?: number;
  shadowOpacity?: number;
}

const _plane = new THREE.Plane();
const _upVector = new THREE.Vector3(0, 1, 0);
const _zeroVector = new THREE.Vector3(0, 0, 0);

export const Grid = React.forwardRef<THREE.Mesh, GridProps>(function Grid(
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
    planeColor = "#ffffff",
    planeOpacity = 0,
    shadowOpacity = 0,
    ...props
  },
  fRef,
) {
  const ref = React.useRef<THREE.Mesh>(null);
  React.useImperativeHandle(fRef, () => ref.current!, []);

  const material = React.useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.lights,
        THREE.UniformsLib.fog,
        {
          cellSize: { value: 0.5 },
          sectionSize: { value: 1 },
          fadeDistance: { value: 100 },
          fadeStrength: { value: 1 },
          fadeFrom: { value: 1 },
          cellThickness: { value: 0.5 },
          sectionThickness: { value: 1 },
          cellColor: { value: new THREE.Color() },
          sectionColor: { value: new THREE.Color() },
          infiniteGrid: { value: false },
          followCamera: { value: false },
          worldCamProjPosition: { value: new THREE.Vector3() },
          worldPlanePosition: { value: new THREE.Vector3() },
          planeColor: { value: new THREE.Color(1, 1, 1) },
          planeOpacity: { value: 0.0 },
          shadowOpacity: { value: 0.0 },
        },
      ]),
      vertexShader,
      fragmentShader,
      transparent: true,
      lights: true,
      fog: true,
      extensions: { derivatives: true } as any,
    });
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
    material.uniforms.planeColor.value.set(planeColor);
    material.uniforms.planeOpacity.value = planeOpacity;
    material.uniforms.shadowOpacity.value = shadowOpacity;
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
    planeColor,
    planeOpacity,
    shadowOpacity,
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
    <mesh
      ref={ref}
      frustumCulled={false}
      material={material}
      receiveShadow
      {...props}
    >
      <planeGeometry args={args} />
    </mesh>
  );
});
