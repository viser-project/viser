import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import React from "react";
import { HoverableContext } from "./HoverContext";
import * as THREE from "three";
import { CameraFrustumMessage } from "./WebsocketMessages";
import { rgbToInt } from "./mesh/MeshUtils";
import { normalizeScale } from "./utils/normalizeScale";

/** Helper for visualizing camera frustums. */
export const CameraFrustumComponent = React.forwardRef<
  THREE.Group,
  CameraFrustumMessage & { children?: React.ReactNode }
>(function CameraFrustumComponent({ children, ...message }, ref) {
  // We can't use useMemo here because TextureLoader.load is asynchronous.
  // And we need to use setState to update the texture after loading.
  const [imageTexture, setImageTexture] = React.useState<THREE.Texture>();

  React.useEffect(() => {
    if (message.props._format !== null && message.props._image_data !== null) {
      const image_url = URL.createObjectURL(
        new Blob([message.props._image_data], {
          type: "image/" + message.props._format,
        }),
      );
      new THREE.TextureLoader().load(image_url, (texture) => {
        setImageTexture(texture);
        URL.revokeObjectURL(image_url);
      });
    } else {
      setImageTexture(undefined);
    }
  }, [message.props._format, message.props._image_data]);

  let y = Math.tan(message.props.fov / 2.0);
  let x = y * message.props.aspect;
  let z = 1.0;

  const volumeScale = Math.cbrt((x * y * z) / 3.0);
  x /= volumeScale;
  y /= volumeScale;
  z /= volumeScale;
  const scaleTuple = normalizeScale(message.props.scale);
  x *= scaleTuple[0];
  y *= scaleTuple[1];
  z *= scaleTuple[2];

  const hoverContext = React.useContext(HoverableContext);
  const [isHovered, setIsHovered] = React.useState(false);

  useFrame(() => {
    if (
      hoverContext !== null &&
      hoverContext.state.current.isHovered !== isHovered
    ) {
      setIsHovered(hoverContext.state.current.isHovered);
    }
  });

  const frustumPoints: [number, number, number][] = [
    // Rectangle.
    [-1, -1, 1],
    [1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [1, 1, 1],
    [-1, 1, 1],
    [-1, 1, 1],
    [-1, -1, 1],
    // Lines to origin.
    [-1, -1, 1],
    [0, 0, 0],
    [0, 0, 0],
    [1, -1, 1],
    // Lines to origin.
    [-1, 1, 1],
    [0, 0, 0],
    [0, 0, 0],
    [1, 1, 1],
    // Up direction indicator.
    // Don't overlap with the image if the image is present.
    [0.0, -1.2, 1.0],
    imageTexture === undefined ? [0.0, -0.9, 1.0] : [0.0, -1.0, 1.0],
  ].map((xyz) => [xyz[0] * x, xyz[1] * y, xyz[2] * z]);

  // Create geometry for filled variant
  const geometry = React.useMemo(() => {
    if (message.props.variant !== "filled") return null;

    const geom = new THREE.BufferGeometry();

    // Define vertices
    const vertices = new Float32Array([
      // Near plane (origin)
      0,
      0,
      0,
      // Far plane corners
      -x,
      -y,
      z,
      x,
      -y,
      z,
      x,
      y,
      z,
      -x,
      y,
      z,
    ]);

    // Define faces
    const indices = new Uint16Array([
      // Side faces
      0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1,
      // Far plane
      1, 4, 3, 1, 3, 2,
    ]);

    geom.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();

    return geom;
  }, [x, y, z, message.props.variant]);

  const color = new THREE.Color().setRGB(
    message.props.color[0] / 255,
    message.props.color[1] / 255,
    message.props.color[2] / 255,
  );

  return (
    <group ref={ref}>
      {/* Wireframe lines - always visible */}
      <Line
        points={frustumPoints}
        color={isHovered ? 0xfbff00 : rgbToInt(message.props.color)}
        lineWidth={
          isHovered ? 1.5 * message.props.line_width : message.props.line_width
        }
        segments
      />

      {/* Filled faces - only for "filled" variant */}
      {message.props.variant === "filled" && geometry && (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color={isHovered ? 0xfbff00 : color}
            transparent
            opacity={0.3}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Image plane */}
      {imageTexture && (
        <mesh
          // 0.999999 is to avoid z-fighting with the frustum lines.
          position={[0.0, 0.0, z * 0.999999]}
          rotation={new THREE.Euler(Math.PI, 0.0, 0.0)}
          castShadow={message.props.cast_shadow}
          receiveShadow={message.props.receive_shadow === true}
        >
          <planeGeometry
            attach="geometry"
            args={[message.props.aspect * y * 2, y * 2]}
          />
          <meshBasicMaterial
            attach="material"
            transparent={true}
            side={THREE.DoubleSide}
            map={imageTexture}
            toneMapped={false}
          />
        </mesh>
      )}
      {children}
    </group>
  );
});
