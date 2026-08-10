import { notifications } from "@mantine/notifications";

import React, { useContext } from "react";
import * as THREE from "three";
import { TextureLoader } from "three";
import { toMantineColor } from "./components/colorUtils";

import { createParkedSceneUpdates } from "./batchedSceneUpdates";
import { ViewerContext, variantKey } from "./ViewerContext";
import {
  FileTransferPart,
  FileTransferStartDownload,
  Message,
  SceneNodeMessage,
  GuiComponentMessage,
  isGuiComponentMessage,
  isSceneNodeMessage,
} from "./WebsocketMessages";
import { isTexture } from "./WebsocketUtils";
import { useFrame, useThree } from "@react-three/fiber";
import { Button, Progress } from "@mantine/core";
import { IconCheck, IconDownload } from "@tabler/icons-react";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { ownerOf, rootNodeTemplate, SceneNode } from "./SceneTreeState";
import { applyGuiConfigUpdate } from "./ControlPanel/GuiState";
import { GaussianSplatsContext } from "./Splatting/GaussianSplatsHelpers";

/** Swap a background-material uniform to a new texture (or null), disposing the
 * previous texture if there was one. */
function swapBackgroundTexture(
  uniform: THREE.IUniform,
  next: THREE.Texture | null,
) {
  const old = uniform.value;
  uniform.value = next;
  if (isTexture(old)) old.dispose();
}

// Per-uniform load sequence. Background-image decode is async, so without a
// token a stale load resolving late could overwrite a newer image AND dispose
// the newer texture (common when streaming `set_background_image` per frame).
// Every new load and every synchronous clear bumps the uniform's token; an
// async callback installs its result only if the token is still current.
const backgroundTextureSeq = new WeakMap<THREE.IUniform, number>();
function bumpBackgroundTextureSeq(uniform: THREE.IUniform): number {
  const next = (backgroundTextureSeq.get(uniform) ?? 0) + 1;
  backgroundTextureSeq.set(uniform, next);
  return next;
}

/** Load image data into a background-material uniform, disposing the previous
 * texture once the new one is ready. Revokes the object URL on success and on
 * failure so it never leaks. Stale loads (superseded by a newer load/clear) are
 * dropped and their decoded texture disposed. */
function loadBackgroundTexture(
  data: Uint8Array<ArrayBuffer>,
  format: string,
  uniform: THREE.IUniform,
) {
  const seq = bumpBackgroundTextureSeq(uniform);
  const url = URL.createObjectURL(
    new Blob([data], { type: "image/" + format }),
  );
  new TextureLoader().load(
    url,
    (texture) => {
      URL.revokeObjectURL(url);
      if (backgroundTextureSeq.get(uniform) !== seq) {
        // A newer load/clear superseded this one; don't install the stale image.
        texture.dispose();
        return;
      }
      swapBackgroundTexture(uniform, texture);
    },
    undefined,
    () => URL.revokeObjectURL(url),
  );
}

