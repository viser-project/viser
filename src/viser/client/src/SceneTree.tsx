import {
  CatmullRomLine,
  CubicBezierLine,
  PivotControls,
} from "@react-three/drei";
import { Grid } from "./Grid";
import { ContextBridge, useContextBridge } from "its-fine";
import { useFrame, useThree } from "@react-three/fiber";
import React, { useEffect } from "react";
import * as THREE from "three";

import { ViewerContext, ViewerContextContents } from "./ViewerContext";
import {
  makeThrottledMessageSender,
  useThrottledMessageSender,
} from "./WebsocketUtils";
import { Html } from "@react-three/drei";
import { useSceneTreeState } from "./SceneTreeState";
import { rayToViserCoords } from "./WorldTransformUtils";
import { HoverableContext, HoverState } from "./HoverContext";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";

/** Turn a click event to normalized OpenCV coordinate (NDC) vector.
 * Normalizes click coordinates to be between (0, 0) as upper-left corner,
 * and (1, 1) as lower-right corner, with (0.5, 0.5) being the center of the screen.
 * Uses offsetX/Y, and clientWidth/Height to get the coordinates.
 */
function opencvXyFromPointerXy(
  viewer: ViewerContextContents,
  xy: [number, number],
): THREE.Vector2 {
  const mouseVector = new THREE.Vector2();
  mouseVector.x = (xy[0] + 0.5) / viewer.mutable.current.canvas!.clientWidth;
  mouseVector.y = (xy[1] + 0.5) / viewer.mutable.current.canvas!.clientHeight;
  return mouseVector;
}
import {
  CoordinateFrame,
  InstancedAxes,
  PointCloud,
  ViserImage,
  ViserLabel,
} from "./ThreeAssets";
import { CameraFrustumComponent } from "./CameraFrustumVariants";
import { SceneNodeMessage } from "./WebsocketMessages";
import { SplatObject } from "./Splatting/GaussianSplats";
import { Paper } from "@mantine/core";
import GeneratedGuiContainer from "./ControlPanel/Generated";
import { LineSegments } from "./Line";
import { shadowArgs } from "./ShadowArgs";
import { CsmDirectionalLight } from "./CsmDirectionalLight";
import { BasicMesh } from "./mesh/BasicMesh";
import { BoxMesh } from "./mesh/BoxMesh";
import { IcosphereMesh } from "./mesh/IcosphereMesh";
import { CylinderMesh } from "./mesh/CylinderMesh";
import { SkinnedMesh } from "./mesh/SkinnedMesh";
import { BatchedMesh } from "./mesh/BatchedMesh";
import { SingleGlbAsset } from "./mesh/SingleGlbAsset";
import { BatchedGlbAsset } from "./mesh/BatchedGlbAsset";
import { normalizeScale } from "./utils/normalizeScale";

