import { notifications } from "@mantine/notifications";

import React, { useContext } from "react";
import * as THREE from "three";
import { TextureLoader } from "three";
import { toMantineColor } from "./components/colorUtils";

import { ViewerContext } from "./ViewerContext";
import {
  FileTransferPart,
  FileTransferStartDownload,
  Message,
  SceneNodeMessage,
  isGuiComponentMessage,
  isSceneNodeMessage,
} from "./WebsocketMessages";
import { isTexture } from "./WebsocketUtils";
import { useFrame, useThree } from "@react-three/fiber";
import { Button, Progress } from "@mantine/core";
import { IconCheck, IconDownload } from "@tabler/icons-react";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { rootNodeTemplate } from "./SceneTreeState";
import { GaussianSplatsContext } from "./Splatting/GaussianSplatsHelpers";

/** Returns a handler for all incoming messages. */
function useMessageHandler() {
  const viewer = useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;

  // We could reduce the redundancy here if we wanted to.
  // https://github.com/viser-project/viser/issues/39
  const updateSceneNode = viewer.sceneTreeActions.updateSceneNodeProps;
  const removeSceneNode = viewer.sceneTreeActions.removeSceneNode;
  const addSceneNode = viewer.sceneTreeActions.addSceneNode;
  const setTheme = viewer.useGui((state) => state.setTheme);

  // Initial camera store actions for updating reset view state.
  const initialCamera = viewer.useInitialCamera;
  const setShareUrl = viewer.useGui((state) => state.setShareUrl);
  const addGui = viewer.useGui((state) => state.addGui);
  const addModal = viewer.useGui((state) => state.addModal);
  const removeModal = viewer.useGui((state) => state.removeModal);
  const removeGui = viewer.useGui((state) => state.removeGui);
  const updateGuiProps = viewer.useGui((state) => state.updateGuiProps);
  const updateUploadState = viewer.useGui((state) => state.updateUploadState);

  // Same as addSceneNode, but make a parent in the form of a dummy coordinate
  // frame if it doesn't exist yet.
  function addSceneNodeMakeParents(message: SceneNodeMessage) {
    // Make sure scene node is in attributes.
    const currentNode = viewer.useSceneTree.getState()[message.name];

    // Make sure parents exists.
    const sceneState = viewer.useSceneTree.getState();
    const parentName = message.name.split("/").slice(0, -1).join("/");
    if (sceneState[parentName]?.message === undefined) {
      addSceneNodeMakeParents({
        ...rootNodeTemplate.message,
        name: parentName,
      });
      viewer.sceneTreeActions.updateNodeAttributes(parentName, {
        visibility: true,
      });
    }
    addSceneNode(message);

    // If the object is new or changed, we need to wait until it's created
    // before updating its pose. Updating the pose too early can cause
    // flickering when we replace objects (old object will take the pose of the new
    // object while it's being loaded/mounted).
    if (message !== currentNode?.message) {
      viewer.sceneTreeActions.updateNodeAttributes(message.name, {
        poseUpdateState: "waitForMakeObject",
      });
    }
  }

  const fileDownloadHandler = useFileDownloadHandler();

  // Return message handler.
  return (message: Message) => {
    if (isGuiComponentMessage(message)) {
      addGui(message);
      return;
    }

    if (isSceneNodeMessage(message)) {
      // Initialize skinned mesh state.
      if (message.type === "SkinnedMeshMessage") {
        viewerMutable.skinnedMeshState[message.name] = {
          initialized: false,
          dirty: false,
          poses: [],
        };

        const bone_wxyzs = new Float32Array(
          message.props.bone_wxyzs.buffer.slice(
            message.props.bone_wxyzs.byteOffset,
            message.props.bone_wxyzs.byteOffset +
              message.props.bone_wxyzs.byteLength,
          ),
        );
        const bone_positions = new Float32Array(
          message.props.bone_positions.buffer.slice(
            message.props.bone_positions.byteOffset,
            message.props.bone_positions.byteOffset +
              message.props.bone_positions.byteLength,
          ),
        );
        for (let i = 0; i < message.props.bone_wxyzs!.length; i++) {
          viewerMutable.skinnedMeshState[message.name].poses.push({
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
        updateSceneNode(message.name, message.updates);
        return;
      }
      // Set the share URL.
      case "ShareUrlUpdated": {
        setShareUrl(message.share_url);
        return;
      }
      // Request a render.
      case "GetRenderRequestMessage": {
        viewerMutable.getRenderRequest = message;
        viewerMutable.getRenderRequestState = "triggered";
        return;
      }
      // Set the GUI panel label.
      case "SetGuiPanelLabelMessage": {
        viewer.useGui.setState({ label: message.label ?? "" });
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

      // Add a notification.
      case "NotificationMessage": {
        (message.mode === "show" ? notifications.show : notifications.update)({
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
      // Enable/disable whether scene pointer events are sent.
      case "ScenePointerEnableMessage": {
        // Update scene click enable state.
        viewerMutable.scenePointerInfo.enabled = message.enable
          ? message.event_type
          : false;

        // Update cursor to indicate whether the scene can be clicked.
        viewerMutable.canvas!.style.cursor = message.enable
          ? "pointer"
          : "auto";
        return;
      }

      // Add an environment map.
      case "EnvironmentMapMessage": {
        viewer.useEnvironment.setState({ environmentMap: message });
        return;
      }

      // Configure fog.
      case "FogMessage": {
        viewer.useEnvironment.setState({ fog: message });
        return;
      }

      // Disable/enable default lighting.
      case "EnableLightsMessage": {
        viewer.useEnvironment.setState({
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

      // Set the bone poses.
      case "SetBoneOrientationMessage": {
        const state = viewerMutable.skinnedMeshState;
        state[message.name].poses[message.bone_index].wxyz = message.wxyz;
        state[message.name].dirty = true;
        break;
      }
      case "SetBonePositionMessage": {
        const state = viewerMutable.skinnedMeshState;
        state[message.name].poses[message.bone_index].position =
          message.position;
        state[message.name].dirty = true;
        break;
      }
      case "SetCameraLookAtMessage": {
        // Setting initial camera parameters.
        const wasDefault = initialCamera.getState().lookAt.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setLookAt(message.look_at, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          if (!wasDefault) return;
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
        // Setting initial camera parameters.
        const wasDefault = initialCamera.getState().up.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setUp(message.position, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          if (!wasDefault) return;
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
        console.log("set camera position");
        // Setting initial camera parameters.
        const wasDefault =
          initialCamera.getState().position.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setPosition(message.position, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          console.log(message.initial, wasDefault);
          if (!wasDefault) return;
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
        // Setting initial camera parameters.
        const wasDefault = initialCamera.getState().fov.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setFov(message.fov, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          if (!wasDefault) return;
        }

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
        // Setting initial camera parameters.
        const wasDefault = initialCamera.getState().near.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setNear(message.near, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          if (!wasDefault) return;
        }

        const camera = viewerMutable.camera!;
        camera.near = message.near;
        camera.updateProjectionMatrix();
        return;
      }
      case "SetCameraFarMessage": {
        // Setting initial camera parameters.
        const wasDefault = initialCamera.getState().far.source === "default";
        if (message.initial) {
          // URL params take priority, ignore server's initial value.
          initialCamera.getState().setFar(message.far, "message");

          // If this is the first initial camera: we'll also move the actual
          // camera. If not, we return immediately.
          if (!wasDefault) return;
        }

        const camera = viewerMutable.camera!;
        camera.far = message.far;
        camera.updateProjectionMatrix();
        return;
      }
      case "SetOrientationMessage": {
        const currentNode = viewer.useSceneTree.getState()[message.name];
        const newPoseUpdateState =
          currentNode?.poseUpdateState !== "waitForMakeObject"
            ? "needsUpdate"
            : currentNode?.poseUpdateState || "needsUpdate";
        return {
          targetNode: message.name,
          updates: {
            wxyz: message.wxyz,
            poseUpdateState: newPoseUpdateState,
          },
        };
      }
      case "SetPositionMessage": {
        const currentNode = viewer.useSceneTree.getState()[message.name];
        const newPoseUpdateState =
          currentNode?.poseUpdateState !== "waitForMakeObject"
            ? "needsUpdate"
            : currentNode?.poseUpdateState || "needsUpdate";
        return {
          targetNode: message.name,
          updates: {
            position: message.position,
            poseUpdateState: newPoseUpdateState,
          },
        };
      }
      case "SetSceneNodeVisibilityMessage": {
        return {
          targetNode: message.name,
          updates: { visibility: message.visible },
        };
      }
      // Add a background image.
      case "BackgroundImageMessage": {
        if (message.rgb_data !== null) {
          const rgb_url = URL.createObjectURL(
            new Blob([message.rgb_data], {
              type: "image/" + message.format,
            }),
          );
          new TextureLoader().load(rgb_url, (texture) => {
            URL.revokeObjectURL(rgb_url);
            const oldBackgroundTexture =
              viewerMutable.backgroundMaterial!.uniforms.colorMap.value;
            viewerMutable.backgroundMaterial!.uniforms.colorMap.value = texture;

            // Dispose the old background texture.
            if (isTexture(oldBackgroundTexture)) oldBackgroundTexture.dispose();
          });

          viewerMutable.backgroundMaterial!.uniforms.enabled.value = true;
        } else {
          // Dispose the old background texture.
          const oldBackgroundTexture =
            viewerMutable.backgroundMaterial!.uniforms.colorMap.value;
          if (isTexture(oldBackgroundTexture)) oldBackgroundTexture.dispose();

          // Disable the background.
          viewerMutable.backgroundMaterial!.uniforms.enabled.value = false;
        }

        // Set the depth texture.
        viewerMutable.backgroundMaterial!.uniforms.hasDepth.value =
          message.depth_data !== null;
        if (message.depth_data !== null) {
          // If depth is available set the texture
          const depth_url = URL.createObjectURL(
            new Blob([message.depth_data], {
              type: "image/" + message.format,
            }),
          );
          new TextureLoader().load(depth_url, (texture) => {
            URL.revokeObjectURL(depth_url);
            const oldDepthTexture =
              viewerMutable.backgroundMaterial?.uniforms.depthMap.value;
            viewerMutable.backgroundMaterial!.uniforms.depthMap.value = texture;
            if (isTexture(oldDepthTexture)) oldDepthTexture.dispose();
          });
        }
        return;
      }
      // Remove a scene node and its children by name.
      case "RemoveSceneNodeMessage": {
        console.log("Removing scene node:", message.name);
        const sceneState = viewer.useSceneTree.getState();
        if (!(message.name in sceneState)) {
          console.log("(OK) Skipping scene node removal for " + message.name);
          return;
        }
        removeSceneNode(message.name);

        if (viewerMutable.skinnedMeshState[message.name] !== undefined)
          delete viewerMutable.skinnedMeshState[message.name];
        return;
      }
      // Set the clickability of a particular scene node.
      case "SetSceneNodeClickableMessage": {
        return {
          targetNode: message.name,
          updates: { clickable: message.clickable },
        };
      }
      // Update props of a GUI component
      case "GuiUpdateMessage": {
        updateGuiProps(message.uuid, message.updates);
        return;
      }
      // Remove a GUI input.
      case "GuiRemoveMessage": {
        removeGui(message.uuid);
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
  const isFirstBatchRef = React.useRef(true);

  useFrame(
    () => {
      // Send a render along if it was requested!
      if (viewerMutable.getRenderRequestState === "triggered") {
        viewerMutable.getRenderRequestState = "pause";
      } else if (viewerMutable.getRenderRequestState === "pause") {
        const cameraPosition = viewerMutable.getRenderRequest!.position;
        const cameraWxyz = viewerMutable.getRenderRequest!.wxyz;
        const cameraFov = viewerMutable.getRenderRequest!.fov;

        const targetWidth = viewerMutable.getRenderRequest!.width;
        const targetHeight = viewerMutable.getRenderRequest!.height;

        // Render the scene using the virtual camera
        const T_threeworld_world = computeT_threeworld_world(viewer);

        // Create a new perspective camera
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
        // We'll back up the current sorted indices, and restore them after rendering.
        const splatMeshProps = splatContext.meshPropsRef.current;
        const sortedIndicesOrig =
          splatMeshProps !== null
            ? splatMeshProps.sortedIndexAttribute.array.slice()
            : null;
        if (splatContext.updateCamera.current !== null)
          splatContext.updateCamera.current!(
            camera,
            targetWidth,
            targetHeight,
            true,
          );

        // Save current renderer state.
        const originalSize = gl.getSize(new THREE.Vector2());
        const originalClearColor = gl.getClearColor(new THREE.Color());
        const originalClearAlpha = gl.getClearAlpha();

        // Configure for capture.
        gl.setSize(targetWidth, targetHeight);
        gl.setClearColor(0xffffff);
        gl.setClearAlpha(
          viewerMutable.getRenderRequest!.format == "image/png" ? 0.0 : 1.0,
        );

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

        // Restore the original renderer state.
        gl.setSize(originalSize.x, originalSize.y);
        gl.setClearColor(originalClearColor);
        gl.setClearAlpha(originalClearAlpha);

        // Restore splatting indices.
        if (sortedIndicesOrig !== null && splatMeshProps !== null) {
          splatMeshProps.sortedIndexAttribute.array = sortedIndicesOrig;
          splatMeshProps.sortedIndexAttribute.needsUpdate = true;
        }

        // Get the rendered image from our temp canvas.
        viewerMutable.getRenderRequestState = "in_progress";
        bufferCanvas.toBlob(async (blob) => {
          viewerMutable.sendMessage({
            type: "GetRenderResponseMessage",
            payload: new Uint8Array(await blob!.arrayBuffer()),
          });
          viewerMutable.getRenderRequestState = "ready";
        }, viewerMutable.getRenderRequest!.format);
      }

      // Handle messages, but only if we're not trying to render something.
      if (viewerMutable.getRenderRequestState === "ready") {
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
        if (isFirstBatchRef.current) {
          isFirstBatchRef.current = false;
          const rootOrientationIndex = processBatch.findIndex(
            (msg) => msg.type === "SetOrientationMessage" && msg.name === "",
          );
          if (rootOrientationIndex !== -1) {
            const rootNodeUpdate = handleMessage(
              processBatch[rootOrientationIndex],
            )!;
            const rootNode = viewer.useSceneTree.getState()[""]!;
            viewer.useSceneTree.setState({
              "": {
                ...rootNode,
                wxyz: rootNodeUpdate.updates.wxyz!,
              },
            });

            // Remove the message from the batch.
            processBatch.splice(rootOrientationIndex, 1);
          }
        }

        // Handle messages and accumulate updates.
        const updates = processBatch.map(handleMessage).reduce(
          (acc, cur) => {
            if (cur === undefined) return acc;
            else {
              // console.log(cur.targetNode);
              return {
                ...acc,
                [cur.targetNode]: { ...acc[cur.targetNode], ...cur.updates },
              };
            }
          },
          {} as { [name: string]: any },
        );

        // Apply accumulated prop updates to the zustand state.
        const currentState = viewer.useSceneTree.getState();
        const mergedUpdates: typeof updates = {};
        for (const [k, v] of Object.entries(updates)) {
          if (!(k in currentState)) {
            console.log(`(OK) Tried to update non-existent scene node ${k}`);
            continue;
          }
          mergedUpdates[k] = { ...currentState[k], ...v };
        }
        viewer.useSceneTree.setState(mergedUpdates);

        // Recompute effective visibility for nodes whose visibility changed.
        // This needs to be done after updates are applied.
        for (const [nodeName, nodeState] of Object.entries(updates)) {
          if ("visibility" in nodeState) {
            viewer.sceneTreeActions.computeEffectiveVisibility(nodeName);
          }
        }
      }
    },
    // We should handle messages before doing anything else!!
    //
    // Importantly, this priority should be *lower* than the useFrame priority
    // used to update scene node transforms in SceneTree.tsx.
    -100000,
  );

  return null;
}