/** Returns a handler for all incoming messages. */
function useMessageHandler() {
  const viewer = useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;

  const addSceneNode = viewer.sceneTreeActions.addSceneNode;
  const setTheme = viewer.guiActions.setTheme;

  // Initial camera store actions for updating reset view state.
  const initialCameraActions = viewer.initialCameraActions;
  const setShareUrl = viewer.guiActions.setShareUrl;
  const addGui = viewer.guiActions.addGui;
  const addModal = viewer.guiActions.addModal;
  const removeModal = viewer.guiActions.removeModal;
  const addPanel = viewer.guiActions.addPanel;
  const removePanel = viewer.guiActions.removePanel;
  const removeGui = viewer.guiActions.removeGui;
  const updateUploadState = viewer.guiActions.updateUploadState;
  const setFormDirty = viewer.guiActions.setFormDirty;
  const clearFormDirty = viewer.guiActions.clearFormDirty;
  const addCommand = viewer.guiActions.addCommand;
  const updateCommand = viewer.guiActions.updateCommand;
  const removeCommand = viewer.guiActions.removeCommand;

  // Same as addSceneNode, but make a parent in the form of a dummy coordinate
  // frame if it doesn't exist yet.
  function addSceneNodeMakeParents(message: SceneNodeMessage) {
    // Make sure scene node is in attributes.
    const currentNode = viewer.useSceneTree.get(message.name);

    // Make sure parents exists. (Rarely needed on the live wire -- the
    // server sends same-scope virtual anchors for missing ancestors before
    // the child -- but kept for old recordings.)
    const parentName = message.name.split("/").slice(0, -1).join("/");
    if (viewer.useSceneTree.get(parentName)?.message === undefined) {
      addSceneNodeMakeParents({
        ...rootNodeTemplate.message,
        name: parentName,
      });
      viewer.sceneTreeActions.updateNodeAttributes(parentName, {
        visibility: true,
      });
    }
    const disposition = addSceneNode(message);

    // If the object is new or changed, we need to wait until it's created
    // before updating its pose. Updating the pose too early can cause
    // flickering when we replace objects (old object will take the pose of the new
    // object while it's being loaded/mounted). Skipped when the add was
    // parked in the shadow slot (lower-ranked variant): the EFFECTIVE node
    // did not change, and freezing its pose on waitForMakeObject would wait
    // for a remount that never happens.
    if (disposition === "effective" && message !== currentNode?.message) {
      const pose = viewerMutable.nodePoseData[message.name];
      if (pose) {
        pose.poseUpdateState = "waitForMakeObject";
      } else {
        viewerMutable.nodePoseData[message.name] = {
          wxyz: [1, 0, 0, 0],
          position: [0, 0, 0],
          poseUpdateState: "waitForMakeObject",
        };
      }
    }
  }

  const fileDownloadHandler = useFileDownloadHandler();

  // Return type for the message handler. Messages either:
  // - Return undefined (handled immediately, no batching needed)
  // - Return a scene node update (attributes and/or props) to be batched
  // - Return a GUI update to be batched
  type HandleMessageResult =
    | undefined
    | {
        kind: "sceneNodeAttrUpdate";
        targetNode: string;
        updates: Partial<SceneNode>;
      }
    | {
        kind: "sceneNodePropsUpdate";
        targetNode: string;
        propsUpdates: { [key: string]: any };
      }
    | {
        kind: "guiUpdate";
        uuid: string;
        updates: { [key: string]: any };
      };

  // Shared prologue for the SetCamera{Fov,Near,Far} handlers. When a message
  // carries initial-camera state, record it (URL params take priority) and
  // stop unless this is the first initial camera. Returns whether the caller
  // should still apply the value to the live camera.
  function applyInitialCameraParam(
    field: "fov" | "near" | "far",
    isInitial: boolean,
    setInitial: () => void,
  ): boolean {
    const wasDefault =
      viewer.useInitialCamera.get()[field].source === "default";
    if (isInitial) {
      // URL params take priority, ignore server's initial value.
      setInitial();
      // If this is the first initial camera: we'll also move the actual
      // camera. If not, we return immediately.
      if (!wasDefault) return false;
    }
    return true;
  }

  // Return message handler.
  return (message: Message): HandleMessageResult => {
    if (isGuiComponentMessage(message)) {
      addGui(message);
      return;
    }

    if (isSceneNodeMessage(message)) {
      // Initialize skinned mesh state.
      if (message.type === "SkinnedMeshMessage") {
        // Reset an existing entry IN PLACE rather than replacing it:
        // FilePlayback's loop/seek re-pushes the same add message into a
        // scene whose nodes were deliberately kept mounted (its resetScene
        // hides instead of removing), so the mounted SkinnedMesh instance's
        // claimed entry must remain THE entry. A fresh object stranded the
        // component's ownership guard on a dead reference, freezing every
        // bone update from the second loop onward. A real remove + re-add
        // deletes the entry first, so a NEW component still claims a fresh
        // object and the same-name re-add race stays protected.
        const state = (viewerMutable.skinnedMeshState[
          variantKey(message.owner, message.name)
        ] ??= {
          initialized: false,
          claimed: false,
          poses: [],
          dirty: false,
        });
        state.initialized = false;
        // Bind pose is the honest state until bone updates arrive; on a
        // playback loop this also snaps loop-end poses back to bind.
        state.dirty = true;
        state.poses.length = 0;

        // Bone data arrives as Float32Array views. Use directly.
        const bone_wxyzs = message.props.bone_wxyzs;
        const bone_positions = message.props.bone_positions;
        const numBones = bone_positions.length / 3;
        for (let i = 0; i < numBones; i++) {
          state.poses.push({
            wxyz: [
              bone_wxyzs[4 * i],
              bone_wxyzs[4 * i + 1],
              bone_wxyzs[4 * i + 2],
              bone_wxyzs[4 * i + 3],
            ],
            position: [
              bone_positions[3 * i],
              bone_positions[3 * i + 1],
              bone_positions[3 * i + 2],
            ],
          });
        }
      }

      // Add scene node.
      addSceneNodeMakeParents(message);
      return;
    }

    switch (message.type) {
      case "SceneNodeUpdateMessage": {
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { propsUpdates: message.updates },
          )
        )
          return;
        return {
          kind: "sceneNodePropsUpdate",
          targetNode: message.name,
          propsUpdates: message.updates,
        };
      }
      // Set the share URL.
      case "ShareUrlUpdated": {
        setShareUrl(message.share_url);
        return;
      }
      // Request a render. "commit_wait" gives React one frame to commit any
      // scene updates processed in the same batch; the message-processing
      // loop upgrades this to "capture" directly when the request arrived
      // with no preceding messages (nothing pending a commit).
      case "GetRenderRequestMessage": {
        viewerMutable.getRenderRequest = message;
        viewerMutable.getRenderRequestState = "commit_wait";
        return;
      }
      // Set the GUI panel label.
      case "SetGuiPanelLabelMessage": {
        viewer.useGui.set({ label: message.label ?? "" });
        return;
      }
      // Write-only, per-axis panel placement commands. Each merges its single
      // field into the client-owned placement entry (keyed by panel uuid, or
      // CONTROL_PANEL_ID for the main control panel); the dock applies whatever
      // is present.
      case "GuiSetPanelPositionMessage": {
        viewer.guiActions.setPanelPosition(
          message.uuid,
          message.position,
          message.counter,
          message.run_id,
        );
        return;
      }
      case "GuiSetPanelWidthMessage": {
        viewer.guiActions.setPanelWidth(
          message.uuid,
          message.width,
          message.counter,
          message.run_id,
        );
        return;
      }
      case "GuiSetPanelHeightMessage": {
        viewer.guiActions.setPanelHeight(
          message.uuid,
          message.height,
          message.counter,
          message.run_id,
        );
        return;
      }
      case "GuiSetPanelCollapsedMessage": {
        viewer.guiActions.setPanelCollapsed(
          message.uuid,
          message.collapsed,
          message.counter,
          message.run_id,
        );
        return;
      }
      // End-of-replay marker: the (re)connect replay of the persistent buffer
      // is complete. Ends the reconnect phase -- dormant dock registrations
      // whose panel was not revived get purged, and layout tracking is pruned
      // at this (and only this) provably-complete point.
      case "ReplayDoneMessage": {
        viewer.guiActions.replayDone();
        return;
      }
      // Configure the theme.
      case "ThemeConfigurationMessage": {
        setTheme(message);
        return;
      }

      // Run some arbitrary Javascript.
      // This is used for plotting, where the Python server will send over a
      // copy of plotly.min.js for the currently-installed version of plotly.
      case "RunJavascriptMessage": {
        new Function(message.source)();
        return;
      }

      // Show or update a notification. Show and Update carry the same
      // NotificationProps shape, so one construction works for both.
      case "NotificationShowMessage":
      case "NotificationUpdateMessage": {
        const fn =
          message.type === "NotificationShowMessage"
            ? notifications.show
            : notifications.update;
        fn({
          id: message.uuid,
          title: message.props.title,
          message: message.props.body,
          withCloseButton: message.props.with_close_button,
          loading: message.props.loading,
          autoClose:
            // Handle both null and falsy values (e.g., if False is accidentally
            // passed from Python) as "no auto-close".
            message.props.auto_close_seconds === null ||
            !message.props.auto_close_seconds
              ? false
              : message.props.auto_close_seconds * 1000,
          color: toMantineColor(message.props.color),
        });
        return;
      }

      // Remove a specific notification.
      case "RemoveNotificationMessage": {
        notifications.hide(message.uuid);
        return;
      }
      // Set the modifier-filter list for a scene pointer event_type.
      // An empty list disables the event_type. The client uses these
      // filters to gate gesture engagement (no rectangle drawn for a
      // modifier that no callback matches).
      case "ScenePointerEnableMessage": {
        viewer.interaction.scenePointer.applyFiltersDelta(
          message.event_type,
          message.owner ?? "",
          message.modifiers,
        );
        return;
      }

      // Add an environment map.
      case "EnvironmentMapMessage": {
        viewer.useEnvironment.set({ environmentMap: message });
        return;
      }

      // Configure fog.
      case "FogMessage": {
        viewer.useEnvironment.set({ fog: message });
        return;
      }

      // Disable/enable default lighting.
      case "EnableLightsMessage": {
        viewer.useEnvironment.set({
          enableDefaultLights: message.enabled,
          enableDefaultLightsShadows: message.cast_shadow,
        });
        return;
      }

      case "GuiModalMessage": {
        addModal(message);
        return;
      }

      case "GuiCloseModalMessage": {
        removeModal(message.uuid);
        return;
      }

      case "GuiPanelMessage": {
        addPanel(message);
        return;
      }

      case "GuiPanelRemoveMessage": {
        removePanel(message.uuid);
        return;
      }

      // Register, update, or remove command palette actions.
      case "RegisterCommandMessage": {
        addCommand(message);
        return;
      }
      case "CommandUpdateMessage": {
        updateCommand(message.uuid, message.updates);
        return;
      }
      case "RemoveCommandMessage": {
        removeCommand(message.uuid);
        return;
      }

      // Set the bone poses. Guard against a bone message that arrives before
      // its SkinnedMeshMessage (out-of-order delivery) or after the node was
      // removed, and against an out-of-range bone index -- otherwise the
      // dereference throws inside the per-frame batch loop and drops the rest
      // of the batch.
      case "SetBoneOrientationMessage": {
        // Keyed per variant: a bone update for a SHADOWED variant
        // accumulates in that variant's own entry instead of corrupting
        // the effective one.
        const state =
          viewerMutable.skinnedMeshState[
            variantKey(message.owner, message.name)
          ];
        const pose = state?.poses[message.bone_index];
        if (pose === undefined) break;
        pose.wxyz = message.wxyz;
        state.dirty = true;
        break;
      }
      case "SetBonePositionMessage": {
        const state =
          viewerMutable.skinnedMeshState[
            variantKey(message.owner, message.name)
          ];
        const pose = state?.poses[message.bone_index];
        if (pose === undefined) break;
        pose.position = message.position;
        state.dirty = true;
        break;
      }
      case "SetCameraLookAtMessage": {
        if (message.initial) {
          // Update store only; InitialCameraSetter will react to the
          // source change and call resetCameraPose.
          initialCameraActions.setLookAt(message.look_at, "message");
          return;
        }

        const cameraControls = viewerMutable.cameraControl!;

        const T_threeworld_world = computeT_threeworld_world(viewer);
        const target = new THREE.Vector3(
          message.look_at[0],
          message.look_at[1],
          message.look_at[2],
        );
        target.applyMatrix4(T_threeworld_world);
        cameraControls.setTarget(target.x, target.y, target.z, false);
        return;
      }
      case "SetCameraUpDirectionMessage": {
        if (message.initial) {
          // Update store only; InitialCameraSetter will react to the
          // source change and call resetCameraPose.
          initialCameraActions.setUp(message.position, "message");
          return;
        }

        const camera = viewerMutable.camera!;
        const cameraControls = viewerMutable.cameraControl!;
        const T_threeworld_world = computeT_threeworld_world(viewer);
        const updir = new THREE.Vector3(
          message.position[0],
          message.position[1],
          message.position[2],
        )
          .normalize()
          .applyQuaternion(
            new THREE.Quaternion().setFromRotationMatrix(T_threeworld_world),
          );
        camera.up.set(updir.x, updir.y, updir.z);

        // Back up position.
        const prevPosition = new THREE.Vector3();
        cameraControls.getPosition(prevPosition);

        cameraControls.updateCameraUp();

        // Restore position, which can get unexpectedly mutated in updateCameraUp().
        cameraControls.setPosition(
          prevPosition.x,
          prevPosition.y,
          prevPosition.z,
          false,
        );
        return;
      }
      case "SetCameraPositionMessage": {
        if (message.initial) {
          // Update store only; InitialCameraSetter will react to the
          // source change and call resetCameraPose.
          initialCameraActions.setPosition(message.position, "message");
          return;
        }

        const cameraControls = viewerMutable.cameraControl!;

        // Set the camera position. Due to the look-at, note that this will
        // shift the orientation as-well.
        const position_cmd = new THREE.Vector3(
          message.position[0],
          message.position[1],
          message.position[2],
        );

        const T_threeworld_world = computeT_threeworld_world(viewer);
        position_cmd.applyMatrix4(T_threeworld_world);

        cameraControls.setPosition(
          position_cmd.x,
          position_cmd.y,
          position_cmd.z,
        );
        return;
      }
      case "SetCameraFovMessage": {
        if (
          !applyInitialCameraParam("fov", message.initial, () =>
            initialCameraActions.setFov(message.fov, "message"),
          )
        )
          return;
        const camera = viewerMutable.camera!;
        // tan(fov / 2.0) = 0.5 * film height / focal length
        // focal length = 0.5 * film height / tan(fov / 2.0)
        camera.setFocalLength(
          (0.5 * camera.getFilmHeight()) / Math.tan(message.fov / 2.0),
        );
        viewerMutable.sendCamera !== null && viewerMutable.sendCamera();
        return;
      }
      case "SetCameraNearMessage": {
        if (
          !applyInitialCameraParam("near", message.initial, () =>
            initialCameraActions.setNear(message.near, "message"),
          )
        )
          return;
        const camera = viewerMutable.camera!;
        camera.near = message.near;
        camera.updateProjectionMatrix();
        return;
      }
      case "SetCameraFarMessage": {
        if (
          !applyInitialCameraParam("far", message.initial, () =>
            initialCameraActions.setFar(message.far, "message"),
          )
        )
          return;
        const camera = viewerMutable.camera!;
        camera.far = message.far;
        camera.updateProjectionMatrix();
        return;
      }
      case "SetCameraMinOrbitDistanceMessage": {
        const cameraControls = viewerMutable.cameraControl!;
        cameraControls.minDistance = message.min_orbit_distance;
        // camera-controls only enforces the bound on the next dolly, so a camera
        // already parked inside the new limit would stay there. Push it out now.
        if (cameraControls.distance < message.min_orbit_distance) {
          cameraControls.dollyTo(message.min_orbit_distance, true);
        }
        return;
      }
      case "SetCameraMaxOrbitDistanceMessage": {
        const cameraControls = viewerMutable.cameraControl!;
        cameraControls.maxDistance = message.max_orbit_distance;
        // camera-controls only enforces the bound on the next dolly, so a camera
        // already parked beyond the new limit would stay there. Pull it in now.
        if (cameraControls.distance > message.max_orbit_distance) {
          cameraControls.dollyTo(message.max_orbit_distance, true);
        }
        return;
      }
      case "SetOrientationMessage": {
        // Root node wxyz is kept in store for reactive world-rotation subscribers
        // (DefaultLights, InitialCameraSetter, WorldTransformUtils).
        // We also write to nodePoseData so the three.js object quaternion is
        // updated in the SceneNodeThreeObject useFrame loop.
        if (message.name === "") {
          const rootPose = viewerMutable.nodePoseData[""];
          if (rootPose) {
            rootPose.wxyz = message.wxyz;
            if (rootPose.poseUpdateState !== "waitForMakeObject") {
              rootPose.poseUpdateState = "needsUpdate";
            }
          } else {
            viewerMutable.nodePoseData[""] = {
              wxyz: message.wxyz,
              position: [0, 0, 0],
              poseUpdateState: "needsUpdate",
            };
          }
          return {
            kind: "sceneNodeAttrUpdate",
            targetNode: "",
            updates: { wxyz: message.wxyz },
          };
        }
        // Shadowed variant: accumulate its pose in the shadow slot.
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { wxyz: message.wxyz },
          )
        )
          return;
        // All other nodes: write pose to mutable ref (no React re-render).
        const pose = viewerMutable.nodePoseData[message.name];
        if (pose) {
          pose.wxyz = message.wxyz;
          if (pose.poseUpdateState !== "waitForMakeObject") {
            pose.poseUpdateState = "needsUpdate";
          }
        } else {
          viewerMutable.nodePoseData[message.name] = {
            wxyz: message.wxyz,
            position: [0, 0, 0],
            poseUpdateState: "needsUpdate",
          };
        }
        return;
      }
      case "SetPositionMessage": {
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { position: message.position },
          )
        )
          return;
        // Write pose to mutable ref (no React re-render).
        const pose = viewerMutable.nodePoseData[message.name];
        if (pose) {
          pose.position = message.position;
          if (pose.poseUpdateState !== "waitForMakeObject") {
            pose.poseUpdateState = "needsUpdate";
          }
        } else {
          viewerMutable.nodePoseData[message.name] = {
            wxyz: [1, 0, 0, 0],
            position: message.position,
            poseUpdateState: "needsUpdate",
          };
        }
        return;
      }
      case "SetSceneNodeVisibilityMessage": {
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { visibility: message.visible },
          )
        )
          return;
        return {
          kind: "sceneNodeAttrUpdate",
          targetNode: message.name,
          updates: { visibility: message.visible },
        };
      }
      // Add a background image.
      case "BackgroundImageMessage": {
        if (message.rgb_data !== null) {
          loadBackgroundTexture(
            message.rgb_data,
            message.format,
            viewerMutable.backgroundMaterial!.uniforms.colorMap,
          );
          viewerMutable.backgroundMaterial!.uniforms.enabled.value = true;
        } else {
          // Dispose the old background texture and disable the background.
          // Bump the token so any in-flight load for this uniform is dropped
          // instead of re-installing a texture after this clear.
          bumpBackgroundTextureSeq(
            viewerMutable.backgroundMaterial!.uniforms.colorMap,
          );
          swapBackgroundTexture(
            viewerMutable.backgroundMaterial!.uniforms.colorMap,
            null,
          );
          viewerMutable.backgroundMaterial!.uniforms.enabled.value = false;
        }

        // Set the depth texture.
        viewerMutable.backgroundMaterial!.uniforms.hasDepth.value =
          message.depth_data !== null;
        if (message.depth_data !== null) {
          // If depth is available set the texture.
          loadBackgroundTexture(
            message.depth_data,
            message.format,
            viewerMutable.backgroundMaterial!.uniforms.depthMap,
          );
        } else {
          // No depth in this message: free any existing depth texture so it
          // isn't orphaned on the GPU (kept alive by the uniform but never
          // disposed), and clear the uniform back to its initial null. Bump the
          // token so an in-flight depth load is dropped rather than re-installed.
          bumpBackgroundTextureSeq(
            viewerMutable.backgroundMaterial!.uniforms.depthMap,
          );
          swapBackgroundTexture(
            viewerMutable.backgroundMaterial!.uniforms.depthMap,
            null,
          );
        }
        return;
      }
      // Remove one scope's variant of a scene node, plus its same-scope
      // descendants (needed for recordings from older servers, which sent a
      // single remove per subtree; current servers enumerate descendants,
      // making the recursion a no-op). Other scopes' variants survive.
      case "RemoveSceneNodeMessage": {
        const owner = message.owner ?? "";
        // Each removed variant's bone-state entry dies with it; other
        // variants of the name (including a just-promoted one) keep theirs.
        for (const name of viewer.sceneTreeActions.removeSceneNodeVariantSubtree(
          message.name,
          owner,
        )) {
          delete viewerMutable.skinnedMeshState[variantKey(owner, name)];
        }
        return;
      }
      // Set the drag-binding set for a particular scene node.
      case "SetSceneNodeDragBindingsMessage": {
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { dragBindings: [...message.bindings] },
          )
        )
          return;
        return {
          kind: "sceneNodeAttrUpdate",
          targetNode: message.name,
          updates: { dragBindings: message.bindings },
        };
      }
      case "SetSceneNodeClickBindingsMessage": {
        if (
          viewer.sceneTreeActions.routeShadowedUpdate(
            message.name,
            message.owner,
            { clickBindings: [...message.bindings] },
          )
        )
          return;
        return {
          kind: "sceneNodeAttrUpdate",
          targetNode: message.name,
          updates: { clickBindings: message.bindings },
        };
      }
      // Update props of a GUI component -- accumulated and applied in batch.
      case "GuiUpdateMessage": {
        return {
          kind: "guiUpdate",
          uuid: message.uuid,
          updates: message.updates,
        };
      }
      // Remove a GUI input.
      case "GuiRemoveMessage": {
        removeGui(message.uuid);
        return;
      }
      // Broadcast to clients that a form was submitted; reset dirty state.
      case "GuiFormSubmitMessage": {
        clearFormDirty(message.uuid);
        return;
      }
      // Broadcast to clients that a form has unsaved changes.
      case "GuiFormDirtyMessage": {
        setFormDirty(message.uuid);
        return;
      }

      case "FileTransferStartDownload":
      case "FileTransferPart": {
        fileDownloadHandler(message);
        return;
      }
      case "FileTransferPartAck": {
        updateUploadState({
          componentId: message.source_component_uuid!,
          uploadedBytes: message.transferred_bytes,
          totalBytes: message.total_bytes,
        });
        return;
      }
      default: {
        console.log("Received message did not match any known types:", message);
        return;
      }
    }
  };
}

