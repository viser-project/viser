import React from "react";
import * as THREE from "three";
import { create } from "zustand";
import { Object3D } from "three";
import { useThree } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";

const GaussianSplatMaterial = /* @__PURE__ */ shaderMaterial(
  {
    numGaussians: 0,
    viewport: [640, 480],
    near: 1.0,
    far: 100.0,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    textureBuffer: null as THREE.DataTexture | null,
    textureT_camera_groups: null as THREE.DataTexture | null,
    transitionInState: 0.0,
    projectionMatrixCustom: new THREE.Matrix4(),
    fogColor: new THREE.Color(1, 1, 1),
    fogNear: 0.0,
    fogFar: 1000.0,
  },
  `precision highp usampler2D; // Most important: ints must be 32-bit.
  precision mediump float;

  // Index from the splat sorter.
  attribute uint sortedIndex;

  // Buffers for splat data; each Gaussian gets 4 floats and 4 int32s. We just
  // copy quadjr for this.
  uniform usampler2D textureBuffer;

  // We could also use a uniform to store transforms, but this would be more
  // limiting in terms of the # of groups we can have.
  uniform sampler2D textureT_camera_groups;

  // Various other uniforms...
  uniform uint numGaussians;
  uniform vec2 viewport;
  uniform float near;
  uniform float far;
  uniform mat4 projectionMatrixCustom;

  // Fade in state between [0, 1].
  uniform float transitionInState;

  out vec4 vRgba;
  out vec2 vPosition;

  #include <fog_pars_vertex>

  // Function to fetch and construct the i-th transform matrix using texelFetch
  mat4 getGroupTransform(uint i) {
    // Calculate the base index for the i-th transform.
    uint baseIndex = i * 3u;

    // Fetch the texels that represent the first 3 rows of the transform. We
    // choose to use row-major here, since it lets us exclude the fourth row of
    // the matrix.
    vec4 row0 = texelFetch(textureT_camera_groups, ivec2(baseIndex + 0u, 0), 0);
    vec4 row1 = texelFetch(textureT_camera_groups, ivec2(baseIndex + 1u, 0), 0);
    vec4 row2 = texelFetch(textureT_camera_groups, ivec2(baseIndex + 2u, 0), 0);

    // Construct the mat4 with the fetched rows.
    mat4 transform = mat4(row0, row1, row2, vec4(0.0, 0.0, 0.0, 1.0));
    return transpose(transform);
  }

  void main () {
    // Get position + scale from float buffer.
    ivec2 texSize = textureSize(textureBuffer, 0);
    uint texStart = sortedIndex << 1u;
    ivec2 texPos0 = ivec2(texStart % uint(texSize.x), texStart / uint(texSize.x));


    // Fetch from textures.
    uvec4 floatBufferData = texelFetch(textureBuffer, texPos0, 0);
    mat4 T_camera_group = getGroupTransform(floatBufferData.w);

    // Any early return will discard the fragment.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    // Get center wrt camera. modelViewMatrix is T_cam_world.
    vec3 center = uintBitsToFloat(floatBufferData.xyz);
    vec4 c_cam = T_camera_group * vec4(center, 1);
    if (-c_cam.z < near || -c_cam.z > far)
      return;
    vec4 pos2d = projectionMatrixCustom * c_cam;
    float clip = 1.1 * pos2d.w;
    if (pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip)
      return;

    // Read covariance terms.
    ivec2 texPos1 = ivec2((texStart + 1u) % uint(texSize.x), (texStart + 1u) / uint(texSize.x));
    uvec4 intBufferData = texelFetch(textureBuffer, texPos1, 0);

    // Get covariance terms from int buffer.
    uint rgbaUint32 = intBufferData.w;
    vec2 triu01 = unpackHalf2x16(intBufferData.x);
    vec2 triu23 = unpackHalf2x16(intBufferData.y);
    vec2 triu45 = unpackHalf2x16(intBufferData.z);

    // Transition in.
    float startTime = 0.8 * float(sortedIndex) / float(numGaussians);
    float cov_scale = smoothstep(startTime, startTime + 0.2, transitionInState);

    // Extract focal lengths from projection matrix
    // In perspective projection: P[0][0] = 2*near/(right-left) = fx/width for symmetric frustum
    // So fx = P[0][0] * viewport.x / 2.0, fy = P[1][1] * viewport.y / 2.0
    float fx = projectionMatrixCustom[0][0] * viewport.x / 2.0;
    float fy = projectionMatrixCustom[1][1] * viewport.y / 2.0;

    // Do the actual splatting.
    mat3 cov3d = mat3(
        triu01.x, triu01.y, triu23.x,
        triu01.y, triu23.y, triu45.x,
        triu23.x, triu45.x, triu45.y
    );
    mat3 J = mat3(
        // Matrices are column-major.
        fx / c_cam.z, 0., 0.0,
        0., fy / c_cam.z, 0.0,
        -(fx * c_cam.x) / (c_cam.z * c_cam.z), -(fy * c_cam.y) / (c_cam.z * c_cam.z), 0.
    );
    mat3 A = J * mat3(T_camera_group);
    mat3 cov_proj = A * cov3d * transpose(A);
    float diag1 = cov_proj[0][0] + 0.3;
    float offDiag = cov_proj[0][1];
    float diag2 = cov_proj[1][1] + 0.3;

    // Eigendecomposition.
    float mid = 0.5 * (diag1 + diag2);
    float radius = length(vec2((diag1 - diag2) / 2.0, offDiag));
    float lambda1 = mid + radius;
    float lambda2 = mid - radius;
    if (lambda2 < 0.0)
      return;
    vec2 diagonalVector = normalize(vec2(offDiag, lambda1 - diag1));
    vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
    vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

    vRgba = vec4(
      float(rgbaUint32 & uint(0xFF)) / 255.0,
      float((rgbaUint32 >> uint(8)) & uint(0xFF)) / 255.0,
      float((rgbaUint32 >> uint(16)) & uint(0xFF)) / 255.0,
      float(rgbaUint32 >> uint(24)) / 255.0
    );

    // Throw the Gaussian off the screen if it's too close, too far, or too small.
    float weightedDeterminant = vRgba.a * (diag1 * diag2 - offDiag * offDiag);
    if (weightedDeterminant < 0.25)
      return;
    vPosition = position.xy;

    gl_Position = vec4(
        vec2(pos2d) / pos2d.w
            + position.x * v1 / viewport * 2.0
            + position.y * v2 / viewport * 2.0, pos2d.z / pos2d.w, 1.);

    #ifdef USE_FOG
      vFogDepth = -c_cam.z;
    #endif
  }
`,
  `precision mediump float;

  uniform vec2 viewport;

  in vec4 vRgba;
  in vec2 vPosition;

  #include <fog_pars_fragment>

  void main () {
    float A = -dot(vPosition, vPosition);
    if (A < -4.0) discard;
    float B = exp(A) * vRgba.a;
    if (B < 0.01) discard;  // alphaTest.
    gl_FragColor = vec4(vRgba.rgb, B);
    #include <fog_fragment>
  }`,
);

