/** GPU-instanced 3D label renderer.
 *
 * Replaces the previous troika-three-text pipeline. Text is rasterized with
 * the system font stack into signed-distance-field glyph atlases
 * (GlyphAtlas.ts / sdf.ts); every label renders as one background quad plus
 * one instanced quad per grapheme cluster. Billboarding and screen-space
 * scaling run in the vertex shader, so the per-frame JS work is just writing
 * each label's world position and visibility into a small data texture.
 *
 * The fragment shader re-thresholds the bilinear-sampled field over a ~1
 * screen px ramp (troika's formulation), which keeps edges crisp at any
 * effective scale: adaptive DPR (App.tsx lowers the renderer's pixel ratio
 * under load), orthographic zoom, and scene-space magnification all resample
 * the atlas, and a distance field is the representation that survives that.
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
import { parseAnchor, segmentGraphemes } from "./labelLayout";
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

/** Screen-mode labels are calibrated to a 12 CSS px em at fontScreenScale 1:
 * 0.3 * scale world units at 10 units depth in an 800 px-tall viewport. */
const SCREEN_EM_CSS_PX = 12;

/** Base font size in world units, matching the previous implementation:
 * "screen" mode is calibrated at 0.3 * scale at 10 units depth. */
function baseFontSize(config: LabelConfig): number {
  return config.fontSizeMode === "screen"
    ? 0.3 * config.fontScreenScale
    : config.fontSceneHeight;
}

/** Device pixel ratio used for label rasterization, capped so ultra-dense
 * displays don't inflate atlas memory. */
function labelDpr(): number {
  return Math.min(
    typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1,
    3,
  );
}

/** Atlas font-pixel bucket for a label, from data we already have.
 *
 * Screen-mode labels rasterize at their nominal on-screen pixel size (their
 * em size is constant and known from the config), so the field is sampled
 * near 1:1 in the common case; the SDF ramp keeps edges crisp when adaptive
 * DPR or ortho zoom rescales it. One atlas serves each distinct
 * (fontScreenScale, devicePixelRatio) in the scene -- one or two in
 * practice. Scene-mode labels have no intrinsic pixel size and use a
 * middle-of-the-road bucket. */
