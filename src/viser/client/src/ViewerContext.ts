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

  // Scene management.
  nodeRefFromName: {
    [name: string]: undefined | THREE.Object3D;
  };

  // Message and rendering state.
  messageQueue: Message[];
  getRenderRequestState: "ready" | "triggered" | "pause" | "in_progress";
  getRenderRequest: null | GetRenderRequestMessage;

  // Interaction state.
  scenePointerInfo: {
    /** Modifier-filter lists keyed by event_type. Mirrors the
     * server's per-event-type set: each entry is a registered
     * callback's filter (``null`` = "no modifiers held"). An
     * absent/empty entry means the event_type is disabled. Used to
     * gate gesture engagement and dispatch on
     * ``modifierAtDown``-vs-filter match. */
    filtersByEventType: Map<
      "click" | "rect-select",
      (KeyModifier | null)[]
    >;
    dragStart: [number, number]; // First mouse position.
    dragEnd: [number, number]; // Final mouse position.
    isDragging: boolean;
    /** Canonical ``KeyModifier`` string captured at pointerdown.
     * Frozen for the gesture's lifetime — we don't want releasing
     * Shift/Cmd before mouse-up to lose the modifier match (or a
     * mid-drag press to spuriously add one). Mirrors how drag
     * callbacks freeze modifiers at drag-start. */
    modifierAtDown: KeyModifier | null;
    /** Subset of event_types whose filter list matched
     * ``modifierAtDown`` at the time of the active gesture's
     * pointerdown. Drives drawing + dispatch; empty means no gesture
     * was engaged. */
    activeEventTypes: Set<"click" | "rect-select">;
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

  // Global hover state tracking.
  hoveredElementsCount: number;
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
