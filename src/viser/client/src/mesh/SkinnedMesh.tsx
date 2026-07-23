import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowSkinnedMesh } from "./MeshUtils";
import { SkinnedMeshMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { ViewerContext, ViewerMutable } from "../ViewerContext";
import { useFrame } from "@react-three/fiber";
import { normalizeScale } from "../utils/normalizeScale";

/**
 * Component for rendering skinned meshes with animations
 */
export const SkinnedMesh = React.forwardRef<
  THREE.Group,
  SkinnedMeshMessage & { children?: React.ReactNode }
>(function SkinnedMesh(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  const viewer = React.useContext(ViewerContext)!;

  // Reference to bones for animation updates.
  const bonesRef = React.useRef<THREE.Bone[]>();
  // The exact skinnedMeshState entry this instance has claimed (set by the
  // init effect below). MessageHandler builds a FRESH entry object per
  // SkinnedMeshMessage, so on a same-tick delete + re-add of the same name a
  // pending-unmount instance -- whose effects never re-run -- sees an entry it
  // never claimed and must not touch it, even when the bone count happens to
  // match (initializing it with OUR bones would block the replacement
  // instance's own setup). A live instance re-claims on every prop update.
  const ownedEntryRef = React.useRef<
    ViewerMutable["skinnedMeshState"][string] | null
  >(null);

  // Create geometry and skeleton using memoization.
  const { geometry, skeleton } = React.useMemo(() => {
    // Setup geometry.
    const geometry = new THREE.BufferGeometry();
    // Vertices and faces arrive as Float32Array / Uint32Array views.
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(message.props.vertices, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(message.props.faces, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // Bone data arrives as Float32Array views. Use directly.
    const bone_wxyzs = message.props.bone_wxyzs;
    const bone_positions = message.props.bone_positions;

    const bones: THREE.Bone[] = [];
    bonesRef.current = bones;
    for (let i = 0; i < bone_positions.length / 3; i++) {
      bones.push(new THREE.Bone());
    }
    const boneInverses: THREE.Matrix4[] = [];
    const xyzw_quat = new THREE.Quaternion();
    bones.forEach((bone, i) => {
      xyzw_quat.set(
        bone_wxyzs[i * 4 + 1],
        bone_wxyzs[i * 4 + 2],
        bone_wxyzs[i * 4 + 3],
        bone_wxyzs[i * 4 + 0],
      );

      const boneInverse = new THREE.Matrix4();
      boneInverse.makeRotationFromQuaternion(xyzw_quat);
      boneInverse.setPosition(
        bone_positions[i * 3 + 0],
        bone_positions[i * 3 + 1],
        bone_positions[i * 3 + 2],
      );
      boneInverse.invert();
      boneInverses.push(boneInverse);

      bone.setRotationFromQuaternion(xyzw_quat);
      bone.position.set(
        bone_positions[i * 3 + 0],
        bone_positions[i * 3 + 1],
        bone_positions[i * 3 + 2],
      );
    });
    const skeleton = new THREE.Skeleton(bones, boneInverses);

    // skin_indices (Uint16Array) and skin_weights (Float32Array). Zero copy.
    geometry.setAttribute(
      "skinIndex",
      new THREE.BufferAttribute(message.props.skin_indices, 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.BufferAttribute(message.props.skin_weights!, 4),
    );

    skeleton.init();
    return { geometry, skeleton };
    // Keyed on the VIEWS, not their .buffer (BasicMesh's pattern): in a
    // playback recording every array is a view on ONE shared ArrayBuffer,
    // so .buffer identity never changes and a re-add with different
    // geometry would silently keep rendering the old mesh.
  }, [
    message.props.vertices,
    message.props.faces,
    message.props.skin_indices,
    message.props.skin_weights,
    message.props.bone_wxyzs,
    message.props.bone_positions,
  ]);

  // Handle initialization and cleanup.
  // Get mutable once.
  const viewerMutable = viewer.mutable.current;

  // Clean up geometry and skeleton when they change (they're created together).
  React.useEffect(() => {
    // The state entry can be deleted while this component is still mounted
    // (subtree-prefix removal in MessageHandler, reconnect clearing in
    // WebsocketInterface), so guard reads like the bone-message handlers do.
    const state = viewerMutable.skinnedMeshState[message.name];
    if (state !== undefined) {
      state.initialized = false;
      state.claimed = true;
    }
    ownedEntryRef.current = state ?? null;
    // The bones for this skeleton (added to the parent node imperatively in
    // useFrame below). Captured here so the cleanup can remove exactly these on
    // a skeleton change / unmount -- otherwise a re-added skinned mesh leaks its
    // old bones into the parent (its child count grows by numBones each update).
    const addedBones = bonesRef.current;
    return () => {
      const parentNode = viewerMutable.nodeRefFromName[message.name];
      if (parentNode !== undefined && addedBones !== undefined) {
        addedBones.forEach((bone) => parentNode.remove(bone));
      }
      // Release the claim so a successor (this instance's own next effect
      // run, or a new mount) can take the entry over.
      if (
        ownedEntryRef.current !== null &&
        viewerMutable.skinnedMeshState[message.name] === ownedEntryRef.current
      ) {
        ownedEntryRef.current.claimed = false;
      }
      if (skeleton) skeleton.dispose();
      if (geometry) geometry.dispose();
    };
  }, [skeleton, geometry, message.name, viewerMutable.skinnedMeshState]);

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  // Update bone transforms for animation.
  useFrame(() => {
    // The state entry can be deleted before our unmount commits: subtree
    // removal and reconnect clearing both run in the message handler's
    // useFrame (priority -100000) earlier in the same rAF tick, while this
    // subscriber is still registered. R3F's subscriber loop has no try/catch,
    // so throwing here would skip the remaining subscribers and gl.render.
    const state = viewerMutable.skinnedMeshState[message.name];
    if (state === undefined) return;
    // Only one live instance may drive an entry. Normally the init effect
    // claims it; but FilePlayback can recreate the entry WITHOUT a remount
    // (its loop and same-batch remove + re-add replay identical message
    // refs into a kept-mounted tree), so an unclaimed fresh entry is
    // adopted here. An entry claimed by a DIFFERENT live instance stays
    // untouchable (same-name re-add race).
    if (state !== ownedEntryRef.current) {
      if (state.claimed) return;
      state.claimed = true;
      state.initialized = false;
      ownedEntryRef.current = state;
    }
    const bones = bonesRef.current;
    // Belt over the identity guard: never index poses beyond our bones (a
    // mismatched entry would crash the R3F subscriber loop and kill
    // gl.render for the frame).
    if (state.poses.length !== (bones?.length ?? 0)) return;
    if (skeleton !== undefined && bones !== undefined) {
      if (!state.initialized) {
        const parentNode = viewerMutable.nodeRefFromName[message.name];
        if (parentNode === undefined) return;
        bones.forEach((bone) => {
          parentNode.add(bone);
        });
        state.initialized = true;
      }

      // Only update bones if dirty flag is set.
      if (state.dirty) {
        bones.forEach((bone, i) => {
          const wxyz = state.poses[i].wxyz;
          const position = state.poses[i].position;
          bone.quaternion.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
          bone.position.set(position[0], position[1], position[2]);
        });
        state.dirty = false; // Reset dirty flag after update.
      }
    }
  });

  return (
    <group ref={ref}>
      <skinnedMesh
        geometry={geometry}
        skeleton={skeleton}
        scale={normalizeScale(message.props.scale)}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
        frustumCulled={false}
      >
        <ViserStandardMeshMaterial {...message.props} />
        <OutlinesIfHovered
          enableCreaseAngle={geometry.attributes.position.count < 1024}
        />
      </skinnedMesh>
      <ShadowSkinnedMesh
        opacity={shadowOpacity}
        geometry={geometry}
        skeleton={skeleton}
        scale={normalizeScale(message.props.scale)}
      />
      {children}
    </group>
  );
});
