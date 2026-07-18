import React from "react";
import * as THREE from "three";
import { createStore } from "../store";
import { Object3D } from "three";
import { useThree } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";

/** Number of RGBA32UI texels each Gaussian occupies in the spherical
 * harmonics texture, indexed by SH degree. Each texel holds 8 float16
 * coefficients; a degree-d Gaussian has 3 * (d + 1)^2 coefficients. */
export const SH_TEXELS_PER_GAUSSIAN = [1, 2, 4, 6];

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
    shTextureBuffer: null as THREE.DataTexture | null,
    shTexelsPerGaussian: 0,
    shDegree: 0,
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

  // Spherical harmonics coefficients, as float16s packed into RGBA32UI
  // texels. Each Gaussian gets shTexelsPerGaussian texels; 0 disables
  // spherical harmonics (colors come from textureBuffer's RGBA).
  uniform usampler2D shTextureBuffer;
  uniform uint shTexelsPerGaussian;
  uniform uint shDegree;

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

  // Evaluate view-dependent color from spherical harmonics coefficients, in
  // the 3DGS (inria) convention. Uses the same recurrence relations as
  // gsplat's spherical_harmonics(); coefficients are laid out
  // coefficient-major (c0.rgb, c1.rgb, ...) as float16 pairs in RGBA32UI
  // texels.
  vec3 evalSphericalHarmonics(vec3 center, mat4 T_camera_group) {
    // Unpack this Gaussian's coefficients; up to 48 for degree 3. Elements
    // beyond shTexelsPerGaussian * 8 are left untouched and must not be read.
    float coeffs[48];
    ivec2 texSize = textureSize(shTextureBuffer, 0);
    int texStart = int(sortedIndex * shTexelsPerGaussian);
    for (int i = 0; i < 6; i++) {
      if (i >= int(shTexelsPerGaussian)) break;
      int texIndex = texStart + i;
      uvec4 texel = texelFetch(
        shTextureBuffer,
        ivec2(texIndex % texSize.x, texIndex / texSize.x),
        0);
      vec2 v01 = unpackHalf2x16(texel.x);
      vec2 v23 = unpackHalf2x16(texel.y);
      vec2 v45 = unpackHalf2x16(texel.z);
      vec2 v67 = unpackHalf2x16(texel.w);
      coeffs[i * 8 + 0] = v01.x;
      coeffs[i * 8 + 1] = v01.y;
      coeffs[i * 8 + 2] = v23.x;
      coeffs[i * 8 + 3] = v23.y;
      coeffs[i * 8 + 4] = v45.x;
      coeffs[i * 8 + 5] = v45.y;
      coeffs[i * 8 + 6] = v67.x;
      coeffs[i * 8 + 7] = v67.y;
    }

    // View direction in the group frame, which the harmonics are defined in.
    // The camera position in the group frame is -R^T t, from
    // T_camera_group = [R | t].
    vec3 t_group_camera = -(transpose(mat3(T_camera_group)) * T_camera_group[3].xyz);
    vec3 dir = normalize(center - t_group_camera);
    float x = dir.x;
    float y = dir.y;
    float z = dir.z;

    // Degree 0.
    vec3 rgb = 0.2820947917738781 * vec3(coeffs[0], coeffs[1], coeffs[2]);

    // Degree 1.
    rgb += 0.48860251190291987 * (
      -y * vec3(coeffs[3], coeffs[4], coeffs[5])
      + z * vec3(coeffs[6], coeffs[7], coeffs[8])
      - x * vec3(coeffs[9], coeffs[10], coeffs[11]));

    if (shDegree >= 2u) {
      float xx = x * x;
      float yy = y * y;
      float zz = z * z;
      float fTmp0B = -1.092548430592079 * z;
      float fC1 = xx - yy;
      float fS1 = 2.0 * x * y;
      float pSH6 = 0.9461746957575601 * zz - 0.3153915652525201;
      float pSH7 = fTmp0B * x;
      float pSH5 = fTmp0B * y;
      float pSH8 = 0.5462742152960395 * fC1;
      float pSH4 = 0.5462742152960395 * fS1;
      rgb += pSH4 * vec3(coeffs[12], coeffs[13], coeffs[14])
           + pSH5 * vec3(coeffs[15], coeffs[16], coeffs[17])
           + pSH6 * vec3(coeffs[18], coeffs[19], coeffs[20])
           + pSH7 * vec3(coeffs[21], coeffs[22], coeffs[23])
           + pSH8 * vec3(coeffs[24], coeffs[25], coeffs[26]);

      if (shDegree >= 3u) {
        float fTmp0C = -2.285228997322329 * zz + 0.4570457994644658;
        float fTmp1B = 1.445305721320277 * z;
        float fC2 = x * fC1 - y * fS1;
        float fS2 = x * fS1 + y * fC1;
        float pSH12 = z * (1.865881662950577 * zz - 1.119528997770346);
        float pSH13 = fTmp0C * x;
        float pSH11 = fTmp0C * y;
        float pSH14 = fTmp1B * fC1;
        float pSH10 = fTmp1B * fS1;
        float pSH15 = -0.5900435899266435 * fC2;
        float pSH9 = -0.5900435899266435 * fS2;
        rgb += pSH9 * vec3(coeffs[27], coeffs[28], coeffs[29])
             + pSH10 * vec3(coeffs[30], coeffs[31], coeffs[32])
             + pSH11 * vec3(coeffs[33], coeffs[34], coeffs[35])
             + pSH12 * vec3(coeffs[36], coeffs[37], coeffs[38])
             + pSH13 * vec3(coeffs[39], coeffs[40], coeffs[41])
             + pSH14 * vec3(coeffs[42], coeffs[43], coeffs[44])
             + pSH15 * vec3(coeffs[45], coeffs[46], coeffs[47]);
      }
    }

    return max(rgb + 0.5, vec3(0.0));
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
    if (shDegree > 0u) {
      vRgba.rgb = evalSphericalHarmonics(center, T_camera_group);
    }

    // Throw the Gaussian off the screen if it's too close, too far, or too small.
    float weightedDeterminant = vRgba.a * (diag1 * diag2 - offDiag * offDiag);
    if (weightedDeterminant < 0.25)
      return;
    vPosition = position.xy;

    gl_Position = vec4(
        (vec2(pos2d) / pos2d.w
            + position.x * v1 / viewport * 2.0
            + position.y * v2 / viewport * 2.0) * pos2d.w, pos2d.z, pos2d.w);


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
  shBuffer: Uint32Array | null = null,
  shDegree: number = 0,
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

  // Optional texture for spherical harmonics coefficients. When absent, a
  // 1x1 placeholder keeps the usampler2D uniform valid; the shader never
  // samples it since shDegree is 0.
  const shTexelsPerGaussian =
    shDegree > 0 ? SH_TEXELS_PER_GAUSSIAN[shDegree] : 0;
  let shTextureBuffer: THREE.DataTexture;
  if (shBuffer !== null && shDegree > 0) {
    const numShTexels = numGaussians * shTexelsPerGaussian;
    const shTextureWidth = Math.min(numShTexels, maxTextureSize);
    const shTextureHeight = Math.ceil(numShTexels / shTextureWidth);
    const shBufferPadded = new Uint32Array(shTextureWidth * shTextureHeight * 4);
    shBufferPadded.set(shBuffer);
    shTextureBuffer = new THREE.DataTexture(
      shBufferPadded,
      shTextureWidth,
      shTextureHeight,
      THREE.RGBAIntegerFormat,
      THREE.UnsignedIntType,
    );
  } else {
    shTextureBuffer = new THREE.DataTexture(
      new Uint32Array(4),
      1,
      1,
      THREE.RGBAIntegerFormat,
      THREE.UnsignedIntType,
    );
  }
  shTextureBuffer.internalFormat = "RGBA32UI";
  shTextureBuffer.needsUpdate = true;

  const material = new GaussianSplatMaterial();
  material.fog = true;
  material.textureBuffer = textureBuffer;
  material.shTextureBuffer = shTextureBuffer;
  material.shTexelsPerGaussian = shTexelsPerGaussian;
  material.shDegree = shDegree;
  material.textureT_camera_groups = textureT_camera_groups;
  material.numGaussians = numGaussians;

  return {
    geometry,
    material,
    textureBuffer,
    textureWidth,
    textureHeight,
    shTextureBuffer,
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
  shBuffer: Uint32Array | null = null,
  shDegree: number = 0,
) {
  const maxTextureSize = useThree((state) => state.gl).capabilities
    .maxTextureSize;
  return createGaussianMeshProps(
    gaussianBuffer,
    numGroups,
    maxTextureSize,
    shBuffer,
    shDegree,
  );
}
/**Per-group Gaussian data: the main splat buffer, plus optional spherical
 * harmonics coefficients for view-dependent colors.*/
export interface SplatGroupData {
  buffer: Uint32Array;
  shBuffer: Uint32Array | null;
  shDegree: number;
}

/**Global splat state.*/
interface SplatState {
  groupBufferFromId: { [id: string]: SplatGroupData };
  nodeRefFromId: React.MutableRefObject<{
    [name: string]: undefined | Object3D;
  }>;
  sceneNodeNameFromId: React.MutableRefObject<{
    [id: string]: string | undefined;
  }>;
}

interface SplatActions {
  setBuffer: (id: string, data: SplatGroupData) => void;
  removeBuffer: (id: string) => void;
}

/**Hook for creating global splat state.*/
export function useGaussianSplatStore() {
  const nodeRefFromId = React.useRef({});
  const sceneNodeNameFromId = React.useRef<{
    [id: string]: string | undefined;
  }>({});
  return React.useState(() => {
    const store = createStore<SplatState>({
      groupBufferFromId: {},
      nodeRefFromId: nodeRefFromId,
      sceneNodeNameFromId: sceneNodeNameFromId,
    });

    const actions: SplatActions = {
      setBuffer: (id, data) => {
        store.set((state) => ({
          groupBufferFromId: { ...state.groupBufferFromId, [id]: data },
        }));
      },
      removeBuffer: (id) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _, ...buffers } = store.get().groupBufferFromId;
        store.set({ groupBufferFromId: buffers });
      },
    };

    return { store, actions };
  })[0];
}

export const GaussianSplatsContext = React.createContext<{
  gaussianSplatState: ReturnType<typeof useGaussianSplatStore>;
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
