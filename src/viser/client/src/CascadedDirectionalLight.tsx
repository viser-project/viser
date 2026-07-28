import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Color, Matrix4, Vector3, Vector3Tuple } from "three";
import { ShadowCascades, ShadowCascadesParams } from "./shadows/ShadowCascades";
// @ts-ignore
import { CascadeHelper } from "./shadows/CascadeHelper";

interface CascadedDirectionalLightProps extends Omit<
  ShadowCascadesParams,
  "lightDirection" | "camera" | "parent"
> {
  position?: Vector3Tuple; // Position of the light
  color?: number;
  castShadow?: boolean;
  debug?: boolean; // Show cascade visualization
}

export function CascadedDirectionalLight({
  maxFar = 20,
  shadowMapSize = 1024,
  lightIntensity = 0.25,
  cascades = 3,
  position = [0, 0, 0],
  shadowBias = -0.00001,
  lightFar = 2000,
  lightMargin = 200,
  lightNear = 0.0001,
  mode = "practical",
  color = 0xffffff,
  castShadow = true,
  debug = false,
}: CascadedDirectionalLightProps) {
  // Standard directional light for the non-shadow case.
  if (!castShadow) {
    return (
      <directionalLight
        intensity={lightIntensity}
        position={position}
        color={color !== undefined ? new Color(color) : undefined}
      />
    );
  }

  // Shadow-casting implementation with approximate cascaded shadows; see
  // the note in shadows/ShadowCascades.js for what this is and isn't.
  return (
    <CascadedShadowLight
      key="cascaded-shadow" // Force unmount/remount when toggling.
      maxFar={maxFar}
      shadowMapSize={shadowMapSize}
      // One light is made for each cascade. All cascade lights illuminate
      // every fragment (see the note in shadows/ShadowCascades.js), so we split the
      // intensity between them to keep the total unchanged.
      lightIntensity={lightIntensity / cascades}
      cascades={cascades}
      position={position}
      shadowBias={shadowBias}
      lightFar={lightFar}
      lightMargin={lightMargin}
      lightNear={lightNear}
      mode={mode}
      color={color}
      debug={debug}
    />
  );
}

// Separate component for the shadow-casting implementation to avoid hook conditionals.
function CascadedShadowLight({
  maxFar,
  shadowMapSize,
  lightIntensity,
  cascades,
  position = [0, -1, 0],
  shadowBias,
  lightFar,
  lightMargin,
  lightNear,
  mode,
  color,
  debug = false,
}: Omit<CascadedDirectionalLightProps, "castShadow">) {
  const camera = useThree((three) => three.camera);
  const gl = useThree((three) => three.gl);
  const reversedDepth = gl.capabilities.reversedDepthBuffer;

  // Get the scene object from the three fiber context.
  // This is a hack, see: https://github.com/pmndrs/react-three-fiber/issues/2725
  const { scene: scene_ } = useThree();
  const scene = useMemo(() => {
    let object: THREE.Object3D | null = scene_;
    while (object) {
      if (object instanceof THREE.Scene) return object;
      object = object.parent;
    }
    throw new Error("Could not find scene object in r3f context!");
  }, [scene_]);

  const shadowCascadesRef = useRef<ShadowCascades | null>(null);
  const dummyGroupRef = useRef<THREE.Group>(null);
  const helperRef = useRef<any | null>(null);

  // Pre-create reusable instances to avoid creating new ones in useFrame.
  const worldPosition = useMemo(() => new Vector3(), []);
  const origin = useMemo(() => new Vector3(0, 0, 0), []);
  const direction = useMemo(() => new Vector3(), []);
  const prevProjection = useMemo(() => new Matrix4(), []);

  const threeColor = useMemo(() => new Color(color), [color]);
  // Track the latest color in a ref so the CSM creation effect can apply it
  // without taking threeColor as a dependency (a color change alone shouldn't
  // recreate the shadow maps).
  const colorRef = useRef(threeColor);
  colorRef.current = threeColor;

  // Depend on the position components rather than the array, which is
  // typically a new identity on every render.
  const [positionX, positionY, positionZ] = position;

  // Create the ShadowCascades instance.
  useEffect(() => {
    const lightDirection = new Vector3(-positionX, -positionY, -positionZ);
    // A light at the world origin has no defined "toward origin" direction;
    // fall back to pointing straight down.
    if (lightDirection.lengthSq() === 0.0) lightDirection.y = -1;
    lightDirection.normalize();

    const shadowCascades = new ShadowCascades({
      camera,
      cascades,
      lightDirection,
      lightFar,
      lightIntensity,
      lightMargin,
      lightNear,
      maxFar,
      mode,
      parent: scene,
      shadowBias,
      shadowMapSize,
      reversedDepth,
    });
    shadowCascades.lights.forEach((light) => {
      light.color = colorRef.current;
    });
    prevProjection.copy(camera.projectionMatrix);
    shadowCascadesRef.current = shadowCascades;

    // Create debug helper if debug mode is enabled.
    if (debug) {
      const helper = new CascadeHelper(shadowCascades);
      helper.displayFrustum = true;
      helper.displayPlanes = true;
      helper.displayShadowBounds = true;
      helper.updateVisibility();
      scene.add(helper);
      helperRef.current = helper;
    }

    return () => {
      if (helperRef.current) {
        scene.remove(helperRef.current);
        helperRef.current.dispose();
        helperRef.current = null;
      }
      shadowCascades.remove();
      shadowCascades.dispose();
      shadowCascadesRef.current = null;
    };
  }, [
    camera,
    scene,
    cascades,
    positionX,
    positionY,
    positionZ,
    lightFar,
    lightIntensity,
    lightMargin,
    lightNear,
    maxFar,
    mode,
    shadowBias,
    shadowMapSize,
    reversedDepth,
    debug,
    prevProjection,
  ]);

  // Update light color when the color changes, without recreating the
  // ShadowCascades instance. Runs after the creation effect above, so the
  // instance exists.
  useEffect(() => {
    if (shadowCascadesRef.current) {
      shadowCascadesRef.current.lights.forEach((light) => {
        light.color = threeColor;
      });
    }
  }, [threeColor]);

  // Update the cascades on each frame and handle light direction changes.
  useFrame(() => {
    const shadowCascades = shadowCascadesRef.current;
    if (shadowCascades === null || dummyGroupRef.current === null) return;

    // Get the world position of the dummy group; the light points from there
    // toward the origin.
    dummyGroupRef.current.getWorldPosition(worldPosition);
    direction.subVectors(origin, worldPosition);
    if (direction.lengthSq() === 0.0) direction.y = -1;
    direction.normalize();
    shadowCascades.lightDirection.copy(direction);

    // Cascade splits and shadow bounds are derived from the camera's
    // projection; refresh them when it changes (window resize, fov/near/far
    // updates).
    if (!prevProjection.equals(camera.projectionMatrix)) {
      prevProjection.copy(camera.projectionMatrix);
      shadowCascades.updateFrustums();
    }

    shadowCascades.update();

    // Update helper visualization if it exists.
    if (helperRef.current) {
      helperRef.current.update();
    }
  });

  return (
    <>
      <group position={position} ref={dummyGroupRef} />
    </>
  );
}
