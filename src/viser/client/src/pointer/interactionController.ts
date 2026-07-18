import type { CameraControls } from "@react-three/drei";
import type { KeyModifier } from "../dragUtils";
import { CameraLockManager } from "./cameraLock";
import { HoverCursorManager } from "./hoverSet";
import {
  NodeGestureController,
  ScenePointerController,
  type CanvasGesture,
} from "./gestures";

export class InteractionController {
  readonly cameraLocks: CameraLockManager;
  readonly hover: HoverCursorManager;
  readonly scenePointer: ScenePointerController;
  readonly nodeGestures: NodeGestureController;

  constructor(args: {
    getCameraControl: () => CameraControls | null;
    getCanvas: () => HTMLCanvasElement | null;
  }) {
    this.cameraLocks = new CameraLockManager(args.getCameraControl);
    this.hover = new HoverCursorManager(args.getCanvas, (eventType) =>
      this.scenePointer.getFilter(eventType),
    );
    this.scenePointer = new ScenePointerController(
      this.cameraLocks,
      this.hover,
    );
    this.nodeGestures = new NodeGestureController(this.cameraLocks);
  }

  cancelPointer(pointerId: number): void {
    this.scenePointer.cancelPointer(pointerId);
    this.nodeGestures.cancelPointer(pointerId);
  }

  cancelAny(): void {
    this.scenePointer.cancelAny();
    this.nodeGestures.cancelAny();
  }

  resetForTest(): void {
    this.cancelAny();
    this.scenePointer.resetForTest();
    this.nodeGestures.resetForTest();
    this.cameraLocks.resetForTest();
    this.hover.resetForTest();
  }

  testApi(): ViserPointerTestApi {
    return {
      getGesture: () => this.scenePointer.getGesture(),
      cameraLockReasons: () => this.cameraLocks.reasonsForTest(),
      setHeldModifier: (modifier) => this.hover.setHeldModifier(modifier),
      reset: () => this.resetForTest(),
    };
  }
}

export type ViserPointerTestApi = {
  getGesture: () => CanvasGesture;
  cameraLockReasons: () => string[];
  setHeldModifier: (modifier: KeyModifier | null) => void;
  reset: () => void;
};

declare global {
  interface Window {
    __viserPointer?: ViserPointerTestApi;
  }
}
