import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  Color,
  Material,
  Mesh,
  Object3D,
  ShaderChunk,
  Vector3,
  Vector3Tuple,
} from "three";
import { CSM, CSMParameters } from "./csm/CSM";
// @ts-ignore
import { CSMHelper } from "./csm/CSMHelper";

interface CsmDirectionalLightProps extends Omit<
  CSMParameters,
  "lightDirection" | "camera" | "parent"
> {
  fade?: boolean;
  position?: Vector3Tuple; // Position of the light
  color?: number;
  castShadow?: boolean;
  debug?: boolean; // Show CSM cascade visualization
}

// Store original shader chunks to restore them later.
let originalLightsFragmentBegin = "";
let originalLightsParsBegin = "";
let activeCSMInstances = 0;

// This is loosely adapted from @itsdouges in https://github.com/StrandedKitty/three-csm/issues/22.
class CSMProxy {
  instance: CSM | undefined;
  args: CSMParameters;

  constructor(args: CSMParameters) {
    this.args = args;

    // Save original shader chunks on first creation if they haven't been saved yet.
    if (activeCSMInstances === 0) {
      originalLightsFragmentBegin = ShaderChunk.lights_fragment_begin;
      originalLightsParsBegin = ShaderChunk.lights_pars_begin;
    }
  }

  attach() {
    if (!this.instance) {
      this.instance = new CSM(this.args);
      activeCSMInstances++;
    }
  }

  dispose() {
    if (this.instance) {
      // Make sure to call remove() to clean up all lights from the scene.
      this.instance.remove();
      this.instance.dispose();
      this.instance = undefined;

      // Decrement the active instances counter
      activeCSMInstances--;

      // Only restore original shader chunks when the last instance is disposed
      if (activeCSMInstances === 0) {
        ShaderChunk.lights_fragment_begin = originalLightsFragmentBegin;
        ShaderChunk.lights_pars_begin = originalLightsParsBegin;
      }
    }
  }
}

// Utility function to update materials.
function updateMaterialsInScene(scene: Object3D): void {
  scene.traverse((object: Object3D) => {
    const mesh = object as Mesh;
    if (mesh.isMesh && mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat: Material) => {
          mat.needsUpdate = true;
        });
      } else {
        mesh.material.needsUpdate = true;
      }
    }
  });
}

// Modified approach that uses conditional rendering with proper mount/unmount.
export function CsmDirectionalLight({
  maxFar = 20,
  shadowMapSize = 1024,
  lightIntensity = 0.25,
  cascades = 3,
  fade = true,
  position = [0, 0, 0],
  shadowBias = -0.00001,
  lightFar = 2000,
  lightMargin = 200,
  lightNear = 0.0001,
  mode = "practical",
  color = 0xffffff,
  castShadow = true,
  debug = false,
}: CsmDirectionalLightProps) {
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

  // Shadow-casting implementation with CSM.
  return (
    <ShadowCsmLight
      key="csm-shadow" // Force unmount/remount when toggling.
      maxFar={maxFar}
      shadowMapSize={shadowMapSize}
      // One light is made for each cascade.
      lightIntensity={lightIntensity / cascades}
      cascades={cascades}
      fade={fade}
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
function ShadowCsmLight({
  maxFar,
  shadowMapSize,
  lightIntensity,
  cascades,
  fade,
  position = [0, -1, 0],
  shadowBias,
  lightFar,
  lightMargin,
  lightNear,
  mode,
  color,
  debug = false,
}: Omit<CsmDirectionalLightProps, "castShadow">) {
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

  // Calculate light direction from position (pointing toward origin)
  const lightDirection = useMemo(() => {
    return new Vector3(-position[0], -position[1], -position[2]).normalize();
  }, [position]);

  const dummyGroupRef = useRef<THREE.Group>(null);
  const helperRef = useRef<any | null>(null);

  // Pre-create reusable Vector3 instances to avoid creating new ones in useFrame
  const worldPosition = useMemo(() => new Vector3(), []);
  const origin = useMemo(() => new Vector3(0, 0, 0), []);
  const direction = useMemo(() => new Vector3(), []);

  // Create the CSM proxy with initial light direction
  const proxyInstance = useMemo(() => {
    return new CSMProxy({
      camera,
      cascades,
      lightDirection: lightDirection.clone(), // Clone to avoid mutation issues
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
  }, [
    camera,
    scene,
    cascades,
    lightDirection,
    lightFar,
    lightIntensity,
    lightMargin,
    lightNear,
    maxFar,
    mode,
    shadowBias,
    shadowMapSize,
  ]);

  // Create a memoized color to avoid unnecessary recreations
  const threeColor = useMemo(() => new Color(color), [color]);

  // Update light color when the color changes
  useEffect(() => {
    if (proxyInstance.instance) {
      proxyInstance.instance.lights.forEach((light) => {
        light.color = threeColor;
      });
      proxyInstance.instance.fade = fade ?? false;
    }
  }, [proxyInstance, threeColor, fade]);

  // Update CSM on each frame and handle light direction changes.
  useFrame(() => {
    if (!proxyInstance.instance || !dummyGroupRef.current) return;

    // Get the world position of the dummy group
    dummyGroupRef.current.getWorldPosition(worldPosition);

    // Calculate direction from world position to origin
    direction.subVectors(origin, worldPosition).normalize();

    // Update the CSM light direction
    proxyInstance.instance.lightDirection.copy(direction);

    // Update CSM
    proxyInstance.instance.update();

    // Update helper visualization if it exists.
    if (helperRef.current) {
      helperRef.current.update();
    }
  });

  // Force a scene material update to ensure shadow changes take effect immediately.
  useEffect(() => {
    // Mark all materials to be updated when the component mounts.
    updateMaterialsInScene(scene);

    return () => {
      // Force renderer state to reset on unmount.
      requestAnimationFrame(() => {
        // Mark all materials as needing update when unmounting.
        updateMaterialsInScene(scene);
      });
    };
  }, [scene]);

  // Create/attach the CSM instance.
  useEffect(() => {
    proxyInstance.attach();

    // Set colors on mount.
    if (proxyInstance.instance) {
      proxyInstance.instance.lights.forEach((light) => {
        light.color = threeColor;
      });
    }

    // Create debug helper if debug mode is enabled.
    if (debug && proxyInstance.instance) {
      const helper = new CSMHelper(proxyInstance.instance);
      helper.displayFrustum = true;
      helper.displayPlanes = true;
      helper.displayShadowBounds = true;
      helper.updateVisibility();
      scene.add(helper);
      helperRef.current = helper;
    }

    return () => {
      // Clean up helper if it exists.
      if (helperRef.current) {
        scene.remove(helperRef.current);
        // Dispose of helper geometries and materials.
        helperRef.current.traverse((child: THREE.Object3D) => {
          if ((child as THREE.Mesh).geometry) {
            (child as THREE.Mesh).geometry.dispose();
          }
          if ((child as THREE.Mesh).material) {
            const material = (child as THREE.Mesh).material;
            if (Array.isArray(material)) {
              material.forEach((m) => m.dispose());
            } else {
              material.dispose();
            }
          }
        });
        helperRef.current = null;
      }
      proxyInstance.dispose();
    };
  }, [proxyInstance, threeColor, debug, scene]);

  return (
    <>
      <group position={position} ref={dummyGroupRef} />
    </>
  );
}
