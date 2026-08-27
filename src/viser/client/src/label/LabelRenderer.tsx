/** GPU-instanced 3D label renderer.
 *
 * Replaces the previous troika-three-text pipeline. Text is rasterized with
 * the system font stack into canvas glyph atlases (GlyphAtlas.ts); every
 * label renders as one background quad plus one instanced quad per grapheme
 * cluster. Billboarding and screen-space scaling run in the vertex shader,
 * so the per-frame JS work is just writing each label's world position and
 * visibility into a small data texture.
 *
 * Atlases exist per font-pixel bucket: a label's rasterization resolution is
 * derived from its own configuration (screen-space labels have a constant
 * on-screen size of 12 * fontScreenScale CSS px) and the device pixel ratio.
 *
 * Draw order follows ReversedDepthSort.ts / issue #767 conventions:
 * backgrounds (9999) below Gaussian splats (10000), glyphs (10001) above.
 */
import React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { ViewerContext } from "../ViewerContext";
import { GlyphAtlas } from "./GlyphAtlas";
import { parseAnchor } from "./labelLayout";
import {
  buildInstanceBuffers,
  InstanceBuffers,
  LabelEntryConfig,
} from "./labelInstances";

import {
  LabelConfig,
  LabelHandle,
  LabelRendererContext,
} from "./LabelRendererContext";

/** Reference viewport height for screen-space label sizing: labels keep a
 * constant pixel size relative to this height. */
const REFERENCE_VIEWPORT_HEIGHT = 800;

/** Base font size in world units, matching the previous implementation:
 * "screen" mode is calibrated at 0.3 * scale at 10 units depth. */
function baseFontSize(config: LabelConfig): number {
  return config.fontSizeMode === "screen"
    ? 0.3 * config.fontScreenScale
    : config.fontSceneHeight;
}

/** Atlas font-pixel bucket for a label, from data we already have: a
 * screen-mode label's on-screen em size is constant at
 * 12 * fontScreenScale CSS px (0.3 * scale * REFERENCE_VIEWPORT_HEIGHT / 2 /
 * 10); scene-mode labels have no intrinsic pixel size, so they use a
 * middle-of-the-road bucket. Scaled by devicePixelRatio and rounded up to a
 * power of two so a handful of atlases serve all labels. */
function fontPxBucket(config: LabelConfig): number {
  const dpr = Math.min(
    typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1,
    2,
  );
  const nominalPx =
    config.fontSizeMode === "screen" ? 12 * config.fontScreenScale * dpr : 64;
  const clamped = Math.min(256, Math.max(16, nominalPx));
  return 2 ** Math.ceil(Math.log2(clamped));
}

const VERTEX_SHADER = /* glsl */ `
attribute float aLabelIndex;
attribute vec4 aRect;   // (left, bottom, width, height), label-local Y-up atlas px.
attribute vec4 aUvRect; // (u0, vTop, u1, vBottom).
attribute vec2 aParams; // (sizeMode: 0 scene / 1 screen, world units per atlas px).

uniform sampler2D uLabelData; // 1 texel per label: (x, y, z, visibility).
uniform float uLabelTexWidth;
uniform float uFovScale;        // tan(fov / 2).
uniform float uViewportHeight;  // px.
uniform float uIsOrtho;

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec4 data = texture2D(
    uLabelData, vec2((aLabelIndex + 0.5) / uLabelTexWidth, 0.5));
  vec3 labelPos = data.xyz;
  float visibility = data.w;

  float scale = aParams.y;
  if (aParams.x > 0.5) {
    // Screen-space sizing: constant pixel size (see
    // calculateScreenSpaceScale in the previous implementation).
    float refScale = ${REFERENCE_VIEWPORT_HEIGHT.toFixed(1)} / uViewportHeight;
    if (uIsOrtho > 0.5) {
      scale *= refScale;
    } else {
      float depth = -(viewMatrix * vec4(labelPos, 1.0)).z;
      scale *= (depth / 10.0) * uFovScale * refScale;
    }
  }
  // Collapse hidden labels to zero-area quads (no fragments).
  scale *= visibility;

  vec2 corner = position.xy; // Unit quad, [0, 1]^2.
  vec2 local = (aRect.xy + corner * aRect.zw) * scale;

  // Billboard: camera right/up axes from the view matrix.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 worldPos = labelPos + right * local.x + up * local.y;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  vUv = vec2(
    mix(aUvRect.x, aUvRect.z, corner.x),
    mix(aUvRect.w, aUvRect.y, corner.y));
  vAlpha = visibility;
}
`;

const GLYPH_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vAlpha;