function useFileDownloadHandler(): (
  message: FileTransferStartDownload | FileTransferPart,
) => void {
  const downloadStatesRef = React.useRef<{
    [uuid: string]: {
      metadata: FileTransferStartDownload;
      notificationId: string;
      parts: FileTransferPart[];
      bytesDownloaded: number;
      displayFilesize: string;
    };
  }>({});

  return (message: FileTransferStartDownload | FileTransferPart) => {
    const notificationId = "download-" + message.transfer_uuid;

    // Create or update download state.
    switch (message.type) {
      case "FileTransferStartDownload": {
        let displaySize = message.size_bytes;
        const displayUnits = ["B", "K", "M", "G", "T", "P"];
        let displayUnitIndex = 0;
        while (
          displaySize >= 100 &&
          displayUnitIndex < displayUnits.length - 1
        ) {
          displaySize /= 1024;
          displayUnitIndex += 1;
        }
        downloadStatesRef.current[message.transfer_uuid] = {
          metadata: message,
          notificationId: notificationId,
          parts: [],
          bytesDownloaded: 0,
          displayFilesize: `${displaySize.toFixed(1)}${
            displayUnits[displayUnitIndex]
          }`,
        };
        break;
      }
      case "FileTransferPart": {
        const downloadState = downloadStatesRef.current[message.transfer_uuid];
        if (downloadState === undefined) {
          // A part for an unknown/cleared transfer (e.g. its start message was
          // lost). Drop it rather than dereferencing undefined and throwing out
          // of the per-frame message loop.
          console.error(
            "Received FileTransferPart for unknown transfer",
            message.transfer_uuid,
          );
          return;
        }
        if (message.part_index != downloadState.parts.length) {
          console.error("A file download message was received out of order!");
        }
        downloadState.parts.push(message);
        downloadState.bytesDownloaded += message.content.length;
        break;
      }
    }

    // Show notification.
    const downloadState = downloadStatesRef.current[message.transfer_uuid];
    const progressValue =
      (100.0 * downloadState.bytesDownloaded) /
      downloadState.metadata.size_bytes;
    const isDone =
      downloadState.bytesDownloaded == downloadState.metadata.size_bytes;

    (downloadState.bytesDownloaded == 0
      ? notifications.show
      : notifications.update)({
      title:
        (isDone ? "Received " : "Receiving ") +
        `${downloadState.metadata.filename} (${downloadState.displayFilesize})`,
      message: <Progress size="sm" value={progressValue} />,
      id: notificationId,
      autoClose: isDone && downloadState.metadata.save_immediately,
      withCloseButton: isDone,
      loading: !isDone,
      icon: isDone ? <IconCheck /> : undefined,
    });

    // If done: download file and clear state.
    if (isDone) {
      const url = window.URL.createObjectURL(
        new Blob(
          // Blob contains the file part contents, sorted by the part index.
          downloadState.parts
            .sort((a, b) => a.part_index - b.part_index)
            .map((part) => part.content),
          {
            type: downloadState.metadata.mime_type,
          },
        ),
      );

      // If save_immediately is true, download the file immediately.
      // Otherwise, show a notification with a link to download the file.
      // We should revoke the URL after the notification is dismissed.
      if (downloadState.metadata.save_immediately) {
        const link = document.createElement("a");
        link.href = url;
        link.download = downloadState.metadata.filename;
        link.click();
        link.remove();
        delete downloadStatesRef.current[message.transfer_uuid];
        URL.revokeObjectURL(url);
      } else {
        notifications.update({
          id: notificationId,
          title: "",
          message: (
            <>
              <a href={url} download={downloadState.metadata.filename}>
                <Button
                  leftSection={<IconDownload size={14} />}
                  variant="light"
                  size="sm"
                  mt="0.05em"
                  style={{ width: "100%" }}
                >
                  {`${downloadState.metadata.filename} (${downloadState.displayFilesize})`}
                </Button>
              </a>
            </>
          ),
          autoClose: false,
          onClose: () => {
            URL.revokeObjectURL(url);
            delete downloadStatesRef.current[message.transfer_uuid];
          },
        });
      }
    }
  };
}

