import { ViewerContext } from "./ViewerContext";
import {
  CameraControls,
  Grid,
  Instance,
  Instances,
  PivotControls,
} from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import React, { useContext, useRef, useState } from "react";
import { PerspectiveCamera } from "three";
import * as THREE from "three";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { useThrottledMessageSender } from "./WebsocketUtils";
import { isFormElement } from "./utils/isFormElement";

// Rotation from the three.js camera convention to the OpenCV one. Constant, so
// it lives at module scope instead of being rebuilt every render.
const R_threecam_cam = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(Math.PI, 0.0, 0.0),
);

// `event.code`s that drive keyboard camera movement.
const CAMERA_MOVEMENT_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

function CrosshairVisual({
  visible,
  children,
}: {
  visible: boolean;
  children?: React.ReactNode;
}) {
  const { camera, size } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  // Target crosshair size in pixels.
  const TARGET_PIXEL_SIZE = 20;

  const worldPos = new THREE.Vector3();
  useFrame(() => {
    if (groupRef.current && visible) {
      // Get world position of the crosshair.
      groupRef.current.getWorldPosition(worldPos);
      // Scale based on distance, FOV, and viewport size to maintain consistent pixel size.
      const distance = camera.position.distanceTo(worldPos);
      const fovScale = Math.tan(
        ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360,
      );
      // Convert target pixel size to world-space scale.
      const pixelToWorldScale = (2 * distance * fovScale) / size.height;
      groupRef.current.scale.setScalar(TARGET_PIXEL_SIZE * pixelToWorldScale);
    }
  });

  return (
    <group ref={groupRef} visible={visible}>
      <Instances limit={6}>
        <boxGeometry args={[0.4, 0.02, 0.02]} />
        <meshBasicMaterial opacity={0.625} transparent />
        {/* Horizontal line segments */}
        <Instance position={[0.5, 0.0, 0.0]} color="#777777" />
        <Instance position={[-0.5, 0.0, 0.0]} color="#777777" />
        <Instance
          position={[0.0, 0.0, 0.5]}
          rotation={new THREE.Euler(0.0, Math.PI / 2.0, 0.0)}
          color="#777777"
        />
        <Instance
          position={[0.0, 0.0, -0.5]}
          rotation={new THREE.Euler(0.0, Math.PI / 2.0, 0.0)}
          color="#777777"
        />
        {/* Vertical line segments */}
        <Instance
          position={[0.0, 0.5, 0.0]}
          rotation={new THREE.Euler(0.0, 0.0, Math.PI / 2.0)}
          color="#999999"
        />
        <Instance
          position={[0.0, -0.5, 0.0]}
          rotation={new THREE.Euler(0.0, 0.0, Math.PI / 2.0)}
          color="#999999"
        />
      </Instances>
      <mesh>
        <sphereGeometry args={[0.04, 8, 8]} />
        <meshBasicMaterial color="#999999" opacity={0.625} transparent />
      </mesh>
      {children}
    </group>
  );
}

function OrbitOriginTool({
  forceShow,
  pivotRef,
  onDragStart,
  onPivotChange,
  update,
  crosshairVisible,
}: {
  forceShow: boolean;
  pivotRef: React.RefObject<THREE.Group>;
  onDragStart: () => void;
  onPivotChange: (matrix: THREE.Matrix4) => void;
  update: () => void;
  crosshairVisible: boolean;
}) {
  const viewer = useContext(ViewerContext)!;
  const showOrbitOriginTool = viewer.useGui(
    (state) => state.showOrbitOriginTool,
  );
  const enableOrbitCrosshair = viewer.useDevSettings(
    (state) => state.enableOrbitCrosshair,
  );
  const show = showOrbitOriginTool || forceShow;
  React.useLayoutEffect(() => {
    if (show) update();
  }, [show]);

  // Keep the gizmo mounted at all times and toggle the handles via the
  // `disable*` props rather than unmounting it when hidden. The pivot's
  // transform is only synced to the camera by `sendCamera` on camera
  // *changes*, so a freshly mounted gizmo has a stale pose until the next
  // camera move -- keeping it mounted means its first drag starts from the
  // correct pose.
  return (
    <PivotControls
      ref={pivotRef}
      scale={200}
      lineWidth={3}
      fixed={true}
      axisColors={["#ffaaff", "#ff33ff", "#ffaaff"]}
      disableScaling={true}
      disableAxes={!show}
      disableRotations={!show}
      disableSliders={!show}
      onDragStart={onDragStart}
      onDragEnd={() => {
        if (pivotRef.current !== null) onPivotChange(pivotRef.current.matrix);
      }}
    >
      <Grid
        args={[10, 10, 10, 10]}
        infiniteGrid
        fadeStrength={0}
        fadeFrom={0}
        fadeDistance={1000}
        sectionColor={"#ffaaff"}
        cellColor={"#ffccff"}
        side={THREE.DoubleSide}
        visible={show}
      />
      {/* Crosshair visualization at look-at point */}
      <CrosshairVisual visible={enableOrbitCrosshair && crosshairVisible} />
    </PivotControls>
  );
}