function rgbToInt(rgb: [number, number, number]): number {
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

/** Type corresponding to a zustand-style useSceneTree hook. */
export type UseSceneTree = ReturnType<typeof useSceneTreeState>;

/** Component for updating attributes of a scene node. */
function SceneNodeLabel(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const labelVisible = viewer.useSceneTree(
    (state) => state[props.name]?.labelVisible,
  );
  return labelVisible ? (
    <Html>
      <span
        style={{
          backgroundColor: "rgba(240, 240, 240, 0.9)",
          color: "#333",
          borderRadius: "0.2rem",
          userSelect: "none",
          padding: "0.1em 0.2em",
        }}
      >
        {props.name}
      </span>
    </Html>
  ) : null;
}

function tripletListFromFloat32Buffer(data: Uint8Array<ArrayBufferLike>) {
  const arrayView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const triplets: [number, number, number][] = [];
  for (let i = 0; i < arrayView.byteLength; i += 12) {
    triplets.push([
      arrayView.getFloat32(i, true), // little-endian
      arrayView.getFloat32(i + 4, true),
      arrayView.getFloat32(i + 8, true),
    ]);
  }
  return triplets;
}

export type MakeObject = (
  ref: React.Ref<any>,
  children: React.ReactNode,
) => React.ReactNode;

function createObjectFactory(
  message: SceneNodeMessage | undefined,
  viewer: ViewerContextContents,
  ContextBridge: ContextBridge,
): {
  makeObject: MakeObject;
  unmountWhenInvisible?: boolean;
  computeClickInstanceIndexFromInstanceId?: (
    instanceId: number | undefined,
  ) => number | null;
} {
  if (message === undefined) return { makeObject: () => null };

  switch (message.type) {
    // Add a coordinate frame.
    case "FrameMessage": {
      return {
        makeObject: (ref, children) => (
          <CoordinateFrame
            ref={ref}
            showAxes={message.props.show_axes}
            axesLength={message.props.axes_length}
            axesRadius={message.props.axes_radius}
            originRadius={message.props.origin_radius}
            originColor={rgbToInt(message.props.origin_color)}
            scale={message.props.scale}
          >
            {children}
          </CoordinateFrame>
        ),
      };
    }

    // Add axes to visualize.
    case "BatchedAxesMessage": {
      return {
        makeObject: (ref, children) => (
          <InstancedAxes
            ref={ref}
            batched_wxyzs={message.props.batched_wxyzs}
            batched_positions={message.props.batched_positions}
            batched_scales={message.props.batched_scales}
            axes_length={message.props.axes_length}
            axes_radius={message.props.axes_radius}
            scale={message.props.scale}
          >
            {children}
          </InstancedAxes>
        ),
        // Compute click instance index from instance ID. Each visualized
        // frame has 1 instance for each of 3 line segments.
        computeClickInstanceIndexFromInstanceId: (instanceId) =>
          Math.floor(instanceId! / 3),
      };
    }

    case "GridMessage": {
      const gridQuaternion = new THREE.Quaternion().setFromEuler(
        // There's redundancy here when we set the side to
        // THREE.DoubleSide, where xy and yx should be the same.
        //
        // But it makes sense to keep this parameterization because
        // specifying planes by xy seems more natural than the normal
        // direction (z, +z, or -z), and it opens the possibility of
        // rendering only FrontSide or BackSide grids in the future.
        //
        // If we add support for FrontSide or BackSide, we should
        // double-check that the normal directions from each of these
        // rotations match the right-hand rule!
        message.props.plane == "xz"
          ? new THREE.Euler(0.0, 0.0, 0.0)
          : message.props.plane == "xy"
            ? new THREE.Euler(Math.PI / 2.0, 0.0, 0.0)
            : message.props.plane == "yx"
              ? new THREE.Euler(0.0, Math.PI / 2.0, Math.PI / 2.0)
              : message.props.plane == "yz"
                ? new THREE.Euler(0.0, 0.0, Math.PI / 2.0)
                : message.props.plane == "zx"
                  ? new THREE.Euler(0.0, Math.PI / 2.0, 0.0)
                  : //message.props.plane == "zy"
                    new THREE.Euler(-Math.PI / 2.0, 0.0, -Math.PI / 2.0),
      );

      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <group scale={normalizeScale(message.props.scale)}>
              <Grid
                args={[message.props.width, message.props.height]}
                side={THREE.DoubleSide}
                cellColor={rgbToInt(message.props.cell_color)}
                cellThickness={message.props.cell_thickness}
                cellSize={message.props.cell_size}
                sectionColor={rgbToInt(message.props.section_color)}
                sectionThickness={message.props.section_thickness}
                sectionSize={message.props.section_size}
                infiniteGrid={message.props.infinite_grid}
                fadeDistance={message.props.fade_distance}
                fadeStrength={message.props.fade_strength}
                fadeFrom={message.props.fade_from === "camera" ? 1 : 0}
                planeColor={rgbToInt(message.props.plane_color)}
                planeOpacity={message.props.plane_opacity}
                shadowOpacity={message.props.shadow_opacity}
                quaternion={gridQuaternion}
              />
            </group>
            {children}
          </group>
        ),
      };
    }

    // Add a point cloud.
    case "PointCloudMessage": {
      return {
        makeObject: (ref, children) => (
          <PointCloud ref={ref} {...message}>
            {children}
          </PointCloud>
        ),
      };
    }

    // Add mesh
    case "SkinnedMeshMessage": {
      return {
        makeObject: (ref, children) => (
          <SkinnedMesh ref={ref} {...message}>
            {children}
          </SkinnedMesh>
        ),
      };
    }
    case "MeshMessage": {
      return {
        makeObject: (ref, children) => (
          <BasicMesh ref={ref} {...message}>
            {children}
          </BasicMesh>
        ),
      };
    }
    case "BoxMessage": {
      return {
        makeObject: (ref, children) => (
          <BoxMesh ref={ref} {...message}>
            {children}
          </BoxMesh>
        ),
      };
    }
    case "IcosphereMessage": {
      return {
        makeObject: (ref, children) => (
          <IcosphereMesh ref={ref} {...message}>
            {children}
          </IcosphereMesh>
        ),
      };
    }
    case "CylinderMessage": {
      return {
        makeObject: (ref, children) => (
          <CylinderMesh ref={ref} {...message}>
            {children}
          </CylinderMesh>
        ),
      };
    }
    case "BatchedMeshesMessage": {
      return {
        makeObject: (ref, children) => (
          <BatchedMesh ref={ref} {...message}>
            {children}
          </BatchedMesh>
        ),
        computeClickInstanceIndexFromInstanceId:
          message.type === "BatchedMeshesMessage"
            ? (instanceId) => instanceId!
            : undefined,
      };
    }
    // Add a camera frustum.
    case "CameraFrustumMessage": {
      return {
        makeObject: (ref, children) => (
          <CameraFrustumComponent ref={ref} {...message}>
            {children}
          </CameraFrustumComponent>
        ),
      };
    }

    // Add a transform control, centered at current object.
    case "TransformControlsMessage": {
      const { send: sendDragMessage, flush: flushDragMessage } =
        makeThrottledMessageSender(viewer, 50);
      // We track drag state to prevent duplicate drag end events.
      // This variable persists in the closure created by makeObject,
      // so we don't need useRef here.
      let isDragging = false;
      return {
        makeObject: (ref, children) => (
          <group onClick={(e) => e.stopPropagation()}>
            <PivotControls
              ref={ref}
              scale={message.props.scale}
              lineWidth={message.props.line_width}
              fixed={message.props.fixed}
              activeAxes={message.props.active_axes}
              disableAxes={message.props.disable_axes}
              disableSliders={message.props.disable_sliders}
              disableRotations={message.props.disable_rotations}
              disableScaling={true}
              translationLimits={message.props.translation_limits}
              rotationLimits={message.props.rotation_limits}
              depthTest={message.props.depth_test}
              opacity={message.props.opacity}
              onDragStart={() => {
                isDragging = true;
                viewer.mutable.current.sendMessage({
                  type: "TransformControlsDragStartMessage",
                  name: message.name,
                });
              }}
              onDrag={(l) => {
                const wxyz = new THREE.Quaternion();
                wxyz.setFromRotationMatrix(l);
                const position = new THREE.Vector3().setFromMatrixPosition(l);

                // Update node attributes in scene tree state.
                const wxyzArray = [wxyz.w, wxyz.x, wxyz.y, wxyz.z] as [
                  number,
                  number,
                  number,
                  number,
                ];
                const positionArray = position.toArray() as [
                  number,
                  number,
                  number,
                ];
                viewer.sceneTreeActions.updateNodeAttributes(message.name, {
                  wxyz: wxyzArray,
                  position: positionArray,
                });
                sendDragMessage({
                  type: "TransformControlsUpdateMessage",
                  name: message.name,
                  wxyz: wxyzArray,
                  position: positionArray,
                });
              }}
              onDragEnd={() => {
                if (isDragging) {
                  isDragging = false;
                  flushDragMessage();
                  viewer.mutable.current.sendMessage({
                    type: "TransformControlsDragEndMessage",
                    name: message.name,
                  });
                }
              }}
            >
              {children}
            </PivotControls>
          </group>
        ),
        unmountWhenInvisible: true,
      };
    }
    // Add a 2D label.
    case "LabelMessage": {
      return {
        makeObject: (ref, children) => (
          <ViserLabel ref={ref} {...message}>
            {children}
          </ViserLabel>
        ),
        unmountWhenInvisible: false,
      };
    }
    case "Gui3DMessage": {
      return {
        makeObject: (ref, children) => {
          // We wrap with <group /> because Html doesn't implement
          // THREE.Object3D.
          return (
            <group ref={ref}>
              <Html>
                <ContextBridge>
                  <Paper
                    style={{
                      width: "18em",
                      fontSize: "0.875em",
                      marginLeft: "0.5em",
                      marginTop: "0.5em",
                    }}
                    shadow="0 0 0.8em 0 rgba(0,0,0,0.1)"
                    pb="0.25em"
                    onPointerDown={(evt) => {
                      evt.stopPropagation();
                    }}
                  >
                    <GeneratedGuiContainer
                      containerUuid={message.props.container_uuid}
                    />
                  </Paper>
                </ContextBridge>
              </Html>
              {children}
            </group>
          );
        },
        unmountWhenInvisible: true,
      };
    }
    // Add an image.
    case "ImageMessage": {
      return {
        makeObject: (ref, children) => (
          <ViserImage ref={ref} {...message}>
            {children}
          </ViserImage>
        ),
      };
    }
    // Add a glTF/GLB asset.
    case "GlbMessage": {
      return {
        makeObject: (ref, children) => (
          <SingleGlbAsset ref={ref} {...message}>
            {children}
          </SingleGlbAsset>
        ),
      };
    }
    case "BatchedGlbMessage": {
      return {
        makeObject: (ref, children) => (
          <BatchedGlbAsset ref={ref} {...message}>
            {children}
          </BatchedGlbAsset>
        ),
        computeClickInstanceIndexFromInstanceId: (instanceId) => instanceId!,
      };
    }
    case "LineSegmentsMessage": {
      return {
        makeObject: (ref, children) => (
          <LineSegments ref={ref} {...message}>
            {children}
          </LineSegments>
        ),
      };
    }
    case "CatmullRomSplineMessage": {
      return {
        makeObject: (ref, children) => {
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                <CatmullRomLine
                  points={tripletListFromFloat32Buffer(message.props.points)}
                  closed={message.props.closed}
                  curveType={message.props.curve_type}
                  tension={message.props.tension}
                  lineWidth={message.props.line_width}
                  color={rgbToInt(message.props.color)}
                  // Sketchy cast needed due to https://github.com/pmndrs/drei/issues/1476.
                  segments={(message.props.segments ?? undefined) as undefined}
                />
              </group>
              {children}
            </group>
          );
        },
      };
    }
    case "CubicBezierSplineMessage": {
      return {
        makeObject: (ref, children) => {
          const points = tripletListFromFloat32Buffer(message.props.points);
          const controlPoints = tripletListFromFloat32Buffer(
            message.props.control_points,
          );
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                {[...Array(points.length - 1).keys()].map((i) => (
                  <CubicBezierLine
                    key={i}
                    start={points[i]}
                    end={points[i + 1]}
                    midA={controlPoints[2 * i]}
                    midB={controlPoints[2 * i + 1]}
                    lineWidth={message.props.line_width}
                    color={rgbToInt(message.props.color)}
                    // Sketchy cast needed due to https://github.com/pmndrs/drei/issues/1476.
                    segments={
                      (message.props.segments ?? undefined) as undefined
                    }
                  ></CubicBezierLine>
                ))}
              </group>
              {children}
            </group>
          );
        },
      };
    }
    case "GaussianSplatsMessage": {
      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <group scale={normalizeScale(message.props.scale)}>
              <SplatObject
                buffer={
                  new Uint32Array(
                    message.props.buffer.buffer.slice(
                      message.props.buffer.byteOffset,
                      message.props.buffer.byteOffset +
                        message.props.buffer.byteLength,
                    ),
                  )
                }
              />
            </group>
            {children}
          </group>
        ),
      };
    }

    // Add a directional light
    case "DirectionalLightMessage": {
      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <CsmDirectionalLight
              lightIntensity={message.props.intensity}
              color={rgbToInt(message.props.color)}
              castShadow={message.props.cast_shadow}
            />
            {children}
          </group>
        ),
        // CsmDirectionalLight is not influenced by visibility, since the
        // lights it adds are portaled to the scene root.
        unmountWhenInvisible: true,
      };
    }

    // Add an ambient light
    // Cannot cast shadows
    case "AmbientLightMessage": {
      return {
        makeObject: (ref, children) => (
          <ambientLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
          >
            {children}
          </ambientLight>
        ),
      };
    }

    // Add a hemisphere light
    // Cannot cast shadows
    case "HemisphereLightMessage": {
      return {
        makeObject: (ref, children) => (
          <hemisphereLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.sky_color)}
            groundColor={rgbToInt(message.props.ground_color)}
          >
            {children}
          </hemisphereLight>
        ),
      };
    }

    // Add a point light
    case "PointLightMessage": {
      return {
        makeObject: (ref, children) => (
          <pointLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
            distance={message.props.distance}
            decay={message.props.decay}
            castShadow={message.props.cast_shadow}
            {...shadowArgs}
          >
            {children}
          </pointLight>
        ),
      };
    }
    // Add a rectangular area light
    // Cannot cast shadows
    case "RectAreaLightMessage": {
      return {
        makeObject: (ref, children) => (
          <rectAreaLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
            width={message.props.width}
            height={message.props.height}
          >
            {children}
          </rectAreaLight>
        ),
      };
    }

    // Add a spot light
    case "SpotLightMessage": {
      return {
        makeObject: (ref, children) => (
          <spotLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
            distance={message.props.distance}
            angle={message.props.angle}
            penumbra={message.props.penumbra}
            decay={message.props.decay}
            castShadow={message.props.cast_shadow}
            {...shadowArgs}
          >
            {children}
          </spotLight>
        ),
      };
    }
    default: {
      console.log("Received message did not match any known types:", message);
      return { makeObject: () => null };
    }
  }
}

