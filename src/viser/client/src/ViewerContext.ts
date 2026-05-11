import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./App.css";
import "./index.css";

import { CameraControls } from "@react-three/drei";
import * as THREE from "three";
import React from "react";
import { useSceneTreeState } from "./SceneTreeState";

import { UseGui } from "./ControlPanel/GuiState";
import { useInitialCameraState } from "./InitialCameraState";
import { useEnvironmentState } from "./EnvironmentState";
import { useDevSettingsStore } from "./DevSettingsStore";
import { GetRenderRequestMessage, Message } from "./WebsocketMessages";
import { KeyModifier } from "./dragUtils";
import { CameraControlOwner } from "./inputManager/cameraControlOwner";
import { CursorController } from "./inputManager/cursorController";
import type { InputManager } from "./inputManager/InputManager";

export type NodePoseEntry = {
  wxyz: [number, number, number, number];
  position: [number, number, number];
  poseUpdateState: "updated" | "needsUpdate" | "waitForMakeObject";
};

export type NodePoseDataMap = {
  [name: string]: NodePoseEntry | undefined;
};

// Type definitions for all mutable state.
export type ViewerMutable = {
  // Function references.
  sendMessage: (message: Message) => void;
  sendCamera: (() => void) | null;
  resetCameraPose: ((animate: boolean) => void) | null;

  // DOM/Three.js references.
  canvas: HTMLCanvasElement | null;
  canvas2d: HTMLCanvasElement | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  backgroundMaterial: THREE.ShaderMaterial | null;
  cameraControl: CameraControls | null;
  /** Single writer for ``cameraControl.enabled``. Every disable/
   * enable site in the client routes through this owner instead of
   * touching the bool directly; it tracks gesture-derived state plus
   * any active leases (modal overlays, in-flight drags) and reapplies
   * to the current instance on camera-type swap. See
   * ``inputManager/cameraControlOwner.ts``. */
  cameraControlOwner: CameraControlOwner;
  /** Runtime owner of canvas scene-pointer input. Constructed at
   * viewer mount; the canvas React handlers delegate to it. See
   * ``inputManager/InputManager.ts``. */
  inputManager: InputManager | null;
  /** Single writer for ``canvas.style.cursor``. SceneTree's hover
   * deltas, MessageHandler's filter updates, and the InputManager's
   * gesture transitions all feed this controller; nothing else
   * touches cursor state. */
  cursorController: CursorController;

  // Scene management.
  nodeRefFromName: {
    [name: string]: undefined | THREE.Object3D;
  };

  // Message and rendering state.
  messageQueue: Message[];
  getRenderRequestState: "ready" | "triggered" | "pause" | "in_progress";
  getRenderRequest: null | GetRenderRequestMessage;

  // Canvas-level scene-pointer registration. Modifier-filter lists
  // keyed by event_type; the server pushes updates via
  // ``ScenePointerEnableMessage``. The InputManager reads this map at
  // every pointerdown to classify whether the press engages a
  // canvas-level gesture; the cursor controller reads it to decide
  // whether the canvas should show the ``pointer`` cursor. All
  // gesture state (isDragging, modifierAtDown, active pointer id,
  // camera-control lease) lives on the InputManager and
  // CameraControlOwner now -- this map is the only legacy field
  // still in use, and stays here because ``MessageHandler`` mutates
  // it in place (the InputManager and CursorController hold the
  // same reference).
  scenePointerInfo: {
    filtersByEventType: Map<
      "click" | "rect-select",
      (KeyModifier | null)[]
    >;
  };

  // Skinned mesh state.
  skinnedMeshState: {
    [name: string]: {
      initialized: boolean;
      dirty: boolean; // Flag to track if bones need updating.
      poses: {
        wxyz: [number, number, number, number];
        position: [number, number, number];
      }[];
    };
  };

  // Per-node pose data. Stored outside the reactive store to avoid
  // triggering React re-renders on every pose update.
  nodePoseData: NodePoseDataMap;

};

export type ViewerContextContents = {
  // Non-mutable state.
  messageSource: "websocket" | "file_playback" | "embed";

  // Store hooks and actions.
  useSceneTree: ReturnType<typeof useSceneTreeState>["store"];
  sceneTreeActions: ReturnType<typeof useSceneTreeState>["actions"];
  useEnvironment: ReturnType<typeof useEnvironmentState>;
  useGui: UseGui["store"];
  useGuiConfig: UseGui["configStore"];
  guiActions: UseGui["actions"];
  useDevSettings: ReturnType<typeof useDevSettingsStore>;
  useInitialCamera: ReturnType<typeof useInitialCameraState>["store"];
  initialCameraActions: ReturnType<typeof useInitialCameraState>["actions"];

  // Single reference to all mutable state.
  mutable: React.MutableRefObject<ViewerMutable>;
};

export const ViewerContext = React.createContext<null | ViewerContextContents>(
  null,
);