export function SynchronizedCameraControls() {
  const viewer = useContext(ViewerContext)!;
  const camera = useThree((state) => state.camera as PerspectiveCamera);

  const sendCameraThrottled = useThrottledMessageSender(20).send;

  const pivotRef = useRef<THREE.Group>(null);

  // True while the user is actively dragging the orbit-origin gizmo. The
  // per-frame `updatePivotControlFromCameraLookAtAndup` sync must stand down
  // for the duration: it rewrites `pivotRef.current.matrix` to the camera's
  // look-at every time `sendCamera` runs, so if the camera happens to be
  // moving during the drag (e.g. damping still settling from a prior gesture)
  // it stomps the drag every frame -- the gizmo can't be moved and the
  // release looks like it did nothing.
  const pivotDraggingRef = useRef(false);

  const viewerMutable = viewer.mutable.current;

  // Crosshair visibility state: separate counter for keyboard and flag for pointer interactions.
  const [keyboardCrosshairCounter, setKeyboardCrosshairCounter] = useState(0);
  const [pointerInteractionActive, setPointerInteractionActive] =
    useState(false);

  // Crosshair is visible if either keyboard keys are held or pointer interaction is active.
  const crosshairVisible =
    keyboardCrosshairCounter > 0 || pointerInteractionActive;

  // Animation state interface.
  interface CameraAnimation {
    startUp: THREE.Vector3;
    targetUp: THREE.Vector3;
    startLookAt: THREE.Vector3;
    targetLookAt: THREE.Vector3;
    startTime: number;
    duration: number;
  }

  // Held in a ref, not state: it's read inside the stable `sendCamera`
  // callback (and the `updatePivotControlFromCameraLookAtAndup` guard it
  // calls), which needs the current value rather than the one captured at its
  // last dependency change. Nothing renders off this value; the animation is
  // driven entirely by `useFrame`.
  const cameraAnimationRef = useRef<CameraAnimation | null>(null);

  // Animation parameters.
  const ANIMATION_DURATION = 0.5; // seconds

  useFrame((state) => {
    const cameraAnimation = cameraAnimationRef.current;
    if (cameraAnimation && viewerMutable.cameraControl) {
      const cameraControls = viewerMutable.cameraControl;
      const camera = cameraControls.camera;

      const elapsed = state.clock.getElapsedTime() - cameraAnimation.startTime;
      const progress = Math.min(elapsed / cameraAnimation.duration, 1);

      // Smooth step easing.
      const t = progress * progress * (3 - 2 * progress);

      // Interpolate up vector.
      const newUp = new THREE.Vector3()
        .copy(cameraAnimation.startUp)
        .lerp(cameraAnimation.targetUp, t)
        .normalize();

      // Interpolate look-at position.
      const newLookAt = new THREE.Vector3()
        .copy(cameraAnimation.startLookAt)
        .lerp(cameraAnimation.targetLookAt, t);

      camera.up.copy(newUp);

      // Back up position.
      const prevPosition = new THREE.Vector3();
      cameraControls.getPosition(prevPosition);

      cameraControls.updateCameraUp();

      // Restore position and set new look-at.
      cameraControls.setPosition(
        prevPosition.x,
        prevPosition.y,
        prevPosition.z,
        false,
      );

      cameraControls.setLookAt(
        prevPosition.x,
        prevPosition.y,
        prevPosition.z,
        newLookAt.x,
        newLookAt.y,
        newLookAt.z,
        false,
      );

      // Clear animation when complete.
      if (progress >= 1) {
        cameraAnimationRef.current = null;
      }
    }
  });

  const clock = useThree((state) => state.clock);

  const updateCameraLookAtAndUpFromPivotControl = (matrix: THREE.Matrix4) => {
    if (!viewerMutable.cameraControl) return;

    const targetPosition = new THREE.Vector3();
    targetPosition.setFromMatrixPosition(matrix);

    const cameraControls = viewerMutable.cameraControl;
    const camera = viewerMutable.cameraControl.camera;

    // Get target up vector from matrix.
    const targetUp = new THREE.Vector3().setFromMatrixColumn(matrix, 1);

    // Get current look-at position.
    const currentLookAt = cameraControls.getTarget(new THREE.Vector3());

    // Start new animation.
    cameraAnimationRef.current = {
      startUp: camera.up.clone(),
      targetUp: targetUp,
      startLookAt: currentLookAt,
      targetLookAt: targetPosition,
      startTime: clock.getElapsedTime(),
      duration: ANIMATION_DURATION,
    };
  };

  const updatePivotControlFromCameraLookAtAndup = () => {
    if (cameraAnimationRef.current !== null) return;
    if (!viewerMutable.cameraControl) return;
    if (!pivotRef.current) return;

    const cameraControls = viewerMutable.cameraControl;
    // Suppress the sync only while a gizmo drag is genuinely in progress -- drei
    // disables the camera for the whole drag, so a set flag with the camera
    // *enabled* is stale (e.g. a pointercancel skipped the drag-end that would
    // clear it). Ignoring it then keeps the gizmo tracking instead of freezing.
    if (pivotDraggingRef.current && !cameraControls.enabled) return;
    const lookAt = cameraControls.getTarget(new THREE.Vector3());

    // Rotate matrix s.t. it's y-axis aligns with the camera's up vector.
    // We'll do this with math.
    const origRotation = new THREE.Matrix4().extractRotation(
      pivotRef.current.matrix,
    );

    const cameraUp = camera.up.clone().normalize();
    const pivotUp = new THREE.Vector3(0, 1, 0)
      .applyMatrix4(origRotation)
      .normalize();
    const axis = new THREE.Vector3()
      .crossVectors(pivotUp, cameraUp)
      .normalize();
    const angle = Math.acos(Math.min(1, Math.max(-1, cameraUp.dot(pivotUp))));

    // Create rotation matrix.
    const rotationMatrix = new THREE.Matrix4();
    if (axis.lengthSq() > 0.0001) {
      // Check if cross product is valid.
      rotationMatrix.makeRotationAxis(axis, angle);
    }

    // Combine rotation with position.
    const matrix = new THREE.Matrix4();
    matrix.multiply(rotationMatrix);
    matrix.multiply(origRotation);
    matrix.setPosition(lookAt);

    pivotRef.current.matrix.copy(matrix);
    pivotRef.current.updateMatrixWorld(true);
  };

  // Capture the T_threeworld_world used for the initial camera setup, so
  // "Reset View" returns to the same position even if set_up_direction()
  // later changes the root orientation. Updated when InitialCameraSetter
  // re-applies the camera for non-default sources.
  const initialT = React.useRef<THREE.Matrix4>(
    computeT_threeworld_world(viewer),
  );

  // Diagnostic (see initial_pose_and_scene_orientation.md): record the root
  // orientation at the instant `initialT` was captured, so e2e/debugging can
  // detect a mount-ordering race that would leave the root at identity here
  // (which would place the initial camera with T=identity -> wrong pre-connect
  // view). Set once, on the first render.
  if (viewerMutable.initialCameraDiagnostic === null) {
    const w = viewer.useSceneTree.get("")?.wxyz ?? [1, 0, 0, 0];
    viewerMutable.initialCameraDiagnostic = {
      rootWxyzAtCapture: [w[0], w[1], w[2], w[3]],
    };
  }

  viewerMutable.resetCameraPose = (animate: boolean) => {
    // Read initial camera state from the store.
    const initialCameraState = viewer.useInitialCamera.get();
    const hasNonDefault =
      initialCameraState.position.source !== "default" ||
      initialCameraState.lookAt.source !== "default" ||
      initialCameraState.up.source !== "default";

    // For default sources, use the captured T from mount time so that
    // "Reset View" matches the initial camera position. For non-default
    // sources (server initial_camera), use the current T so that
    // set_up_direction changes are reflected.
    const T_threeworld_world = hasNonDefault
      ? computeT_threeworld_world(viewer)
      : initialT.current;

    // Skip the up direction transform for the default up direction. This makes
    // it so the initial camera up always matches the initial scene up, except
    // in the case where the up direction was explicitly set.
    const initialUp = new THREE.Vector3(...initialCameraState.up.value);
    if (initialCameraState.up.source !== "default") {
      initialUp.applyMatrix4(T_threeworld_world);
    }
    initialUp.normalize();

    const initialPos = new THREE.Vector3(...initialCameraState.position.value);
    initialPos.applyMatrix4(T_threeworld_world);

    const initialLookAt = new THREE.Vector3(...initialCameraState.lookAt.value);
    initialLookAt.applyMatrix4(T_threeworld_world);

    camera.up.set(initialUp.x, initialUp.y, initialUp.z);
    viewerMutable.cameraControl!.updateCameraUp();
    if (animate) {
      viewerMutable.cameraControl!.setLookAt(
        initialPos.x,
        initialPos.y,
        initialPos.z,
        initialLookAt.x,
        initialLookAt.y,
        initialLookAt.z,
        true,
      );
    } else {
      // Calling setLookAt with animate = false seems to break future calls to
      // setLookAt. Possible dependency bug.
      viewerMutable.cameraControl!.setPosition(
        initialPos.x,
        initialPos.y,
        initialPos.z,
        false,
      );
      viewerMutable.cameraControl!.setTarget(
        initialLookAt.x,
        initialLookAt.y,
        initialLookAt.z,
        false,
      );
    }
  };

  const searchParams = new URLSearchParams(window.location.search);
  const forceOrbitOriginTool = searchParams.get("forceOrbitOriginTool") === "1";
  const logCamera = viewer.useDevSettings((state) => state.logCamera);

  // Callback for sending cameras.
  // It makes the code more chaotic, but we preallocate a bunch of things to
  // minimize garbage collection!
  const R_world_threeworld = new THREE.Quaternion();
  const tmpMatrix4 = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const R_world_camera = new THREE.Quaternion();
  // Pending camera-send timer (the not-ready retry and the connect delay share
  // one slot -- at most one is ever pending). Cleared on unmount so the 10ms
  // retry can't re-schedule itself forever or fire `sendCamera` after teardown.
  const cameraTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  React.useEffect(
    () => () => {
      if (cameraTimeoutRef.current !== null) {
        clearTimeout(cameraTimeoutRef.current);
      }
    },
    [],
  );
  const scheduleSendCamera = React.useCallback(
    (fn: () => void, delayMs: number) => {
      if (cameraTimeoutRef.current !== null)
        clearTimeout(cameraTimeoutRef.current);
      cameraTimeoutRef.current = setTimeout(fn, delayMs);
    },
    [],
  );

  const t_world_camera = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const sendCamera = React.useCallback(() => {
    updatePivotControlFromCameraLookAtAndup();

    const three_camera = camera;
    const camera_control = viewerMutable.cameraControl;
    const canvas = viewerMutable.canvas!;

    if (camera_control === null) {
      // Camera controls not yet ready, let's re-try later.
      scheduleSendCamera(sendCamera, 10);
      return;
    }

    // We put Z up to match the scene tree, and convert threejs camera convention
    // to the OpenCV one.
    const T_world_threeworld = computeT_threeworld_world(viewer).invert();
    const T_world_camera = T_world_threeworld.clone()
      .multiply(
        tmpMatrix4
          .makeRotationFromQuaternion(three_camera.quaternion)
          .setPosition(three_camera.position),
      )
      .multiply(tmpMatrix4.makeRotationFromQuaternion(R_threecam_cam));
    R_world_threeworld.setFromRotationMatrix(T_world_threeworld);

    camera_control.getTarget(lookAt).applyQuaternion(R_world_threeworld);
    const up = three_camera.up.clone().applyQuaternion(R_world_threeworld);

    T_world_camera.decompose(t_world_camera, R_world_camera, scale);

    sendCameraThrottled({
      type: "ViewerCameraMessage",
      wxyz: [
        R_world_camera.w,
        R_world_camera.x,
        R_world_camera.y,
        R_world_camera.z,
      ],
      position: t_world_camera.toArray(),
      image_height: canvas.height,
      image_width: canvas.width,
      fov: (three_camera.fov * Math.PI) / 180.0,
      near: three_camera.near,
      far: three_camera.far,
      look_at: [lookAt.x, lookAt.y, lookAt.z],
      up_direction: [up.x, up.y, up.z],
    });

    // Log camera.
    if (logCamera) {
      const fovRadians = (three_camera.fov * Math.PI) / 180.0;
      console.log(
        `&initialCameraPosition=${t_world_camera.x.toFixed(
          3,
        )},${t_world_camera.y.toFixed(3)},${t_world_camera.z.toFixed(3)}` +
          `&initialCameraLookAt=${lookAt.x.toFixed(3)},${lookAt.y.toFixed(
            3,
          )},${lookAt.z.toFixed(3)}` +
          `&initialCameraUp=${up.x.toFixed(3)},${up.y.toFixed(
            3,
          )},${up.z.toFixed(3)}` +
          `&initialCameraFov=${fovRadians.toFixed(4)}` +
          `&initialCameraNear=${three_camera.near}` +
          `&initialCameraFar=${three_camera.far}`,
      );
    }
  }, [camera, sendCameraThrottled, logCamera, scheduleSendCamera]);

  // Send camera for new connections.
  // We add a small delay to give the server time to add a callback.
  const connected = viewer.useGui(
    (state) => state.websocketState === "connected",
  );
  const initialCameraPositionSet = React.useRef(false);
  React.useEffect(() => {
    if (!initialCameraPositionSet.current) {
      // Reset position, orientation, and up direction.
      viewerMutable.resetCameraPose!(false);

      // Read initial camera state from the store.
      // This contains defaults, URL params, or will be updated by server messages.
      const initialCameraState = viewer.useInitialCamera.get();

      // Apply fov/near/far from the store.
      // tan(fov / 2.0) = 0.5 * film height / focal length
      // focal length = 0.5 * film height / tan(fov / 2.0)
      camera.setFocalLength(
        (0.5 * camera.getFilmHeight()) /
          Math.tan(initialCameraState.fov.value / 2.0),
      );
      camera.near = initialCameraState.near.value;
      camera.far = initialCameraState.far.value;
      camera.updateProjectionMatrix();

      initialCameraPositionSet.current = true;
    }

    viewerMutable.sendCamera = sendCamera;
    if (!connected) return;
    scheduleSendCamera(sendCamera, 50);
  }, [
    connected,
    sendCamera,
    camera,
    viewer.useInitialCamera,
    viewerMutable,
    scheduleSendCamera,
  ]);

  // Send camera for 3D viewport changes.
  const canvas = viewerMutable.canvas!; // R3F canvas.
  React.useEffect(() => {
    // Create a resize observer to resize the CSS canvas when the window is resized.
    const resizeObserver = new ResizeObserver(() => {
      sendCamera();
    });
    resizeObserver.observe(canvas);

    // Cleanup.
    return () => resizeObserver.disconnect();
  }, [canvas, sendCamera]);

  // Keyboard controls. The document/window listeners only track which keys are
  // currently held; movement is applied per frame in the `useFrame` below. The
  // effect has no dependencies, so the listeners are attached once and removed
  // on unmount.
  const heldKeysRef = useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const held = heldKeysRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!CAMERA_MOVEMENT_KEYS.has(event.code)) return;
      if (isFormElement(event.target)) return;
      // Ignore auto-repeat: only a fresh press counts as a new hold.
      if (held.has(event.code)) return;
      held.add(event.code);
      setKeyboardCrosshairCounter((count) => count + 1);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held.delete(event.code)) return;
      setKeyboardCrosshairCounter((count) => Math.max(0, count - 1));
    };
    const onBlur = () => {
      // A window blur swallows keyups, so drop all held keys at once.
      if (held.size === 0) return;
      held.clear();
      setKeyboardCrosshairCounter(0);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      held.clear();
    };
  }, []);

  // Apply held-key camera movement each frame. Rates: linear 2.0/s, rotation
  // 50 deg/s (`delta` is in seconds).
  useFrame((_, delta) => {
    const cameraControls = viewerMutable.cameraControl;
    const held = heldKeysRef.current;
    if (cameraControls === null || held.size === 0) return;
    // Respect camera locks: when a lease (or a gizmo drag) has disabled the
    // controls, keyboard movement must not bypass it. The library's
    // programmatic truck/forward/rotate ignore `enabled`, so guard here.
    if (!cameraControls.enabled) return;
    const linear = 2.0 * delta;
    const angular = 50.0 * THREE.MathUtils.DEG2RAD * delta;
    if (held.has("KeyA")) cameraControls.truck(-linear, 0, false);
    if (held.has("KeyD")) cameraControls.truck(linear, 0, false);
    if (held.has("KeyW")) cameraControls.forward(linear, false);
    if (held.has("KeyS")) cameraControls.forward(-linear, false);
    if (held.has("KeyQ")) cameraControls.elevate(-linear, false);
    if (held.has("KeyE")) cameraControls.elevate(linear, false);
    if (held.has("ArrowLeft")) cameraControls.rotate(-angular, 0, true);
    if (held.has("ArrowRight")) cameraControls.rotate(angular, 0, true);
    if (held.has("ArrowUp")) cameraControls.rotate(0, -angular, true);
    if (held.has("ArrowDown")) cameraControls.rotate(0, angular, true);
  });

  // Stable ref callback so React only invokes it when the controls instance
  // actually attaches/changes -- `cameraLocks.apply()` should run on attach,
  // not on every commit (which an inline arrow would cause).
  const setCameraControlRef = React.useCallback(
    (controls: CameraControls | null) => {
      viewerMutable.cameraControl = controls;
      viewer.interaction.cameraLocks.apply();
    },
    [viewerMutable, viewer.interaction.cameraLocks],
  );

  return (
    <>
      <CameraControls
        ref={setCameraControlRef}
        minDistance={0.01}
        dollySpeed={0.3}
        smoothTime={0.05}
        draggingSmoothTime={0.0}
        onChange={sendCamera}
        onStart={() => {
          setPointerInteractionActive(true);
        }}
        onEnd={() => {
          setPointerInteractionActive(false);
        }}
        makeDefault
      />
      <OrbitOriginTool
        forceShow={forceOrbitOriginTool}
        pivotRef={pivotRef}
        onDragStart={() => {
          pivotDraggingRef.current = true;
        }}
        onPivotChange={(matrix) => {
          pivotDraggingRef.current = false;
          updateCameraLookAtAndUpFromPivotControl(matrix);
        }}
        update={updatePivotControlFromCameraLookAtAndup}
        crosshairVisible={crosshairVisible}
      />
      <InitialCameraSetter />
    </>
  );
}

/**
 * Reactively applies the initial camera pose when the server sets
 * initial_camera properties (non-default sources). Also watches rootWxyz
 * so that if set_up_direction() and initial_camera messages arrive in
 * separate batches, the camera converges to the correct pose.
 *
 * For default-only sources, this is a no-op -- the camera stays at the
 * position set on mount, and set_up_direction() only rotates the scene.
 */
function InitialCameraSetter() {
  const viewer = React.useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;

  const posSource = viewer.useInitialCamera((s) => s.position.source);
  const lookAtSource = viewer.useInitialCamera((s) => s.lookAt.source);
  const upSource = viewer.useInitialCamera((s) => s.up.source);
  const rootWxyz = viewer.useSceneTree("", (node) => node!.wxyz);

  const hasNonDefault =
    posSource !== "default" ||
    lookAtSource !== "default" ||
    upSource !== "default";

  React.useEffect(() => {
    if (!hasNonDefault) return;
    viewerMutable.resetCameraPose?.(false);
  }, [hasNonDefault, rootWxyz, viewerMutable]);

  return null;
}
