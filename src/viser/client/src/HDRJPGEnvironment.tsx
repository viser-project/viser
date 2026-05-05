/**
 * Custom environment component using HDR JPEG (gainmap) format.
 * This replaces drei's Environment component to use the smaller HDR JPEG files.
 * Fades in the environment map to prevent flickering on first render.
 */

import { useEffect, useState, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { HDRJPGLoader } from "@monogrid/gainmap-js";

interface HDRJPGEnvironmentProps {
  /** Path to the HDR JPEG file. */
  files: string;
  /** Whether to use the HDRI as scene background. */
  background?: boolean;
  /** Blurriness of the background (0 = sharp, 1 = fully blurred). */
  backgroundBlurriness?: number;
  /** Intensity of the background. */
  backgroundIntensity?: number;
  /** Rotation of the background as Euler angles. */
  backgroundRotation?: THREE.Euler;
  /** Intensity of the environment lighting. */
  environmentIntensity?: number;
  /** Rotation of the environment lighting as Euler angles. */
  environmentRotation?: THREE.Euler;
}

// Initial canvas opacity while loading.
const LOADING_OPACITY = 0.05;

export function HDRJPGEnvironment({
  files,
  background = false,
  backgroundBlurriness = 0,
  backgroundIntensity = 1,
  backgroundRotation,
  environmentIntensity = 1,
  environmentRotation,
}: HDRJPGEnvironmentProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  // Track fade-in progress (0 to 1).
  const fadeProgress = useRef(0);
  const isFirstLoad = useRef(true);

  // Set initial canvas opacity while loading.
  useEffect(() => {
    gl.domElement.style.opacity = LOADING_OPACITY.toString();
  }, [gl]);

  // Load the HDR JPEG file.
  useEffect(() => {
    const loader = new HDRJPGLoader(gl);
    let disposed = false;

    loader.load(
      files,
      (result) => {
        if (disposed) {
          result.renderTarget.dispose();
          return;
        }
        const tex = result.renderTarget.texture;
        tex.mapping = THREE.EquirectangularReflectionMapping;

        // Reset fade progress for new texture, but only on first load.
        if (isFirstLoad.current) {
          fadeProgress.current = 0;
          isFirstLoad.current = false;
        } else {
          fadeProgress.current = 1;
        }
        setTexture(tex);

        // Set environment.
        scene.environment = tex;
        scene.environmentIntensity = environmentIntensity;
        if (environmentRotation) {
          scene.environmentRotation = environmentRotation;
        }

        // Set background if enabled.
        if (background) {
          scene.background = tex;
          scene.backgroundBlurriness = backgroundBlurriness;
          scene.backgroundIntensity = backgroundIntensity;
          if (backgroundRotation) {
            scene.backgroundRotation = backgroundRotation;
          }
        }
      },
      undefined,
      (error) => {
        console.error("Failed to load HDR JPEG:", error);
      },
    );

    return () => {
      disposed = true;
    };
  }, [files, gl]);

  // Dispose of previous texture when changed.
  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  // Animate fade-in (only runs while fading).
  useFrame(() => {
    if (!texture || fadeProgress.current >= 1.0) return;

    // Update fade progress.
    fadeProgress.current = Math.min(1, fadeProgress.current + 1.0 / 5.0);
    const fade = fadeProgress.current;

    // Fade canvas opacity from LOADING_OPACITY to 1.
    const canvasOpacity = LOADING_OPACITY + (1 - LOADING_OPACITY) * fade;
    gl.domElement.style.opacity = canvasOpacity.toString();
  });

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      gl.domElement.style.opacity = "1";
      scene.environment = null;
      if (background) {
        scene.background = null;
      }
    };
  }, [gl, scene, background]);

  return null;
}
