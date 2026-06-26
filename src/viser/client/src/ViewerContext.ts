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
import { InteractionController } from "./pointer/interactionController";

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
  // Synchronously resize the R3F renderer + camera to a given CSS size (and
  // repaint that frame). Set by SceneContextSetter once the renderer exists.
  // Called from the dock's region-width drag so the GL backbuffer tracks the
  // panel edge on the SAME tick instead of trailing R3F's async ResizeObserver.
  // The caller passes the AUTHORITATIVE size it just computed -- reading the
  // canvas's clientWidth here instead would lag, because the new CSS inset isn't
  // reliably reflowed yet at this point in the drag frame. Null until mount.
  syncCanvasSize: ((width: number, height: number) => void) | null;

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
  // True until the first message batch of the current connection is processed.
  // Reset to true on every (re)connect so the root-orientation-first ordering
  // hack runs again. Lives here (not a component ref) so WebsocketInterface can
  // reset it on reconnect.
  firstMessageBatch: boolean;
  getRenderRequestState: "ready" | "triggered" | "pause" | "in_progress";
  getRenderRequest: null | GetRenderRequestMessage;

  // Diagnostic snapshot for the initial-camera / scene-orientation flow,
  // exposed via window.__viserMutable for e2e tests + debugging. See
  // initial_pose_and_scene_orientation.md. `rootWxyzAtCapture` is the root
  // node's orientation observed when SynchronizedCameraControls captured
  // `initialT` at mount -- a mount-ordering race would leave this at identity
  // [1,0,0,0] instead of the +Z-up default [0.5,-0.5,0.5,0.5].
  initialCameraDiagnostic: {
    rootWxyzAtCapture: [number, number, number, number];
  } | null;

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

  // Per-viewer pointer/hover/camera interaction coordinator.
  interaction: InteractionController;
};

export const ViewerContext = React.createContext<null | ViewerContextContents>(
  null,
);
