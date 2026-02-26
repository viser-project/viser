import React from "react";
import * as THREE from "three";
import { GlbMessage } from "../WebsocketMessages";
import { useGlbLoader } from "./GlbLoaderUtils";
import { useFrame, useThree } from "@react-three/fiber";
import { HoverableContext } from "../HoverContext";
import { OutlinesMaterial } from "../Outlines";
import { normalizeScale } from "../utils/normalizeScale";

/**
 * Component for rendering a single GLB model
 */
export const SingleGlbAsset = React.forwardRef<
  THREE.Group,
  GlbMessage & { children?: React.ReactNode }
>(function SingleGlbAsset(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  // Load model without passing shadow settings - we'll apply them in useEffect.
  const { gltf, meshes, mixerRef } = useGlbLoader(message.props.glb_data);

  // Apply shadow settings directly to the model.
  React.useEffect(() => {
    if (!gltf) return;

    gltf.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = message.props.cast_shadow;
        // Only set receiveShadow if receive_shadow is a boolean true.
        obj.receiveShadow = message.props.receive_shadow === true;
      }
    });
  }, [gltf, message.props.cast_shadow, message.props.receive_shadow]);

  // Update animations on each frame if mixer exists.
  useFrame((_, delta: number) => {
    mixerRef.current?.update(delta);
  });

  // Get rendering context for screen size.
  const gl = useThree((state) => state.gl);
  const contextSize = React.useMemo(
    () => gl.getDrawingBufferSize(new THREE.Vector2()),
    [gl],
  );

  // Hover/clicking.
  const outlineMaterial = React.useMemo(() => {
    const material = new OutlinesMaterial({
      side: THREE.BackSide,
      fog: true,
    });
    material.thickness = 10;
    material.color = new THREE.Color(0xfbff00); // Yellow highlight color
    material.opacity = 0.8;
    material.size = contextSize;
    material.transparent = true;
    material.screenspace = true; // Use screenspace for consistent thickness
    material.toneMapped = true;
    return material;
  }, [contextSize]);
  const outlineRef = React.useRef<THREE.Group>(null);
  const hoverContext = React.useContext(HoverableContext)!;
  useFrame(() => {
    if (outlineRef.current === null) return;
    outlineRef.current.visible = hoverContext.state.current.isHovered;
  });
  const clickable = hoverContext.clickable;

  // Check if we should render shadow meshes.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  // Create shadow material for shadow meshes.
  const shadowMaterial = React.useMemo(() => {
    if (shadowOpacity === 0.0) return null;
    return new THREE.ShadowMaterial({
      opacity: shadowOpacity,
      color: 0x000000,
      depthWrite: false,
    });
  }, [shadowOpacity]);
  if (!gltf) return null;

  return (
    <group ref={ref}>
      <primitive
        object={gltf.scene}
        scale={normalizeScale(message.props.scale)}
      />
      {shadowMaterial && shadowOpacity > 0 ? (
        <group scale={normalizeScale(message.props.scale)}>
          {meshes.map((mesh, i) => (
            <mesh
              key={`shadow-${i}`}
              geometry={mesh.geometry}
              material={shadowMaterial}
              receiveShadow
              position={mesh.position}
              rotation={mesh.rotation}
              scale={mesh.scale}
            />
          ))}
        </group>
      ) : null}
      {clickable ? (
        <group ref={outlineRef} visible={false}>
          {meshes.map((mesh, i) => (
            <mesh key={i} geometry={mesh.geometry} material={outlineMaterial} />
          ))}
        </group>
      ) : null}
      {children}
    </group>
  );
});
