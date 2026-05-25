import { ViewerContext } from "./ViewerContext";
import {
  CameraControls,
  Grid,
  Instance,
  Instances,
  PivotControls,
  PointerLockControls,
} from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import React, { useContext, useLayoutEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "three";
import * as THREE from "three";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { useThrottledMessageSender } from "./WebsocketUtils";

const CAMERA_KEY_CODES = new Set([
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

function isInputEvent(event: KeyboardEvent) {
  const target = event.target;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

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
  onPivotChange,
  update,
  crosshairVisible,
}: {
  forceShow: boolean;
  pivotRef: React.RefObject<THREE.Group | null>;
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
  React.useEffect(update, [showOrbitOriginTool]);

  const show = showOrbitOriginTool || forceShow;
  return (
    <PivotControls
      ref={pivotRef as React.RefObject<THREE.Group>}
      scale={200}
      lineWidth={3}
      fixed={true}
      axisColors={["#ffaaff", "#ff33ff", "#ffaaff"]}
      disableScaling={true}
      disableAxes={!show}
      disableRotations={!show}
      disableSliders={!show}
      onDragEnd={() => {
        onPivotChange(pivotRef.current!.matrix);
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
  const gl = useThree((state) => state.gl);

  const isFirstPerson = viewer.useGui((s) => s.firstPersonCamera);
  const pointerLockRef =
    useRef<React.ElementRef<typeof PointerLockControls>>(null);

  const sendCameraThrottled = useThrottledMessageSender(20).send;

  const pivotRef = useRef<THREE.Group>(null);

  const viewerMutable = viewer.mutable.current;

  // Crosshair visibility state: separate keyboard and pointer interaction flags.
  const [keyboardInputActive, setKeyboardInputActive] = useState(false);
  const [pointerInteractionActive, setPointerInteractionActive] =
    useState(false);

  // Crosshair is visible if either keyboard keys are held or pointer interaction is active.
  const crosshairVisible = keyboardInputActive || pointerInteractionActive;

  // Animation state interface.
  interface CameraAnimation {
    startUp: THREE.Vector3;
    targetUp: THREE.Vector3;
    startLookAt: THREE.Vector3;
    targetLookAt: THREE.Vector3;
    startTime: number;
    duration: number;
  }

  const [cameraAnimation, setCameraAnimation] =
    useState<CameraAnimation | null>(null);

  // Animation parameters.
  const ANIMATION_DURATION = 0.5; // seconds

  useFrame((state) => {
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
        setCameraAnimation(null);
      }
    }
  });

  const { clock } = useThree();

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
    setCameraAnimation({
      startUp: camera.up.clone(),
      targetUp: targetUp,
      startLookAt: currentLookAt,
      targetLookAt: targetPosition,
      startTime: clock.getElapsedTime(),
      duration: ANIMATION_DURATION,
    });
  };

  const updatePivotControlFromCameraLookAtAndup = () => {
    if (cameraAnimation !== null) return;
    if (!viewerMutable.cameraControl) return;
    if (!pivotRef.current) return;

    const cameraControls = viewerMutable.cameraControl;
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
    // rotationMatrix.premultiply(origRotation);

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
    const cc = viewerMutable.cameraControl;
    if (cc !== null) {
      cc.updateCameraUp();
      if (animate) {
        cc.setLookAt(
          initialPos.x,
          initialPos.y,
          initialPos.z,
          initialLookAt.x,
          initialLookAt.y,
          initialLookAt.z,
          true,
        );
      } else {
        cc.setPosition(initialPos.x, initialPos.y, initialPos.z, false);
        cc.setTarget(
          initialLookAt.x,
          initialLookAt.y,
          initialLookAt.z,
          false,
        );
      }
    } else {
      camera.position.copy(initialPos);
      camera.lookAt(initialLookAt);
      camera.updateMatrixWorld();
    }
  };

  const searchParams = new URLSearchParams(window.location.search);
  const forceOrbitOriginTool = searchParams.get("forceOrbitOriginTool") === "1";
  const logCamera = viewer.useDevSettings((state) => state.logCamera);
  const firstPersonInvertLookY = viewer.useDevSettings(
    (state) => state.firstPersonInvertLookY,
  );

  // Callback for sending cameras.
  // It makes the code more chaotic, but we preallocate a bunch of things to
  // minimize garbage collection!
  const R_threecam_cam = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.PI, 0.0, 0.0),
  );
  const R_world_threeworld = new THREE.Quaternion();
  const tmpMatrix4 = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const forwardTmp = new THREE.Vector3();
  const R_world_camera = new THREE.Quaternion();
  const t_world_camera = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const sendCamera = React.useCallback(() => {
    updatePivotControlFromCameraLookAtAndup();

    const three_camera = camera;
    const camera_control = viewerMutable.cameraControl;
    const canvas = viewerMutable.canvas!;

    if (camera_control === null) {
      if (!isFirstPerson) {
        setTimeout(sendCamera, 10);
        return;
      }
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

    if (isFirstPerson) {
      three_camera.getWorldDirection(forwardTmp);
      lookAt.copy(three_camera.position).add(forwardTmp);
    } else {
      camera_control!.getTarget(lookAt);
    }
    lookAt.applyQuaternion(R_world_threeworld);
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
  }, [camera, sendCameraThrottled, logCamera, isFirstPerson]);

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
    setTimeout(() => sendCamera(), 50);
  }, [connected, sendCamera, camera, viewer.useInitialCamera, viewerMutable]);

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

  const wasFirstPerson = useRef(false);
  useLayoutEffect(() => {
    if (wasFirstPerson.current && !isFirstPerson) {
      const cc = viewerMutable.cameraControl;
      if (cc !== null) {
        const pos = camera.position;
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const tgt = dir.add(pos);
        cc.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
      }
    }
    wasFirstPerson.current = isFirstPerson;
  }, [isFirstPerson, camera, viewerMutable.cameraControl]);

  const activeCameraKeysRef = useRef(new Set<string>());
  const keyboardYawAxis = useRef(new THREE.Vector3()).current;
  const clearCameraKeys = React.useCallback(() => {
    activeCameraKeysRef.current.clear();
    setKeyboardInputActive(false);
  }, []);
  const requestPointerLock = React.useCallback(() => {
    try {
      const request = gl.domElement.requestPointerLock() as
        | Promise<void>
        | undefined;
      void request?.catch(() => {
        viewer.useGui.set({ firstPersonCamera: false });
      });
    } catch {
      viewer.useGui.set({ firstPersonCamera: false });
    }
  }, [gl.domElement, viewer.useGui]);
  const exitFirstPerson = React.useCallback(() => {
    clearCameraKeys();
    viewer.useGui.set({ firstPersonCamera: false });
    if (document.pointerLockElement === gl.domElement) {
      document.exitPointerLock();
    }
  }, [clearCameraKeys, gl.domElement, viewer.useGui]);
  const enterFirstPerson = React.useCallback(() => {
    clearCameraKeys();
    viewer.useGui.set({ firstPersonCamera: true });
    requestPointerLock();
  }, [clearCameraKeys, requestPointerLock, viewer.useGui]);

  React.useEffect(() => {
    clearCameraKeys();
  }, [clearCameraKeys, isFirstPerson]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isInputEvent(event)) {
        return;
      }
      if (event.key === "p" || event.key === "P") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        if (isFirstPerson) {
          exitFirstPerson();
        } else {
          enterFirstPerson();
        }
        return;
      }
      if (!CAMERA_KEY_CODES.has(event.code)) {
        return;
      }
      event.preventDefault();
      activeCameraKeysRef.current.add(event.code);
      setKeyboardInputActive(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isInputEvent(event)) {
        return;
      }
      if (!CAMERA_KEY_CODES.has(event.code)) {
        return;
      }
      event.preventDefault();
      activeCameraKeysRef.current.delete(event.code);
      setKeyboardInputActive(activeCameraKeysRef.current.size > 0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearCameraKeys();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearCameraKeys);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearCameraKeys);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearCameraKeys, enterFirstPerson, exitFirstPerson, isFirstPerson]);

  React.useEffect(() => {
    const onPointerLockChange = () => {
      if (
        document.pointerLockElement !== gl.domElement &&
        viewer.useGui.get().firstPersonCamera
      ) {
        clearCameraKeys();
        viewer.useGui.set({ firstPersonCamera: false });
      }
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", onPointerLockChange);
    };
  }, [clearCameraKeys, gl.domElement, viewer.useGui]);

  // Keyboard controls.
  useFrame((_, deltaSeconds) => {
    const activeCameraKeys = activeCameraKeysRef.current;
    if (activeCameraKeys.size === 0) {
      return;
    }

    const milliseconds = deltaSeconds * 1000.0;
    const moveScale = 0.002 * milliseconds;
    const rotateScale = 0.05 * THREE.MathUtils.DEG2RAD * milliseconds;

    if (isFirstPerson) {
      let changed = false;
      if (activeCameraKeys.has("KeyA")) {
        camera.translateX(-moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("KeyD")) {
        camera.translateX(moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("KeyW")) {
        camera.translateZ(-moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("KeyS")) {
        camera.translateZ(moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("KeyQ")) {
        camera.translateY(-moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("KeyE")) {
        camera.translateY(moveScale);
        changed = true;
      }
      if (activeCameraKeys.has("ArrowLeft")) {
        keyboardYawAxis.copy(camera.up).normalize();
        camera.rotateOnWorldAxis(keyboardYawAxis, -rotateScale);
        changed = true;
      }
      if (activeCameraKeys.has("ArrowRight")) {
        keyboardYawAxis.copy(camera.up).normalize();
        camera.rotateOnWorldAxis(keyboardYawAxis, rotateScale);
        changed = true;
      }
      const pitchMul = firstPersonInvertLookY ? 1 : -1;
      if (activeCameraKeys.has("ArrowUp")) {
        camera.rotateX(pitchMul * rotateScale);
        changed = true;
      }
      if (activeCameraKeys.has("ArrowDown")) {
        camera.rotateX(-pitchMul * rotateScale);
        changed = true;
      }
      if (changed) {
        sendCamera();
      }
      return;
    }

    const cameraControls = viewerMutable.cameraControl;
    if (cameraControls === null) {
      return;
    }
    let changed = false;
    if (activeCameraKeys.has("KeyA")) {
      cameraControls.truck(-moveScale, 0, false);
      changed = true;
    }
    if (activeCameraKeys.has("KeyD")) {
      cameraControls.truck(moveScale, 0, false);
      changed = true;
    }
    if (activeCameraKeys.has("KeyW")) {
      cameraControls.forward(moveScale, false);
      changed = true;
    }
    if (activeCameraKeys.has("KeyS")) {
      cameraControls.forward(-moveScale, false);
      changed = true;
    }
    if (activeCameraKeys.has("KeyQ")) {
      cameraControls.elevate(-moveScale, false);
      changed = true;
    }
    if (activeCameraKeys.has("KeyE")) {
      cameraControls.elevate(moveScale, false);
      changed = true;
    }
    if (activeCameraKeys.has("ArrowLeft")) {
      cameraControls.rotate(-rotateScale, 0, true);
      changed = true;
    }
    if (activeCameraKeys.has("ArrowRight")) {
      cameraControls.rotate(rotateScale, 0, true);
      changed = true;
    }
    if (activeCameraKeys.has("ArrowUp")) {
      cameraControls.rotate(0, -rotateScale, true);
      changed = true;
    }
    if (activeCameraKeys.has("ArrowDown")) {
      cameraControls.rotate(0, rotateScale, true);
      changed = true;
    }
    if (changed) {
      sendCamera();
    }
  });

  // Yaw: +movementX matches common FPS feel vs stock three pointer-lock.
  // Pitch sign: default normal FPS; optional invert via dev settings.
  useLayoutEffect(() => {
    if (!isFirstPerson) return;
    const c = pointerLockRef.current;
    if (c == null) return;
    if (document.pointerLockElement === gl.domElement) {
      c.isLocked = true;
    }
    const sens = 2e-3;
    const pitchMul = firstPersonInvertLookY ? 1 : -1;
    const yawAxis = new THREE.Vector3();
    const pl = c as unknown as { onMouseMove: (e: MouseEvent) => void };
    pl.onMouseMove = (e) => {
      if (!c.domElement || !c.isLocked) return;
      yawAxis.copy(c.camera.up).normalize();
      c.camera.rotateOnWorldAxis(yawAxis, -e.movementX * sens * c.pointerSpeed);
      c.camera.rotateX(pitchMul * e.movementY * sens * c.pointerSpeed);
      c.dispatchEvent({ type: "change" } as never);
    };
  }, [gl.domElement, isFirstPerson, firstPersonInvertLookY]);

  return (
    <>
      {!isFirstPerson ? (
        <CameraControls
          ref={(controls) => (viewerMutable.cameraControl = controls)}
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
      ) : null}
      {!isFirstPerson ? (
        <OrbitOriginTool
          forceShow={forceOrbitOriginTool}
          pivotRef={pivotRef}
          onPivotChange={(matrix) => {
            updateCameraLookAtAndUpFromPivotControl(matrix);
          }}
          update={updatePivotControlFromCameraLookAtAndup}
          crosshairVisible={crosshairVisible}
        />
      ) : null}
      {isFirstPerson ? (
        <PointerLockControls
          ref={pointerLockRef}
          domElement={gl.domElement}
          onChange={sendCamera}
          onUnlock={() => {
            clearCameraKeys();
            viewer.useGui.set({ firstPersonCamera: false });
          }}
        />
      ) : null}
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