export function FrameSynchronizedMessageHandler() {
  const handleMessage = useMessageHandler();
  const viewer = useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;
  const messageQueue = viewerMutable.messageQueue;
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const gl = useThree((state) => state.gl);

  useFrame(
    () => {
      // Handle messages, but only if we're not trying to render something.
      // (Render capture itself lives in the second useFrame below, which runs
      // later in the same frame -- after SceneTree's pose appliers.)
      if (
        viewerMutable.getRenderRequestState === "ready" &&
        messageQueue.length > 0
      ) {
        // Handle messages before every frame.
        // Place this directly in ws.onmessage can cause race conditions!
        //
        // If a render is requested, note that we don't handle any more messages
        // until the render is done.
        const requestRenderIndex = messageQueue.findIndex(
          (message) => message.type === "GetRenderRequestMessage",
        );
        const numMessages =
          requestRenderIndex !== -1
            ? requestRenderIndex + 1
            : messageQueue.length;
        const processBatch = messageQueue.splice(0, numMessages);

        // Hack: On the very first batch, handle any root node SetOrientationMessage
        // (from set_up_direction()) before all other messages. This ensures
        // T_threeworld_world is up-to-date when initial camera messages are processed.
        if (viewerMutable.firstMessageBatch) {
          viewerMutable.firstMessageBatch = false;
          const rootOrientationIndex = processBatch.findIndex(
            (msg) => msg.type === "SetOrientationMessage" && msg.name === "",
          );
          if (rootOrientationIndex !== -1) {
            const rootNodeUpdate = handleMessage(
              processBatch[rootOrientationIndex],
            );
            const rootNode = viewer.useSceneTree.get("")!;
            viewer.useSceneTree.set({
              "": {
                ...rootNode,
                wxyz:
                  rootNodeUpdate?.kind === "sceneNodeAttrUpdate"
                    ? (rootNodeUpdate.updates.wxyz ?? rootNode.wxyz)
                    : rootNode.wxyz,
              },
            });

            // Remove the message from the batch.
            processBatch.splice(rootOrientationIndex, 1);
          }
        }

        // Handle all messages and accumulate batched updates.
        // Three kinds of updates are accumulated and applied as single setState calls:
        // - parked scene updates: SceneNode attributes (wxyz, visibility,
        //   ...) and message.props fields, per (owner, name) -- see
        //   batchedSceneUpdates.ts for the parking/routing semantics.
        // - guiUpdates: GUI component property updates
        const parked = createParkedSceneUpdates(
          viewer.useSceneTree,
          viewer.sceneTreeActions,
        );
        const guiUpdates: { uuid: string; updates: { [key: string]: any } }[] =
          [];

        for (const msg of processBatch) {
          // An add or variant remove flips the name's variant topology at
          // receive time; parked updates for it must land first to keep
          // wire order (see the drainFor contract).
          if (
            isSceneNodeMessage(msg) ||
            msg.type === "RemoveSceneNodeMessage"
          ) {
            parked.drainFor(msg.name);
          }
          const result = handleMessage(msg);
          if (result === undefined) continue;
          switch (result.kind) {
            case "sceneNodeAttrUpdate": {
              parked.parkAttr(
                ownerOf(msg as { owner?: string }),
                result.targetNode,
                result.updates,
              );
              break;
            }
            case "sceneNodePropsUpdate": {
              parked.parkProps(
                ownerOf(msg as { owner?: string }),
                result.targetNode,
                result.propsUpdates,
              );
              break;
            }
            case "guiUpdate":
              guiUpdates.push(result);
              break;
          }
        }

        // Apply all accumulated scene tree updates in a single set().
        const { mergedUpdates, visibilityNames } = parked.flush();
        if (Object.keys(mergedUpdates).length > 0) {
          viewer.useSceneTree.set(mergedUpdates);
        }

        // Apply all accumulated GUI config updates in a single set().
        if (guiUpdates.length > 0) {
          const configUpdates: Record<string, GuiComponentMessage | undefined> =
            {};
          // Containers sort by guiOrderFromUuid (written at add time), so an
          // `order` update must also land there or the new order renders only
          // after a reconnect.
          const orderUpdates: Record<string, number> = {};
          const panelSnapshot = viewer.useGui.get().panels;
          for (const { uuid, updates } of guiUpdates) {
            // Standalone panels live in their own store (not configStore), and
            // their tab/visibility updates also arrive as GuiUpdateMessages.
            // Route those to updatePanel.
            if (uuid in panelSnapshot) {
              viewer.guiActions.updatePanel(uuid, updates);
              continue;
            }
            const current =
              configUpdates[uuid] ?? viewer.useGuiConfig.get(uuid);
            if (current === undefined) {
              console.error(
                `Tried to update non-existent component '${uuid}'`,
                updates,
              );
              continue;
            }
            const updated = applyGuiConfigUpdate(current, updates);
            if (updated !== current) {
              configUpdates[uuid] = updated;
            }
            if ("order" in updates && typeof updates.order === "number") {
              orderUpdates[uuid] = updates.order;
            }
          }
          if (Object.keys(configUpdates).length > 0) {
            viewer.useGuiConfig.set(configUpdates);
          }
          viewer.useGui.set((state) => {
            const changed = Object.entries(orderUpdates).filter(
              ([uuid, order]) =>
                !Object.is(state.guiOrderFromUuid[uuid], order),
            );
            if (changed.length === 0) return {};
            return {
              guiOrderFromUuid: {
                ...state.guiOrderFromUuid,
                ...Object.fromEntries(changed),
              },
            };
          });
        }

        // Recompute effective visibility for nodes whose visibility change
        // actually merged into an effective variant (updates consumed into
        // a shadow slot don't affect what renders). This needs to be done
        // after updates are applied.
        for (const name of visibilityNames) {
          viewer.sceneTreeActions.computeEffectiveVisibility(name);
        }

        // A render request that arrived with no messages in front of it has
        // nothing waiting on a React commit: skip "commit_wait" so the
        // capture hook below fires this same frame, after the SceneTree pose
        // appliers. This is the common case for tight get_render() loops.
        // (requestRenderIndex === 0 means the processed batch was exactly the
        // request, whose handler just set the state to "commit_wait".)
        if (requestRenderIndex === 0) {
          viewerMutable.getRenderRequestState = "capture";
        }
      }
    },
    // We should handle messages before doing anything else!!
    //
    // Importantly, this priority should be *lower* than the useFrame priority
    // used to update scene node transforms in SceneTree.tsx.
    -100000,
  );

  // Render capture for get_render() requests, in its own hook so it can run
  // at a priority AFTER SceneTree's per-node pose appliers (-1000) and the
  // message handler above (-100000). Captures therefore see the poses applied
  // earlier in the SAME frame, which is what lets a request skip idle frames:
  // an implementation that captures before pose application (the old one ran
  // at -100000) has to idle extra frames to compensate.
  useFrame(
    () => {
      if (viewerMutable.getRenderRequestState === "commit_wait") {
        // The batch that carried this request also carried scene updates.
        // React flushes those commits (sync lane) before the next frame;
        // capture on the next pass.
        viewerMutable.getRenderRequestState = "capture";
        return;
      }
      if (viewerMutable.getRenderRequestState !== "capture") return;

      const targetWidth = viewerMutable.getRenderRequest!.width;
      const targetHeight = viewerMutable.getRenderRequest!.height;
      const format = viewerMutable.getRenderRequest!.format;
      const quality = viewerMutable.getRenderRequest!.quality;
      // Captured now so the response can be correlated to its request even
      // after the async toBlob below.
      const renderUuid = viewerMutable.getRenderRequest!.render_uuid;

      // Snapshot renderer state up front so the `finally` below can always
      // restore it, even if rendering throws partway through.
      const originalSize = gl.getSize(new THREE.Vector2());
      const originalClearColor = gl.getClearColor(new THREE.Color());
      const originalClearAlpha = gl.getClearAlpha();

      // Splat sorted-index backup, restored in `finally`.
      const splatMeshProps = splatContext.meshPropsRef.current;
      const sortedIndicesOrig =
        splatMeshProps !== null
          ? splatMeshProps.sortedIndexAttribute.array.slice()
          : null;

      // An empty payload is the failure sentinel: it lets the server's
      // pending get_render() resolve instead of blocking forever.
      const sendRenderResponse = (payload: Uint8Array<ArrayBuffer>) =>
        viewerMutable.sendMessage({
          type: "GetRenderResponseMessage",
          payload,
          render_uuid: renderUuid,
        });

      // Once we enter capture we must always return to "ready" -- otherwise
      // an exception (or a null toBlob) would wedge the render state machine
      // and block all further message handling, which is gated on "ready".
      try {
        // Defensively apply node poses still marked "needsUpdate": a pose
        // marked by a React effect that ran after this frame's SceneTree
        // applier pass (e.g. a node that just [re]mounted) would otherwise
        // be captured stale.
        for (const [name, pose] of Object.entries(viewerMutable.nodePoseData)) {
          if (pose === undefined || pose.poseUpdateState !== "needsUpdate")
            continue;
          const obj = viewerMutable.nodeRefFromName[name];
          // == null: the map's type says undefined, but React ref callbacks
          // write null on detach (e.g. unmountWhenInvisible nodes that are
          // currently hidden), and a TypeError here would fail the whole
          // capture with the pose still pending.
          if (obj == null) continue;
          pose.poseUpdateState = "updated";
          if (viewer.useSceneTree.get(name)?.message.type !== "LabelMessage") {
            obj.quaternion.set(
              pose.wxyz[1],
              pose.wxyz[2],
              pose.wxyz[3],
              pose.wxyz[0],
            );
          }
          obj.position.set(
            pose.position[0],
            pose.position[1],
            pose.position[2],
          );
          if (!obj.matrixAutoUpdate) obj.updateMatrix();
          if (!obj.matrixWorldAutoUpdate) obj.updateMatrixWorld();
        }

        const cameraPosition = viewerMutable.getRenderRequest!.position;
        const cameraWxyz = viewerMutable.getRenderRequest!.wxyz;
        const cameraFov = viewerMutable.getRenderRequest!.fov;

        // Render the scene using the virtual camera.
        const T_threeworld_world = computeT_threeworld_world(viewer);

        // Create a new perspective camera.
        const camera = new THREE.PerspectiveCamera(
          THREE.MathUtils.radToDeg(cameraFov),
          targetWidth / targetHeight,
          0.01, // Near.
          1000.0, // Far.
        );

        // Set camera pose.
        camera.position.set(...cameraPosition).applyMatrix4(T_threeworld_world);
        camera.setRotationFromQuaternion(
          new THREE.Quaternion(
            cameraWxyz[1],
            cameraWxyz[2],
            cameraWxyz[3],
            cameraWxyz[0],
          )
            .premultiply(
              new THREE.Quaternion().setFromRotationMatrix(T_threeworld_world),
            )
            .multiply(
              // OpenCV => OpenGL coordinate system conversion.
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                Math.PI,
              ),
            ),
        );

        // Update splatting camera if needed.
        if (splatContext.updateCamera.current !== null)
          splatContext.updateCamera.current!(
            camera,
            targetWidth,
            targetHeight,
            true,
          );

        // Configure for capture. JPEG is an RGB result rendered on an opaque
        // white background; PNG is RGBA with a transparent background.
        gl.setSize(targetWidth, targetHeight);
        gl.setClearColor(0xffffff);
        gl.setClearAlpha(format === "image/jpeg" ? 1.0 : 0.0);

        // Render the scene.
        gl.render(viewerMutable.scene!, camera);

        // Temporary canvas for saving the rendered image. This is needed to
        // prevent flickers: we need context from the original canvas for
        // rendering, but we want to revert the renderer state immediately.
        const canvas = gl.domElement;
        const bufferCanvas = document.createElement("canvas");
        bufferCanvas.width = targetWidth;
        bufferCanvas.height = targetHeight;
        const ctx = bufferCanvas.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);

        // The pixels are copied out of the renderer at this point, so
        // message handling can resume NOW: the async encode below overlaps
        // with whatever comes next, including the next capture.
        viewerMutable.getRenderRequestState = "ready";
        bufferCanvas.toBlob(
          (blob) => {
            void (async () => {
              try {
                // `toBlob` can hand back null (e.g. canvas too large / OOM);
                // fall back to an empty payload so the server's pending
                // request resolves instead of hanging forever.
                sendRenderResponse(
                  blob === null
                    ? new Uint8Array(0)
                    : new Uint8Array(await blob.arrayBuffer()),
                );
              } catch (e) {
                console.error("Failed to read rendered image:", e);
                sendRenderResponse(new Uint8Array(0));
              }
            })();
            // The quality argument applies to JPEG only (PNG's encoder has
            // no knobs in the web API); omitting it would silently encode
            // at Chrome's 0.92 default -- larger and no faster.
          },
          format,
          format === "image/jpeg" ? quality / 100.0 : undefined,
        );
      } catch (e) {
        console.error("Render request failed:", e);
        // The response wasn't sent above, so send the failure sentinel now --
        // otherwise the server's get_render() blocks forever waiting for a
        // response. Then resume message handling.
        sendRenderResponse(new Uint8Array(0));
        viewerMutable.getRenderRequestState = "ready";
      } finally {
        // Restore the original renderer state.
        gl.setSize(originalSize.x, originalSize.y);
        gl.setClearColor(originalClearColor);
        gl.setClearAlpha(originalClearAlpha);

        // Restore splatting indices.
        if (sortedIndicesOrig !== null && splatMeshProps !== null) {
          splatMeshProps.sortedIndexAttribute.array = sortedIndicesOrig;
          splatMeshProps.sortedIndexAttribute.needsUpdate = true;
        }
      }
    },
    // Between SceneTree's pose appliers (-1000) and the Gaussian splat
    // per-frame hook (-100): capture must see this frame's poses, and the
    // splat hook must run AFTER capture so it re-applies interactive-camera
    // splat state (uniforms, group transforms, async sort) that the
    // capture's virtual-camera updateCamera(..., blockingSort=true) call
    // mutates -- capture only restores the sorted-index attribute itself.
    // At a later priority, the frame's visible render would draw the
    // interactive viewport with the virtual camera's splat state.
    -500,
  );

  return null;
}
