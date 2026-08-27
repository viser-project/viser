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
 * Screen-space labels rasterize at their exact physical pixel size and render
 * with a grid-snapped anchor, so atlas texels map 1:1 to screen pixels.
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

/** Screen-mode labels are calibrated to a 12 CSS px em at fontScreenScale 1;
 * this matches the previous implementation's 0.3 * scale world units at 10
 * units depth in an 800 px-tall viewport. */
const SCREEN_EM_CSS_PX = 12;

/** Device pixel ratio used for label rasterization, capped so ultra-dense
 * displays don't inflate atlas memory. */
function labelDpr(): number {
  return Math.min(
    typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1,
    3,
  );
}

/** A screen-mode label's on-screen em size in physical pixels. */
function screenEmPx(config: LabelConfig): number {
  return SCREEN_EM_CSS_PX * config.fontScreenScale * labelDpr();
}

/** Atlas font-pixel bucket for a label, from data we already have.
 *
 * Screen-mode labels rasterize at their *exact* on-screen pixel size (their
 * em size is constant and known from the config), so atlas texels map 1:1 to
 * screen pixels and text renders as crisply as DOM text; one atlas serves
 * each distinct (fontScreenScale, devicePixelRatio) in the scene, which is
 * one or two atlases in practice. Scene-mode labels have no intrinsic pixel
 * size and use a middle-of-the-road bucket. */
function fontPxBucket(config: LabelConfig): number {
  const nominalPx = config.fontSizeMode === "screen" ? screenEmPx(config) : 64;
  return Math.min(256, Math.max(8, Math.round(nominalPx)));
}

/** Value of the aParams.y instance attribute: for scene-mode labels, world
 * units per atlas px; for screen-mode labels, physical screen px per atlas px
 * -- exactly 1 unless the bucket clamp bound, so glyph texels stay aligned
 * with the pixel grid (the em is quantized to the nearest integer px, like
 * DOM text, rather than resampled). */
function atlasPxScale(config: LabelConfig, bucket: number): number {
  if (config.fontSizeMode === "scene") return config.fontSceneHeight / bucket;
  const nominalPx = screenEmPx(config);
  return Math.round(nominalPx) === bucket ? 1.0 : nominalPx / bucket;
}

const VERTEX_SHADER = /* glsl */ `
attribute float aLabelIndex;
attribute vec4 aRect;   // (left, bottom, width, height), label-local Y-up atlas px.
attribute vec4 aUvRect; // (u0, vTop, u1, vBottom).
attribute vec2 aParams; // (sizeMode: 0 scene / 1 screen, scale: see atlasPxScale).

uniform sampler2D uLabelData; // 1 texel per label: (x, y, z, visibility).
uniform float uLabelTexWidth;
uniform vec2 uViewportPhys; // Drawing buffer size, physical px.

varying vec2 vUv;
varying float vAlpha;
varying float vScreenMode;

void main() {
  vec4 data = texture2D(
    uLabelData, vec2((aLabelIndex + 0.5) / uLabelTexWidth, 0.5));
  vec3 labelPos = data.xyz;
  float visibility = data.w; // Hidden labels collapse to zero-area quads.

  vec2 corner = position.xy; // Unit quad, [0, 1]^2.
  vec4 clip = projectionMatrix * viewMatrix * vec4(labelPos, 1.0);

  if (aParams.x > 0.5) {
    // Screen-space labels are laid out directly in physical pixels: the
    // anchor snaps to the pixel grid and one atlas px maps to aParams.y
    // (exactly 1 unless the atlas bucket clamp bound) physical px, so glyph
    // texels align 1:1 with screen pixels. Orthographic projections keep the
    // previous implementation's behavior of scaling labels with camera zoom:
    // projection[1][1] is proportional to zoom, and the factor 10 calibrates
    // to a 20-world-unit frustum height (the perspective path's reference
    // depth of 10).
    float orthoZoom =
      projectionMatrix[3][3] > 0.5 ? projectionMatrix[1][1] * 10.0 : 1.0;
    vec2 anchorPx =
      floor((clip.xy / clip.w * 0.5 + 0.5) * uViewportPhys + 0.5);
    vec2 offsetPx =
      (aRect.xy + corner * aRect.zw) * (aParams.y * orthoZoom) * visibility;
    vec2 ndc = (anchorPx + offsetPx) / uViewportPhys * 2.0 - 1.0;
    gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
  } else {
    // Scene-space labels billboard in world units: camera right/up axes come
    // from the view matrix.
    vec2 local = (aRect.xy + corner * aRect.zw) * (aParams.y * visibility);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    gl_Position = projectionMatrix * viewMatrix *
      vec4(labelPos + right * local.x + up * local.y, 1.0);
  }

  vUv = vec2(
    mix(aUvRect.x, aUvRect.z, corner.x),
    mix(aUvRect.w, aUvRect.y, corner.y));
  vAlpha = visibility;
  vScreenMode = aParams.x;
}
`;

const GLYPH_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vAlpha;
varying float vScreenMode;

void main() {
  float a = texture2D(uAtlas, vUv).a;
  // Scene-mode labels are sampled at arbitrary magnification, so sharpen the
  // coverage ramp with screen-space derivatives (approximate SDF-style edge
  // thresholding). Screen-mode labels sample atlas texels 1:1 with screen
  // pixels; their coverage is already exact, and thresholding it would only
  // distort stroke weight -- use it untouched.
  float w = max(fwidth(a), 1e-4);
  float sharpened = clamp((a - 0.5) / min(w, 1.0) + 0.5, 0.0, 1.0);
  a = mix(sharpened, a, step(0.5, vScreenMode));
  a *= vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

const BACKGROUND_FRAGMENT_SHADER = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vScreenMode;

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
      uViewportPhys: { value: new THREE.Vector2(1, 1) },
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
            scalePxToUnit: atlasPxScale(entry.config, bucket),
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

  const lastDpr = React.useRef(labelDpr());

  useFrame(({ gl }) => {
    // A device-pixel-ratio change (browser zoom, moving the window between
    // monitors) changes every screen-mode label's rasterization size; re-key
    // all entries so they migrate to matching atlases and stay 1:1.
    const dpr = labelDpr();
    if (dpr !== lastDpr.current) {
      lastDpr.current = dpr;
      state.entries.forEach((entry) => {
        state.dirtyGroups.add(entry.groupKey);
        entry.groupKey = groupKey(entry.config);
        state.dirtyGroups.add(entry.groupKey);
      });
    }

    // Rebuild groups whose labels were added/removed/changed. Atlas growth
    // (stale UVs) is handled inside the rebuild.
    if (state.dirtyGroups.size > 0) rebuildDirtyGroups();

    // Screen-space label placement works in physical pixels.
    gl.getDrawingBufferSize(state.sharedUniforms.uViewportPhys.value);

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