function fontPxBucket(config: LabelConfig): number {
  const nominalPx =
    config.fontSizeMode === "screen"
      ? SCREEN_EM_CSS_PX * config.fontScreenScale * labelDpr()
      : 64;
  // Quantize to multiples of 4: sampling an SDF a few percent off its native
  // resolution is invisible after the shader re-threshold, and coarser
  // buckets keep an animated fontScreenScale from minting an atlas per pixel
  // size (unused atlases are also evicted, see rebuildDirtyGroups).
  return Math.min(256, Math.max(8, Math.round(nominalPx / 4) * 4));
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
uniform sampler2D uAtlas;     // Single-channel SDF (see sdf.ts encodeSdf).
uniform vec2 uAtlasSize;      // Atlas dimensions, px.
uniform float uSdfRadius;     // SDF encoding radius, atlas px.
varying vec2 vUv;
varying float vAlpha;

void main() {
  // Signed distance to the glyph outline in atlas px, positive inside.
  float distPx = (texture2D(uAtlas, vUv).r - 0.5) * 2.0 * uSdfRadius;
  // Re-threshold over a ramp spanning ~1 screen px: fwidth of the atlas-px
  // sample position is the atlas-px footprint of one screen px (troika's
  // formulation). This is what keeps edges crisp at any sampling scale.
  // Under strong minification the unclamped ramp would span past the quad's
  // margin, where the field saturates -- every quad would fill with uniform
  // partial alpha (dark smudges instead of distant text). Clamping to half
  // the encoding radius (~ the quad margin) lets far text fade out cleanly.
  float aa = min(
    0.5 * length(fwidth(vUv * uAtlasSize)), 0.5 * uSdfRadius);
  float a = smoothstep(-aa, aa, distPx) * vAlpha;
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

/** Per-frame budget for main-thread glyph work (LabelRenderer never blocks a
 * frame on text). Distance transforms run in the shared SDF worker, so the
 * budget covers only rasterization + pixel readback (~0.2 ms per glyph); a
 * rebuild requests missing glyphs until the budget runs out, and groups
 * whose glyph pixels haven't landed yet are deferred to following frames --
 * their previous geometry keeps rendering meanwhile, so a label with many
 * new glyphs streams in over a few fully-interactive frames instead of
 * dropping one. Leftover budget pre-warms printable ASCII in small atlases,
 * so later English text additions are pure cache hits. */
const GLYPH_BUDGET_MS = 3;

/** Only pre-warm ASCII in atlases at or below this bucket: larger cells would
 * fill (and grow) an atlas for glyphs that may never be used. */
const WARM_MAX_FONT_PX = 32;
const ASCII_FIRST = 33; // "!" -- skip space, whitespace has no quad.
const ASCII_LAST = 126; // "~".

/** Draw order (see ReversedDepthSort.ts and issue #767): backgrounds below
 * Gaussian splats (10000, GaussianSplats.tsx), glyphs strictly above them --
 * labels are annotations, so their text always composites over splats. */
const LABEL_BACKGROUND_RENDER_ORDER = 9_999;
const LABEL_TEXT_RENDER_ORDER = 10_001;

interface LabelEntry {
  config: LabelConfig;
  labelIndex: number;
  parentName: string;
  /** Rebuild group this entry currently renders in (see groupKey). */
  groupKey: string;
  /** Set while migrating to a different group (bucket or depth-test change):
   * the entry keeps rendering in groupKey until the target group's glyphs
   * are ready, then rebuildDirtyGroups flips it over -- so migrations never
   * blank the label. */
  targetGroupKey?: string;
}

/** Labels are rebuilt in groups of one glyph mesh each: a (depth test, atlas
 * bucket) pair. Tracking dirtiness per group keeps a single label update from
 * re-laying-out every label in the scene. */
function makeGroupKey(depthTest: boolean, bucket: number): string {
  return `${depthTest}-${bucket}`;
}

function groupKey(config: LabelConfig): string {
  return makeGroupKey(config.depthTest, fontPxBucket(config));
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
      /** Per-bucket progress of background ASCII warming; reset when the
       * atlas's generation changes (recycle invalidates warmed cells). */
      warmCursors: new Map<number, { generation: number; next: number }>(),
      /** Per-group count of deferrals that coincided with a full-atlas
       * recycle: a group whose glyphs cannot fit even a maximum-size atlas
       * would otherwise re-defer forever (see rebuildDirtyGroups). */
      groupRecycleStrikes: new Map<string, number>(),
      /** When each bucket last had labels, for grace-period eviction. */
      bucketLastActive: new Map<number, number>(),
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
      const key = makeGroupKey(depthTest, fontPx);
      let mesh = state.glyphMeshes.get(key);
      if (!mesh) {
        const atlas = getAtlas(fontPx);
        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: GLYPH_FRAGMENT_SHADER,
          uniforms: {
            ...state.sharedUniforms,
            uAtlas: { value: atlas.texture },
            uAtlasSize: { value: new THREE.Vector2(atlas.size, atlas.size) },
            uSdfRadius: { value: atlas.sdfRadius },
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

  // Rebuild the instance buffers of every dirty group whose glyphs can be
  // rasterized before `deadline`; groups with more missing glyphs than the
  // budget allows are deferred to later frames (their previous geometry keeps
  // rendering meanwhile), so text streams in without ever blocking a frame.
  const rebuildDirtyGroups = React.useCallback(
    (deadline: number) => {
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
      // Groups deferred for budget (not overflow); re-marked dirty at the end
      // so they don't count as retry attempts.
      const deferredGroups = new Set<string>();
      // At least one glyph always rasterizes per call, so deferred groups make
      // progress even when a single glyph exceeds the budget.
      let rasterized = 0;
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
          [...state.atlases].map(([bucket, atlas]) => [
            bucket,
            atlas.generation,
          ]),
        );

        for (const key of groups) {
          if (deferredGroups.has(key)) continue;
          const { depthTest, bucket } = parseGroupKey(key);
          // Current members, plus entries migrating in (still rendered by
          // their old group; they flip over once this group is ready).
          const members: LabelEntry[] = [];
          const incoming: LabelEntry[] = [];
          state.entries.forEach((entry) => {
            if (entry.groupKey === key) members.push(entry);
            else if (entry.targetGroupKey === key) incoming.push(entry);
          });
          const atlas = getAtlas(bucket);

          // Rasterize this group's missing glyphs within the frame budget;
          // defer the group if the budget runs out first.
          const recyclesBefore = atlas.recycles;
          let ready = true;
          prefetch: for (const entry of [...members, ...incoming]) {
            for (const cluster of segmentGraphemes(entry.config.text)) {
              if (cluster.trim() === "") continue;
              if (!atlas.has(cluster)) {
                if (rasterized > 0 && performance.now() > deadline) {
                  ready = false;
                  break prefetch;
                }
                atlas.getCell(cluster);
                rasterized++;
              }
              // The cell's pixels may still be in the SDF worker: keep
              // requesting the rest so transforms run in parallel, but
              // defer the group until every glyph can actually draw.
              if (!atlas.cellReady(cluster)) ready = false;
            }
          }
          if (!ready) {
            // A recycle during prefetch means this group's glyph set may not
            // fit even a maximum-size atlas; after repeated recycles, give
            // up on completeness and render with the glyphs that fit, so it
            // doesn't burn the budget (and wipe the atlas) forever.
            const strikes =
              (state.groupRecycleStrikes.get(key) ?? 0) +
              (atlas.recycles > recyclesBefore ? 1 : 0);
            if (strikes < 2) {
              state.groupRecycleStrikes.set(key, strikes);
              deferredGroups.add(key);
              continue;
            }
            console.warn(
              "[LabelRenderer] Glyph set exceeds atlas capacity; rendering with the glyphs that fit.",
            );
          }
          state.groupRecycleStrikes.delete(key);

          // The group is (as-)ready(-as-it-gets): migrating entries now
          // render here, and their old groups drop them.
          for (const entry of incoming) {
            const oldKey = entry.groupKey;
            entry.groupKey = key;
            entry.targetGroupKey = undefined;
            members.push(entry);
            state.dirtyGroups.add(oldKey);
          }

          const configs: LabelEntryConfig[] = members.map((entry) => ({
            text: entry.config.text,
            sizeMode: entry.config.fontSizeMode,
            scalePxToUnit: baseFontSize(entry.config) / bucket,
            ...parseAnchor(entry.config.anchor),
            labelIndex: entry.labelIndex,
          }));

          touchedDepthTests.add(depthTest);
          const buffers = buildInstanceBuffers(
            configs,
            (text) => atlas.measure(text),
            // In the capacity-exceeded fallback, skip glyphs that aren't
            // resident so building can't trigger another recycle.
            (cluster) =>
              ready || atlas.has(cluster) ? atlas.getCell(cluster) : null,
            { ascent: atlas.ascent, descent: atlas.descent },
          );
          state.groupBuffers.set(key, buffers);
          const mesh = getGlyphMesh(depthTest, bucket);
          swapGeometry(
            mesh,
            buffers.glyphLabelIndex,
            buffers.glyphRect,
            buffers.glyphParams,
            buffers.glyphUv,
            buffers.glyphCount,
          );
          // Atlas growth swaps in a new, larger texture; refresh the atlas
          // uniforms so the material tracks it.
          const material = mesh.material as THREE.ShaderMaterial;
          material.uniforms.uAtlas.value = atlas.texture;
          material.uniforms.uAtlasSize.value.set(atlas.size, atlas.size);
          material.uniforms.uSdfRadius.value = atlas.sdfRadius;
        }

        state.atlases.forEach((atlas, bucket) => {
          if (generationsBefore.get(bucket) === atlas.generation) return;
          for (const key of state.groupBuffers.keys()) {
            if (parseGroupKey(key).bucket === bucket)
              state.dirtyGroups.add(key);
          }
        });
      }

      // Budget-deferred groups continue next frame.
      deferredGroups.forEach((key) => state.dirtyGroups.add(key));

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

      // Evict atlases (and their meshes / cached buffers) for buckets no
      // label uses anymore: bucket migrations -- DPR changes, an animated
      // fontScreenScale -- would otherwise accumulate ~1 MB atlases, GPU
      // textures, and ASCII warm work without bound. A grace period keeps an
      // oscillating scale (or a scene clear-and-reload) from thrashing full
      // dispose/re-rasterize cycles.
      const EVICT_GRACE_MS = 5_000;
      const now = performance.now();
      const activeBuckets = new Set<number>();
      state.entries.forEach((entry) => {
        activeBuckets.add(parseGroupKey(entry.groupKey).bucket);
        if (entry.targetGroupKey) {
          activeBuckets.add(parseGroupKey(entry.targetGroupKey).bucket);
        }
      });
      activeBuckets.forEach((bucket) =>
        state.bucketLastActive.set(bucket, now),
      );
      state.atlases.forEach((atlas, bucket) => {
        if (activeBuckets.has(bucket)) return;
        const lastActive = state.bucketLastActive.get(bucket) ?? now;
        if (now - lastActive < EVICT_GRACE_MS) return;
        atlas.dispose();
        state.atlases.delete(bucket);
        state.warmCursors.delete(bucket);
        state.bucketLastActive.delete(bucket);
        for (const depthTest of [true, false]) {
          const key = makeGroupKey(depthTest, bucket);
          const mesh = state.glyphMeshes.get(key);
          if (mesh) {
            state.group.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
            state.glyphMeshes.delete(key);
          }
          state.groupBuffers.delete(key);
          state.dirtyGroups.delete(key);
          state.groupRecycleStrikes.delete(key);
        }
      });
    },
    [state, getAtlas, getGlyphMesh],
  );

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
          entry.config = newConfig;
          entry.parentName = newConfig.name.split("/").slice(0, -1).join("/");
          const newKey = groupKey(newConfig);
          if (newKey === entry.groupKey) {
            // Same group: rebuild in place (an aborted migration, if any,
            // just dissolves -- the entry never left this group).
            entry.targetGroupKey = undefined;
            state.dirtyGroups.add(entry.groupKey);
          } else {
            // Group changed (bucket or depth test): migrate transactionally.
            // The entry keeps rendering in its old group -- rebuilt so text
            // changes still show immediately -- until the target group's
            // glyphs are ready (see rebuildDirtyGroups).
            entry.targetGroupKey = newKey;
            state.dirtyGroups.add(entry.groupKey);
            state.dirtyGroups.add(newKey);
          }
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
          if (entry.targetGroupKey) state.dirtyGroups.add(entry.targetGroupKey);
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

  // Spend leftover frame budget rasterizing printable ASCII into small
  // atlases that are already in use, so future English text additions hit
  // the cache instead of paying first-use rasterization.
  const warmAscii = React.useCallback(
    (deadline: number) => {
      state.atlases.forEach((atlas, bucket) => {
        if (bucket > WARM_MAX_FONT_PX) return;
        let cursor = state.warmCursors.get(bucket);
        if (!cursor || cursor.generation !== atlas.generation) {
          cursor = { generation: atlas.generation, next: ASCII_FIRST };
        }
        while (cursor.next <= ASCII_LAST && performance.now() < deadline) {
          atlas.getCell(String.fromCharCode(cursor.next));
          cursor.next++;
          if (atlas.generation !== cursor.generation) {
            // Warming grew the atlas: existing UVs are stale, rebuild the
            // bucket's groups. (Not expected at warmable sizes, but safe.)
            for (const key of state.groupBuffers.keys()) {
              if (parseGroupKey(key).bucket === bucket) {
                state.dirtyGroups.add(key);
              }
            }
            cursor.generation = atlas.generation;
          }
        }
        state.warmCursors.set(bucket, cursor);
      });
    },
    [state],
  );

  useFrame(({ camera, size }) => {
    // A device-pixel-ratio change (browser zoom, moving the window between
    // monitors) changes every screen-mode label's ideal rasterization size;
    // re-key all entries so they migrate to matching atlases.
    const dpr = labelDpr();
    if (dpr !== lastDpr.current) {
      lastDpr.current = dpr;
      state.entries.forEach((entry) => {
        // Migrate transactionally, like update(): entries keep rendering in
        // their old group until the re-keyed group's glyphs are ready.
        const newKey = groupKey(entry.config);
        entry.targetGroupKey = newKey === entry.groupKey ? undefined : newKey;
        if (entry.targetGroupKey) state.dirtyGroups.add(entry.targetGroupKey);
      });
    }

    // Rebuild groups whose labels were added/removed/changed, within this
    // frame's glyph rasterization budget. Atlas growth (stale UVs) is
    // handled inside the rebuild; budget-deferred groups stay dirty and
    // continue next frame.
    const deadline = performance.now() + GLYPH_BUDGET_MS;
    if (state.dirtyGroups.size > 0) rebuildDirtyGroups(deadline);
    else warmAscii(deadline);

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