/** Type for mesh props returned by createGaussianMeshProps. */
export type GaussianMeshProps = ReturnType<typeof createGaussianMeshProps>;

/** Create properties for rendering Gaussians via a three.js mesh. */
export function createGaussianMeshProps(
  gaussianBuffer: Uint32Array,
  numGroups: number,
  maxTextureSize: number,
) {
  const numGaussians = gaussianBuffer.length / 8;

  // Create instanced geometry.
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = numGaussians;
  geometry.setIndex(
    new THREE.BufferAttribute(new Uint32Array([0, 2, 1, 0, 3, 2]), 1),
  );
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]),
      2,
    ),
  );

  // Rendering order for Gaussians.
  const sortedIndexAttribute = new THREE.InstancedBufferAttribute(
    new Uint32Array(numGaussians),
    1,
  );
  sortedIndexAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("sortedIndex", sortedIndexAttribute);

  // Create texture buffers.
  const textureWidth = Math.min(numGaussians * 2, maxTextureSize);
  const textureHeight = Math.ceil((numGaussians * 2) / textureWidth);
  const bufferPadded = new Uint32Array(textureWidth * textureHeight * 4);
  bufferPadded.set(gaussianBuffer);
  const textureBuffer = new THREE.DataTexture(
    bufferPadded,
    textureWidth,
    textureHeight,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedIntType,
  );
  textureBuffer.internalFormat = "RGBA32UI";
  textureBuffer.needsUpdate = true;

  const rowMajorT_camera_groups = new Float32Array(numGroups * 12);
  const textureT_camera_groups = new THREE.DataTexture(
    rowMajorT_camera_groups,
    (numGroups * 12) / 4,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  textureT_camera_groups.internalFormat = "RGBA32F";
  textureT_camera_groups.needsUpdate = true;

  const material = new GaussianSplatMaterial();
  material.fog = true;
  material.textureBuffer = textureBuffer;
  material.textureT_camera_groups = textureT_camera_groups;
  material.numGaussians = numGaussians;

  return {
    geometry,
    material,
    textureBuffer,
    textureWidth,
    textureHeight,
    sortedIndexAttribute,
    textureT_camera_groups,
    rowMajorT_camera_groups,
    numGaussians,
    numGroups,
  };
}

/**Hook to generate properties for rendering Gaussians via a three.js mesh.*/
export function useGaussianMeshProps(
  gaussianBuffer: Uint32Array,
  numGroups: number,
) {
  const maxTextureSize = useThree((state) => state.gl).capabilities
    .maxTextureSize;
  return createGaussianMeshProps(gaussianBuffer, numGroups, maxTextureSize);
}
/**Global splat state.*/
interface SplatState {
  groupBufferFromId: { [id: string]: Uint32Array };
  nodeRefFromId: React.MutableRefObject<{
    [name: string]: undefined | Object3D;
  }>;
  setBuffer: (id: string, buffer: Uint32Array) => void;
  removeBuffer: (id: string) => void;
}

/**Hook for creating global splat state.*/
export function useGaussianSplatStore() {
  const nodeRefFromId = React.useRef({});
  return React.useState(() =>
    create<SplatState>((set) => ({
      groupBufferFromId: {},
      nodeRefFromId: nodeRefFromId,
      setBuffer: (id, buffer) => {
        return set((state) => ({
          groupBufferFromId: { ...state.groupBufferFromId, [id]: buffer },
        }));
      },
      removeBuffer: (id) => {
        return set((state) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [id]: _, ...buffers } = state.groupBufferFromId;
          return { groupBufferFromId: buffers };
        });
      },
    })),
  )[0];
}

export const GaussianSplatsContext = React.createContext<{
  useGaussianSplatStore: ReturnType<typeof useGaussianSplatStore>;
  updateCamera: React.MutableRefObject<
    | null
    | ((
        camera: THREE.PerspectiveCamera,
        width: number,
        height: number,
        blockingSort: boolean,
      ) => void)
  >;
  meshPropsRef: React.MutableRefObject<ReturnType<
    typeof useGaussianMeshProps
  > | null>;
} | null>(null);