void main() {
  float a = texture2D(uAtlas, vUv).a;
  // Sharpen the coverage ramp using screen-space derivatives: this
  // approximates SDF-style edge thresholding when the glyph is magnified or
  // trilinear filtering softens it, and degrades to the plain antialiased
  // coverage for small text (where the ramp already spans ~1 pixel).
  float w = max(fwidth(a), 1e-4);
  a = clamp((a - 0.5) / min(w, 1.0) + 0.5, 0.0, 1.0);
  a *= vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

const BACKGROUND_FRAGMENT_SHADER = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;

void main() {
  gl_FragColor = vec4(1.0, 1.0, 1.0, 0.85 * vAlpha);
}
`;

/** Maximum labels; one texel per label in the data texture. */
const MAX_LABELS = 4096;

/** Draw order (see ReversedDepthSort.ts and issue #767): backgrounds below
 * Gaussian splats (10000, GaussianSplats.tsx), glyphs strictly above them --
 * labels are annotations, so their text always composites over splats. */
const LABEL_BACKGROUND_RENDER_ORDER = 9_999;
const LABEL_TEXT_RENDER_ORDER = 10_001;

interface LabelEntry {
  config: LabelConfig;
  labelIndex: number;
  parentName: string;
  /** Rebuild group this entry currently belongs to (see groupKey). */
  groupKey: string;
}

/** Labels are rebuilt in groups of one glyph mesh each: a (depth test, atlas
 * bucket) pair. Tracking dirtiness per group keeps a single label update from
 * re-laying-out every label in the scene. */
function groupKey(config: LabelConfig): string {
  return `${config.depthTest}-${fontPxBucket(config)}`;
}

function parseGroupKey(key: string): { depthTest: boolean; bucket: number } {
  const [depthTest, bucket] = key.split("-");
  return { depthTest: depthTest === "true", bucket: Number(bucket) };
}

/** Unit quad geometry with corners in [0, 1]^2 shared by all label meshes. */
function makeQuadGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0.5, 0.5, 0);
  return geometry;
}

export const LabelRenderer: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => {
  const viewer = React.useContext(ViewerContext)!;

  const state = React.useMemo(() => {
    const labelData = new Float32Array(MAX_LABELS * 4);
    const labelTexture = new THREE.DataTexture(
      labelData,
      MAX_LABELS,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    labelTexture.minFilter = THREE.NearestFilter;
    labelTexture.magFilter = THREE.NearestFilter;
    labelTexture.needsUpdate = true;

    // Shared uniform objects: one instance of each, referenced by every
    // material, so the per-frame camera updates are written exactly once.
    const sharedUniforms = {
      uLabelData: { value: labelTexture },
      uLabelTexWidth: { value: MAX_LABELS },
      uFovScale: { value: 1.0 },
      uViewportHeight: { value: REFERENCE_VIEWPORT_HEIGHT },
      uIsOrtho: { value: 0.0 },
    };

    const quad = makeQuadGeometry();
    const group = new THREE.Group();

    // One background mesh per depth-test setting; glyph meshes are created
    // lazily per (depth test, atlas bucket) pair.
    const bgMeshes = new Map<boolean, THREE.Mesh>();
    for (const depthTest of [true, false]) {
      const bgMaterial = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: BACKGROUND_FRAGMENT_SHADER,
        uniforms: sharedUniforms,
        transparent: true,
        depthTest,
        depthWrite: false,
      });
      const bgGeometry = new THREE.InstancedBufferGeometry();
      bgGeometry.index = quad.index;
      bgGeometry.attributes.position = quad.attributes.position;
      bgGeometry.instanceCount = 0;
      const bg = new THREE.Mesh(bgGeometry, bgMaterial);
      bg.renderOrder = LABEL_BACKGROUND_RENDER_ORDER;
      bg.frustumCulled = false;
      group.add(bg);
      bgMeshes.set(depthTest, bg);
    }

    return {
      atlases: new Map<number, GlyphAtlas>(),
      labelData,
      labelTexture,
      sharedUniforms,
      quad,
      group,
      bgMeshes,
      glyphMeshes: new Map<string, THREE.Mesh>(),
      entries: new Map<symbol, LabelEntry>(),
      freeIndices: [] as number[],
      nextIndex: 0,
      /** Groups whose instance buffers need rebuilding. */
      dirtyGroups: new Set<string>(),
      /** Last-built buffers per group; background meshes concatenate these,
       * so clean groups don't need re-layout when a sibling group changes. */
      groupBuffers: new Map<string, InstanceBuffers>(),
    };
  }, []);

  const getAtlas = React.useCallback(
    (fontPx: number): GlyphAtlas => {
      let atlas = state.atlases.get(fontPx);
      if (!atlas) {
        atlas = new GlyphAtlas(fontPx);
        state.atlases.set(fontPx, atlas);
      }
      return atlas;
    },
    [state],
  );

  const getGlyphMesh = React.useCallback(
    (depthTest: boolean, fontPx: number): THREE.Mesh => {
      const key = `${depthTest}-${fontPx}`;
      let mesh = state.glyphMeshes.get(key);
      if (!mesh) {
        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: GLYPH_FRAGMENT_SHADER,
          uniforms: {
            ...state.sharedUniforms,
            uAtlas: { value: getAtlas(fontPx).texture },
          },
          transparent: true,
          depthTest,
          depthWrite: false,
        });
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.index = state.quad.index;
        geometry.attributes.position = state.quad.attributes.position;
        geometry.instanceCount = 0;
        mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = LABEL_TEXT_RENDER_ORDER;
        mesh.frustumCulled = false;
        state.group.add(mesh);
        state.glyphMeshes.set(key, mesh);
      }
      return mesh;
    },
    [state, getAtlas],
  );

  // Rebuild the instance buffers of every dirty group.
  const rebuildDirtyGroups = React.useCallback(() => {
    // Each rebuild swaps in a freshly created geometry rather than replacing
    // attributes in place: a once-rendered InstancedBufferGeometry can keep
    // drawing from its original VAO after setAttribute, so in-place updates
    // silently render stale content. Rebuilds only happen when labels are
    // added/removed/changed, so the reallocation cost is irrelevant.
    const swapGeometry = (
      mesh: THREE.Mesh,
      labelIndex: Float32Array,
      rect: Float32Array,
      params: Float32Array,
      uv: Float32Array,
      count: number,
    ) => {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = state.quad.index!.clone();
      geometry.attributes.position = state.quad.attributes.position.clone();
      geometry.setAttribute(
        "aLabelIndex",
        new THREE.InstancedBufferAttribute(labelIndex, 1),
      );
      geometry.setAttribute(
        "aRect",
        new THREE.InstancedBufferAttribute(rect, 4),
      );
      geometry.setAttribute(
        "aParams",
        new THREE.InstancedBufferAttribute(params, 2),
      );
      geometry.setAttribute(
        "aUvRect",
        new THREE.InstancedBufferAttribute(uv, 4),
      );
      geometry.instanceCount = count;
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    };

    // Building glyph cells can grow an atlas, which invalidates every UV
    // previously built from it -- including groups built earlier in this very
    // call, or groups that weren't dirty at all. Snapshot generations, build,
    // and re-mark everything an atlas resize touched; the attempt cap turns a
    // scene whose glyphs cannot fit even a maximum-size atlas into a rendering
    // artifact instead of an infinite loop.
    const MAX_ATTEMPTS = 4;
    const touchedDepthTests = new Set<boolean>();
    for (let attempt = 0; state.dirtyGroups.size > 0; attempt++) {
      if (attempt >= MAX_ATTEMPTS) {
        console.warn(
          "[LabelRenderer] Glyph atlas kept overflowing; some labels may render incorrectly.",
        );
        state.dirtyGroups.clear();
        break;
      }
      const groups = [...state.dirtyGroups];
      state.dirtyGroups.clear();
      const generationsBefore = new Map(
        [...state.atlases].map(([bucket, atlas]) => [bucket, atlas.generation]),
      );

      for (const key of groups) {
        const { depthTest, bucket } = parseGroupKey(key);
        touchedDepthTests.add(depthTest);
        const configs: LabelEntryConfig[] = [];
        state.entries.forEach((entry) => {
          if (entry.groupKey !== key) return;
          configs.push({
            text: entry.config.text,
            sizeMode: entry.config.fontSizeMode,
            scalePxToUnit: baseFontSize(entry.config) / bucket,
            ...parseAnchor(entry.config.anchor),
            labelIndex: entry.labelIndex,
          });
        });
        const atlas = getAtlas(bucket);
        const buffers = buildInstanceBuffers(
          configs,
          (text) => atlas.measure(text),
          (cluster) => atlas.getCell(cluster),
          { ascent: atlas.ascent, descent: atlas.descent },
        );
        state.groupBuffers.set(key, buffers);
        swapGeometry(
          getGlyphMesh(depthTest, bucket),
          buffers.glyphLabelIndex,
          buffers.glyphRect,
          buffers.glyphParams,
          buffers.glyphUv,
          buffers.glyphCount,
        );
      }

      state.atlases.forEach((atlas, bucket) => {
        if (generationsBefore.get(bucket) === atlas.generation) return;
        for (const key of state.groupBuffers.keys()) {
          if (parseGroupKey(key).bucket === bucket) state.dirtyGroups.add(key);
        }
      });
    }

    // Backgrounds live in one mesh per depth-test setting; reassemble them
    // from the cached per-group buffers.
    for (const depthTest of touchedDepthTests) {
      const bgLabelIndex: number[] = [];
      const bgRect: number[] = [];
      const bgParams: number[] = [];
      state.groupBuffers.forEach((buffers, key) => {
        if (parseGroupKey(key).depthTest !== depthTest) return;
        bgLabelIndex.push(...buffers.bgLabelIndex);
        bgRect.push(...buffers.bgRect);
        bgParams.push(...buffers.bgParams);
      });
      swapGeometry(
        state.bgMeshes.get(depthTest)!,
        new Float32Array(bgLabelIndex),
        new Float32Array(bgRect),
        new Float32Array(bgParams),
        new Float32Array(bgLabelIndex.length * 4),
        bgLabelIndex.length,
      );
    }
  }, [state, getAtlas, getGlyphMesh]);

  const register = React.useCallback(
    (config: LabelConfig): LabelHandle => {
      let labelIndex: number;
      if (state.freeIndices.length > 0) {
        labelIndex = state.freeIndices.pop()!;
      } else if (state.nextIndex < MAX_LABELS) {
        labelIndex = state.nextIndex++;
      } else {
        console.warn("[LabelRenderer] Too many labels; label dropped.");
        return { update: () => {}, dispose: () => {} };
      }
      const key = Symbol();
      const entryGroup = groupKey(config);
      state.entries.set(key, {
        config,
        labelIndex,
        parentName: config.name.split("/").slice(0, -1).join("/"),
        groupKey: entryGroup,
      });
      state.dirtyGroups.add(entryGroup);

      return {
        update: (newConfig: LabelConfig) => {
          const entry = state.entries.get(key);
          if (!entry) return;
          // Config changes can move the label between groups (depth test or
          // bucket changed); both the old and new group need rebuilding.
          state.dirtyGroups.add(entry.groupKey);
          entry.config = newConfig;
          entry.parentName = newConfig.name.split("/").slice(0, -1).join("/");
          entry.groupKey = groupKey(newConfig);
          state.dirtyGroups.add(entry.groupKey);
        },
        dispose: () => {
          const entry = state.entries.get(key);
          if (!entry) return;
          state.entries.delete(key);
          state.freeIndices.push(entry.labelIndex);
          // Zero the slot so a stale texel can't flash before rebuild.
          state.labelData.fill(
            0,
            entry.labelIndex * 4,
            entry.labelIndex * 4 + 4,
          );
          state.dirtyGroups.add(entry.groupKey);
        },
      };
    },
    [state],
  );

  const api = React.useMemo(() => ({ register }), [register]);

  // Dispose GPU resources on unmount.
  React.useEffect(() => {
    return () => {
      const disposeMesh = (mesh: THREE.Mesh) => {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      };
      state.bgMeshes.forEach(disposeMesh);
      state.glyphMeshes.forEach(disposeMesh);
      state.quad.dispose();
      state.labelTexture.dispose();
      state.atlases.forEach((atlas) => atlas.dispose());
    };
  }, [state]);

  const tempPosition = React.useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size }) => {
    // Rebuild groups whose labels were added/removed/changed. Atlas growth
    // (stale UVs) is handled inside the rebuild.
    if (state.dirtyGroups.size > 0) rebuildDirtyGroups();

    // Camera uniforms for screen-space sizing.
    const isPerspective = "fov" in camera && typeof camera.fov === "number";
    state.sharedUniforms.uFovScale.value = isPerspective
      ? Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)
      : 1.0;
    state.sharedUniforms.uIsOrtho.value = isPerspective ? 0.0 : 1.0;
    state.sharedUniforms.uViewportHeight.value = size.height;

    // Per-label: world position + visibility into the data texture.
    state.entries.forEach((entry) => {
      const base = entry.labelIndex * 4;
      const parentRef =
        viewer.mutable.current.nodeRefFromName[entry.parentName];
      const node = viewer.useSceneTree.get(entry.config.name);
      if (parentRef && node) {
        const pose = viewer.mutable.current.nodePoseData[entry.config.name];
        tempPosition.set(...(pose?.position ?? ([0, 0, 0] as const)));
        tempPosition.applyMatrix4(parentRef.matrixWorld);
        state.labelData[base] = tempPosition.x;
        state.labelData[base + 1] = tempPosition.y;
        state.labelData[base + 2] = tempPosition.z;
        state.labelData[base + 3] = (node.effectiveVisibility ?? false) ? 1 : 0;
      } else {
        state.labelData[base + 3] = 0;
      }
    });
    state.labelTexture.needsUpdate = true;
  });

  return (
    <LabelRendererContext.Provider value={api}>
      <primitive object={state.group} />
      {children}
    </LabelRendererContext.Provider>
  );
};