export function SceneNodeThreeObject(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const message = viewer.useSceneTree((state) => state[props.name]?.message);
  const ContextBridge = useContextBridge();
  const updateNodeAttributes = viewer.sceneTreeActions.updateNodeAttributes;

  const {
    makeObject,
    unmountWhenInvisible,
    computeClickInstanceIndexFromInstanceId,
  } = React.useMemo(
    () => createObjectFactory(message, viewer, ContextBridge),
    [message, viewer, ContextBridge],
  );

  const [unmount, setUnmount] = React.useState(false);
  const clickable =
    viewer.useSceneTree((state) => state[props.name]?.clickable) ?? false;
  const objRef = React.useRef<THREE.Object3D | null>(null);
  const groupRef = React.useRef<THREE.Group>();

  // Get children.
  const children = React.useMemo(
    () => <SceneNodeChildren name={props.name} />,
    [],
  );

  // Create object + children.
  //
  // For not-fully-understood reasons, wrapping makeObject with useMemo() fixes
  // stability issues (eg breaking runtime errors) associated with
  // PivotControls.
  const viewerMutable = viewer.mutable.current;
  const objNode = React.useMemo(() => {
    if (makeObject === undefined) return null;
    return makeObject((ref: THREE.Object3D) => {
      objRef.current = ref;
      viewerMutable.nodeRefFromName[props.name] = objRef.current;
    }, children);
  }, [makeObject, children]);

  // Helper for transient visibility checks. Uses the cached effectiveVisibility
  // which includes both this node and all ancestors in the scene tree.
  //
  // This is used for (1) suppressing click events and (2) unmounting when
  // unmountWhenInvisible is true. The latter is used for <Html /> components.
  function isDisplayed(): boolean {
    const node = viewer.useSceneTree.getState()[props.name];
    return node?.effectiveVisibility ?? false;
  }

  // Pose needs to be updated whenever component is remounted / object is re-created.
  React.useEffect(() => {
    updateNodeAttributes(props.name, {
      poseUpdateState: "needsUpdate",
    });
  }, [objNode]);

  // Track hover state.
  const hoveredRef = React.useRef<HoverState>({
    isHovered: false,
    instanceId: null,
  });

  // Track last pointer position for re-raycasting when mesh changes.
  const lastPointerPos = React.useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);

  // Frame counter for delayed hover recheck after objNode changes.
  // We wait a few frames to ensure the new mesh geometry is fully rendered.
  const hoverRecheckCountdown = React.useRef(0);
  const isFirstObjNode = React.useRef(true);
  React.useEffect(() => {
    if (isFirstObjNode.current) {
      isFirstObjNode.current = false;
      return;
    }
    if (hoveredRef.current.isHovered) {
      // Wait 2 frames for the new mesh to be fully rendered.
      hoverRecheckCountdown.current = 2;
    }
  }, [objNode]);

  // Get R3F state for raycasting.
  const { raycaster, camera } = useThree();

  // Reusable Vector2 for hover recheck raycasting.
  const pointerNDC = React.useMemo(() => new THREE.Vector2(), []);

  // Update attributes on a per-frame basis. Currently does redundant work,
  // although this shouldn't be a bottleneck.
  useFrame(
    () => {
      // Re-check hover state after objNode changes (mesh geometry update).
      if (hoverRecheckCountdown.current > 0) {
        hoverRecheckCountdown.current--;
        if (
          hoverRecheckCountdown.current === 0 &&
          hoveredRef.current.isHovered &&
          groupRef.current &&
          lastPointerPos.current
        ) {
          // Compute NDC from stored pointer position.
          const canvas = viewerMutable.canvas;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            pointerNDC.set(
              ((lastPointerPos.current.clientX - rect.left) / rect.width) * 2 -
                1,
              -((lastPointerPos.current.clientY - rect.top) / rect.height) * 2 +
                1,
            );
            raycaster.setFromCamera(pointerNDC, camera);
            const intersects = raycaster.intersectObject(
              groupRef.current,
              true,
            );
            if (intersects.length === 0) {
              // Pointer is no longer over this mesh, reset hover state.
              hoveredRef.current.isHovered = false;
              hoveredRef.current.instanceId = null;
              viewerMutable.hoveredElementsCount--;
              if (viewerMutable.hoveredElementsCount === 0) {
                document.body.style.cursor = "auto";
              }
            }
          }
        }
      }

      // Use getState() for performance in render loops (no re-renders).
      const node = viewer.useSceneTree.getState()[props.name];

      // Unmount when invisible.
      // Examples: <Html /> components, PivotControls.
      //
      // This is a workaround for situations where just setting `visible` doesn't
      // work (like <Html />), or to prevent invisible elements from being
      // interacted with (<PivotControls />).
      //
      // https://github.com/pmndrs/drei/issues/1323
      if (unmountWhenInvisible) {
        const displayed = isDisplayed();
        if (displayed && unmount) {
          if (objRef.current !== null) objRef.current.visible = false;
          updateNodeAttributes(props.name, {
            poseUpdateState: "needsUpdate",
          });
          setUnmount(false);
        }
        if (!displayed && !unmount) {
          setUnmount(true);
        }
      }

      if (objRef.current === null) return;
      if (node === undefined) return;

      // Set node-local visibility. Three.js automatically handles parent chain
      // propagation (children of invisible parents are not rendered).
      objRef.current.visible =
        node.overrideVisibility ?? node.visibility ?? true;

      if (node.poseUpdateState == "needsUpdate") {
        // Update pose state through zustand action.
        updateNodeAttributes(props.name, {
          poseUpdateState: "updated",
        });

        if (message!.type !== "LabelMessage") {
          const wxyz = node.wxyz ?? [1, 0, 0, 0];
          objRef.current.quaternion.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
        }
        const position = node.position ?? [0, 0, 0];
        objRef.current.position.set(position[0], position[1], position[2]);

        // Update matrices if necessary. This is necessary for PivotControls.
        if (!objRef.current.matrixAutoUpdate) objRef.current.updateMatrix();
        if (!objRef.current.matrixWorldAutoUpdate)
          objRef.current.updateMatrixWorld();
      }
    },
    // Other useFrame hooks may depend on transforms + visibility. So it's best
    // to call this hook early.
    //
    // However, it's also important that this is *higher* than the priority for
    // the MessageHandler's useFrame. This is to make sure that transforms are
    // updated in the same frame that they are set.
    -1000,
  );

  // Clicking logic.
  const sendClicksThrottled = useThrottledMessageSender(50).send;

  // Handle case where clickable is toggled to false while still hovered.
  if (!clickable && hoveredRef.current.isHovered) {
    hoveredRef.current.isHovered = false;
    viewerMutable.hoveredElementsCount--;
    if (viewerMutable.hoveredElementsCount === 0) {
      document.body.style.cursor = "auto";
    }
  }

  // Reset hover state on unmount only.
  useEffect(() => {
    return () => {
      if (hoveredRef.current.isHovered) {
        hoveredRef.current.isHovered = false;
        viewerMutable.hoveredElementsCount--;
        if (viewerMutable.hoveredElementsCount === 0) {
          document.body.style.cursor = "auto";
        }
      }
    };
  }, []);

  const dragInfo = React.useRef({
    dragging: false,
    startClientX: 0,
    startClientY: 0,
  });

  if (objNode === undefined || unmount) {
    return null;
  } else {
    return (
      <>
        <group
          ref={groupRef}
          // Instead of using onClick, we use onPointerDown/Move/Up to check mouse drag,
          // and only send a click if the mouse hasn't moved between the down and up events.
          //  - onPointerDown resets the click state (dragged = false)
          //  - onPointerMove, if triggered, sets dragged = true
          //  - onPointerUp, if triggered, sends a click if dragged = false.
          // Note: It would be cool to have dragged actions too...
          onPointerDown={
            !clickable
              ? undefined
              : (e) => {
                  if (!isDisplayed()) return;
                  e.stopPropagation();
                  const state = dragInfo.current;
                  const canvasBbox =
                    viewerMutable.canvas!.getBoundingClientRect();
                  state.startClientX = e.clientX - canvasBbox.left;
                  state.startClientY = e.clientY - canvasBbox.top;
                  state.dragging = false;
                }
          }
          onPointerMove={
            !clickable
              ? undefined
              : (e) => {
                  if (!isDisplayed()) return;
                  e.stopPropagation();

                  // Update pointer position for re-raycasting when mesh changes.
                  lastPointerPos.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                  };

                  const state = dragInfo.current;
                  const canvasBbox =
                    viewerMutable.canvas!.getBoundingClientRect();
                  const deltaX =
                    e.clientX - canvasBbox.left - state.startClientX;
                  const deltaY =
                    e.clientY - canvasBbox.top - state.startClientY;
                  // Minimum motion.
                  if (Math.abs(deltaX) <= 3 && Math.abs(deltaY) <= 3) return;
                  state.dragging = true;
                }
          }
          onPointerUp={
            !clickable
              ? undefined
              : (e) => {
                  if (!isDisplayed()) return;
                  e.stopPropagation();
                  const state = dragInfo.current;
                  if (state.dragging) return;
                  // Convert ray to viser coordinates.
                  const ray = rayToViserCoords(viewer, e.ray);

                  // Send OpenCV image coordinates to the server (normalized).
                  const canvasBbox =
                    viewerMutable.canvas!.getBoundingClientRect();
                  const mouseVectorOpenCV = opencvXyFromPointerXy(viewer, [
                    e.clientX - canvasBbox.left,
                    e.clientY - canvasBbox.top,
                  ]);

                  sendClicksThrottled({
                    type: "SceneNodeClickMessage",
                    name: props.name,
                    instance_index:
                      computeClickInstanceIndexFromInstanceId === undefined
                        ? null
                        : computeClickInstanceIndexFromInstanceId(e.instanceId),
                    // Note that the threejs up is +Y, but we expose a +Z up.
                    ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
                    ray_direction: [
                      ray.direction.x,
                      ray.direction.y,
                      ray.direction.z,
                    ],
                    screen_pos: [mouseVectorOpenCV.x, mouseVectorOpenCV.y],
                  });
                }
          }
          onPointerOver={
            !clickable
              ? undefined
              : (e) => {
                  if (!isDisplayed()) return;
                  e.stopPropagation();

                  // Store pointer position for re-raycasting when mesh changes.
                  lastPointerPos.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                  };

                  // Guard against double-increment if already hovered.
                  if (hoveredRef.current.isHovered) return;

                  // Update hover state
                  hoveredRef.current.isHovered = true;
                  // Store the instanceId in the hover ref
                  hoveredRef.current.instanceId = e.instanceId ?? null;

                  // Increment global hover count and update cursor
                  viewerMutable.hoveredElementsCount++;
                  if (viewerMutable.hoveredElementsCount === 1) {
                    document.body.style.cursor = "pointer";
                  }
                }
          }
          onPointerOut={
            !clickable
              ? undefined
              : () => {
                  if (!isDisplayed()) return;
                  // Guard against decrementing if already reset (e.g., by objNode change).
                  if (!hoveredRef.current.isHovered) return;

                  // Update hover state
                  hoveredRef.current.isHovered = false;
                  // Clear the instanceId when no longer hovering
                  hoveredRef.current.instanceId = null;

                  // Decrement global hover count and update cursor if needed
                  viewerMutable.hoveredElementsCount--;
                  if (viewerMutable.hoveredElementsCount === 0) {
                    document.body.style.cursor = "auto";
                  }
                }
          }
        >
          <HoverableContext.Provider value={{ state: hoveredRef, clickable }}>
            {objNode}
          </HoverableContext.Provider>
        </group>
      </>
    );
  }
}

function SceneNodeChildren(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const childrenNames = viewer.useSceneTree(
    (state) => state[props.name]?.children,
    shallowArrayEqual,
  );
  return (
    <>
      {childrenNames &&
        childrenNames.map((child_id) => (
          <SceneNodeThreeObject key={child_id} name={child_id} />
        ))}
      <SceneNodeLabel name={props.name} />
    </>
  );
}
