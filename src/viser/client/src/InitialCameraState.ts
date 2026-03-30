/**
 * Initial Camera State Store
 *
 * This module manages the initial camera configuration used for "Reset View"
 * functionality. It tracks where each camera property came from (source) to
 * handle priority between different configuration methods.
 *
 * ## Source Priority (lowest to highest)
 * - "default": Built-in defaults in three.js coordinates (no world transform applied)
 * - "message": Server's initial_camera configuration sent via websocket (viser world coords)
 * - "url": URL parameters (highest priority, viser world coords)
 *
 * ## Default Values (in three.js coordinates, Y-up)
 * - position: [3, 3, 3]
 * - lookAt: [0, 0, 0]
 * - up: [0, 1, 0]
 * - fov: 75 degrees (≈1.309 radians, Three.js PerspectiveCamera default)
 * - near: 0.01
 * - far: 1000
 *
 * Default values are in three.js coordinates and work regardless of the scene's
 * up direction (set via set_up_direction()). Values from "message" or "url"
 * sources are in viser world coordinates and are transformed appropriately.
 *
 * When server.initial_camera properties are changed after clients connect,
 * "Reset View" targets are updated without disrupting users' current camera
 * positions.
 */

import React from "react";
import { createStore } from "./store";

/** Source of a camera property value. Priority: default < message < url. */
export type CameraPropertySource = "default" | "message" | "url";

interface InitialCameraProperty<T> {
  value: T;
  source: CameraPropertySource;
}

export interface InitialCameraState {
  position: InitialCameraProperty<[number, number, number]>;
  lookAt: InitialCameraProperty<[number, number, number]>;
  up: InitialCameraProperty<[number, number, number]>;
  fov: InitialCameraProperty<number>;
  near: InitialCameraProperty<number>;
  far: InitialCameraProperty<number>;
}

export interface InitialCameraActions {
  /**
   * Set a camera property. Only updates if the new source has higher or equal
   * priority than the current source. Returns true if the state was updated.
   */
  setPosition: (
    value: [number, number, number],
    source: CameraPropertySource,
  ) => boolean;
  setLookAt: (
    value: [number, number, number],
    source: CameraPropertySource,
  ) => boolean;
  setUp: (
    value: [number, number, number],
    source: CameraPropertySource,
  ) => boolean;
  setFov: (value: number, source: CameraPropertySource) => boolean;
  setNear: (value: number, source: CameraPropertySource) => boolean;
  setFar: (value: number, source: CameraPropertySource) => boolean;
}

/** Priority ordering for camera property sources. */
const SOURCE_PRIORITY: Record<CameraPropertySource, number> = {
  default: 0,
  message: 1,
  url: 2,
};

/** Check if a new source can override the current source. */
function canOverride(
  currentSource: CameraPropertySource,
  newSource: CameraPropertySource,
): boolean {
  return SOURCE_PRIORITY[newSource] >= SOURCE_PRIORITY[currentSource];
}

export interface InitialCameraConfig {
  position: [number, number, number] | null;
  lookAt: [number, number, number] | null;
  up: [number, number, number] | null;
  fov: number | null;
  near: number | null;
  far: number | null;
}

export type UseInitialCamera = ReturnType<typeof useInitialCameraState>;

/**
 * Create the initial camera state store.
 * @param urlParams - Camera properties parsed from URL parameters (null if not provided)
 */
export function useInitialCameraState(urlParams: InitialCameraConfig) {
  return React.useState(() => {
    const store = createStore<InitialCameraState>({
      // Initialize with URL params if available, otherwise defaults.
      position: urlParams.position
        ? { value: urlParams.position, source: "url" as const }
        : { value: [3.0, 3.0, 3.0], source: "default" as const },
      lookAt: urlParams.lookAt
        ? { value: urlParams.lookAt, source: "url" as const }
        : { value: [0, 0, 0], source: "default" as const },
      // Default up is Y-up in three.js coordinates. When source is "default",
      // the world transform is not applied, so this gives correct behavior
      // regardless of set_up_direction().
      up: urlParams.up
        ? { value: urlParams.up, source: "url" as const }
        : { value: [0, 1, 0], source: "default" as const },
      // Default FOV matches Three.js PerspectiveCamera default of 75 degrees.
      fov: urlParams.fov
        ? { value: urlParams.fov, source: "url" as const }
        : { value: (75.0 * Math.PI) / 180.0, source: "default" as const },
      near: urlParams.near
        ? { value: urlParams.near, source: "url" as const }
        : { value: 0.01, source: "default" as const },
      far: urlParams.far
        ? { value: urlParams.far, source: "url" as const }
        : { value: 1000.0, source: "default" as const },
    });

    const actions: InitialCameraActions = {
      setPosition: (value, source) => {
        const current = store.get().position;
        if (!canOverride(current.source, source)) return false;
        store.set({ position: { value, source } });
        return true;
      },
      setLookAt: (value, source) => {
        const current = store.get().lookAt;
        if (!canOverride(current.source, source)) return false;
        store.set({ lookAt: { value, source } });
        return true;
      },
      setUp: (value, source) => {
        const current = store.get().up;
        if (!canOverride(current.source, source)) return false;
        store.set({ up: { value, source } });
        return true;
      },
      setFov: (value, source) => {
        const current = store.get().fov;
        if (!canOverride(current.source, source)) return false;
        store.set({ fov: { value, source } });
        return true;
      },
      setNear: (value, source) => {
        const current = store.get().near;
        if (!canOverride(current.source, source)) return false;
        store.set({ near: { value, source } });
        return true;
      },
      setFar: (value, source) => {
        const current = store.get().far;
        if (!canOverride(current.source, source)) return false;
        store.set({ far: { value, source } });
        return true;
      },
    };

    return { store, actions };
  })[0];
}
