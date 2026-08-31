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
  // Round up to a power of two: the SDF re-threshold makes off-native
  // sampling invisible, and bounding the bucket set to {8..256} bounds the
  // number of atlases the renderer can ever hold -- no eviction machinery.
  const clamped = Math.min(256, Math.max(8, nominalPx));
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
  // The floor guards fwidth quantizing to exactly 0 at extreme
  // magnification, where smoothstep(edge0 == edge1) is undefined.
  float aa = clamp(
    0.5 * length(fwidth(vUv * uAtlasSize)), 1e-4, 0.5 * uSdfRadius);
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

/** Per-frame budget for glyph rasterization (LabelRenderer never blocks a
 * frame on text): a rebuild rasterizes missing glyphs (~1.4 ms each at the
 * scene bucket) until the budget runs out, then defers the unfinished
 * groups to following frames -- their previous geometry keeps rendering
 * meanwhile, so a label with many new glyphs streams in over interactive
 * frames instead of dropping one. 5 ms matches common cooperative-slicing
 * practice, stays under a third of a 60 Hz frame, and keeps the deferred
 * window (the subtlest state in this file) short. */
const GLYPH_BUDGET_MS = 5;

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
  /** Lazily-computed unique non-whitespace grapheme clusters of
   * config.text (invalidated on update): the prefetch re-scans deferred
   * groups every frame, and re-segmenting/re-filtering each time is
   * avoidable garbage. */
  clusters?: string[];
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
      /** Disposed labels' indices, releasable only after their group has
       * rebuilt: a budget-deferred group still renders the old quads bound
       * to the index, and reusing it early would billboard the old label's
       * text at the new label's position. */
      pendingFreeIndices: [] as { index: number; groupKey: string }[],
      nextIndex: 0,
      /** Groups whose instance buffers need rebuilding. */
      dirtyGroups: new Set<string>(),
      /** Per-group count of deferrals that coincided with a full-atlas
       * recycle: a group whose glyphs cannot fit even a maximum-size atlas
       * would otherwise re-defer forever (see rebuildDirtyGroups). */
      groupRecycleStrikes: new Map<string, number>(),
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

      // Atlas growth swaps in a new texture object; every material of the
      // bucket must re-point at it (including deferred groups' materials --
      // binding a disposed texture makes three re-allocate GL storage for it,
      // which then leaks when the uniform finally swaps).
      const refreshAtlasUniforms = (mesh: THREE.Mesh, atlas: GlyphAtlas) => {
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.uAtlas.value = atlas.texture;
        material.uniforms.uAtlasSize.value.set(atlas.size, atlas.size);
        material.uniforms.uSdfRadius.value = atlas.sdfRadius;
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
      let rasterizedAny = false;
      for (let attempt = 0; state.dirtyGroups.size > 0; attempt++) {
        if (attempt >= MAX_ATTEMPTS) {
          console.warn(
            "[LabelRenderer] Glyph atlas kept overflowing; some labels may render incorrectly.",
          );
          state.dirtyGroups.clear();
          state.pendingFreeIndices.forEach((entry) =>
            state.freeIndices.push(entry.index),
          );
          state.pendingFreeIndices = [];
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

        // One membership pass per attempt (instead of one full-entry scan
        // per group, which is quadratic while groups stream over frames),
        // indexing only the dirty groups: members render in the group now;
        // incoming entries are migrating in and flip once it is ready.
        const dirtySet = new Set(groups);
        const membership = new Map<
          string,
          { members: LabelEntry[]; incoming: LabelEntry[] }
        >();
        const membershipOf = (key: string) => {
          let record = membership.get(key);
          if (!record) {
            record = { members: [], incoming: [] };
            membership.set(key, record);
          }
          return record;
        };
        state.entries.forEach((entry) => {
          if (dirtySet.has(entry.groupKey)) {
            membershipOf(entry.groupKey).members.push(entry);
          }
          if (
            entry.targetGroupKey !== undefined &&
            dirtySet.has(entry.targetGroupKey)
          ) {
            membershipOf(entry.targetGroupKey).incoming.push(entry);
          }
        });

        for (const key of groups) {
          if (deferredGroups.has(key)) continue;
          const { depthTest, bucket } = parseGroupKey(key);
          // entry.groupKey is authoritative: an entry may have flipped out
          // of this group while an earlier group in this attempt built.
          const record = membershipOf(key);
          const members = record.members.filter((e) => e.groupKey === key);
          const incoming = record.incoming;
          const atlas = getAtlas(bucket);

          // Rasterize this group's missing glyphs within the frame budget;
          // defer the group if the budget runs out first. A group whose
          // strikes are capped (its glyph set exceeded atlas capacity, see
          // below) stops rasterizing entirely and renders with the glyphs
          // that fit, until a register/update/dispose gives it a new chance.
          let ready = false;
          if ((state.groupRecycleStrikes.get(key) ?? 0) < 2) {
            const recyclesBefore = atlas.recycles;
            const generationBefore = atlas.generation;
            ready = true;
            prefetch: for (const entry of [...members, ...incoming]) {
              entry.clusters ??= [
                ...new Set(
                  segmentGraphemes(entry.config.text).filter(
                    (cluster) => cluster.trim() !== "",
                  ),
                ),
              ];
              for (const cluster of entry.clusters) {
                if (atlas.has(cluster)) continue;
                if (rasterizedAny && performance.now() > deadline) {
                  ready = false;
                  break prefetch;
                }
                atlas.getCell(cluster);
                rasterizedAny = true;
              }
            }
            // Atlas growth during the prefetch wiped cells checked earlier
            // in this very pass; a "ready" verdict from before the growth
            // would let the build below re-rasterize them with no deadline.
            if (atlas.generation !== generationBefore) ready = false;

            if (ready) {
              state.groupRecycleStrikes.delete(key);
            } else {
              // A recycle during prefetch means this group's glyph set may
              // not fit even a maximum-size atlas; after repeated recycles,
              // cap the group so it stops burning the budget (and wiping
              // the atlas) forever.
              const strikes =
                (state.groupRecycleStrikes.get(key) ?? 0) +
                (atlas.recycles > recyclesBefore ? 1 : 0);
              state.groupRecycleStrikes.set(key, strikes);
              if (strikes < 2) {
                deferredGroups.add(key);
                continue;
              }
              console.warn(
                "[LabelRenderer] Glyph set exceeds atlas capacity; rendering with the glyphs that fit.",
              );
            }
          }

          // The group is (as-)ready(-as-it-gets): migrating entries now
          // render here, and their old groups drop them.
          for (const entry of incoming) {
            state.dirtyGroups.add(entry.groupKey);
            entry.groupKey = key;
            entry.targetGroupKey = undefined;
            members.push(entry);
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
          swapGeometry(
            getGlyphMesh(depthTest, bucket),
            buffers.glyphLabelIndex,
            buffers.glyphRect,
            buffers.glyphParams,
            buffers.glyphUv,
            buffers.glyphCount,
          );
          // (Atlas-texture uniforms need no refresh here: any texture swap
          // bumps the generation, and the end-of-attempt sweep re-points
          // every mesh of the affected bucket.)
          // The old geometry (which may have referenced disposed labels'
          // indices) is gone; those indices are safe to reuse now.
          state.pendingFreeIndices = state.pendingFreeIndices.filter((p) => {
            if (p.groupKey !== key) return true;
            state.freeIndices.push(p.index);
            return false;
          });
        }

        state.atlases.forEach((atlas, bucket) => {
          if (generationsBefore.get(bucket) === atlas.generation) return;
          for (const depthTest of [true, false]) {
            const mesh = state.glyphMeshes.get(makeGroupKey(depthTest, bucket));
            if (mesh) refreshAtlasUniforms(mesh, atlas);
          }
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
    },
    [state, getAtlas, getGlyphMesh],
  );

  // A membership change -- label added, removed, retargeted, or its text
  // changed -- rebuilds the group AND clears its capacity cap: the glyph set
  // is different now, so a group previously capped as "exceeds atlas
  // capacity" gets a fresh chance. Rebuild-internal dirty marks (deferral,
  // generation invalidation, a migration's old key) use dirtyGroups.add
  // directly: those must not reset strikes.
  const markGroupChanged = React.useCallback(
    (key: string) => {
      state.dirtyGroups.add(key);
      state.groupRecycleStrikes.delete(key);
    },
    [state],
  );

  // Shared migration protocol for update() and DPR re-keying: same group ->
  // dissolve any pending migration (the entry never left; the caller marks
  // the group if its content changed); different group -> migrate
  // transactionally (the entry keeps rendering in its old group until the
  // target group's glyphs are ready; rebuildDirtyGroups flips it).
  const retargetEntry = React.useCallback(
    (entry: LabelEntry, newKey: string) => {
      if (newKey === entry.groupKey) {
        entry.targetGroupKey = undefined;
      } else {
        entry.targetGroupKey = newKey;
        markGroupChanged(newKey);
      }
    },
    [markGroupChanged],
  );

  const register = React.useCallback(
    (config: LabelConfig): LabelHandle => {
      let labelIndex: number;
      if (state.freeIndices.length > 0) {
        labelIndex = state.freeIndices.pop()!;
      } else if (state.nextIndex < MAX_LABELS) {
        labelIndex = state.nextIndex++;
      } else if (state.pendingFreeIndices.length > 0) {
        // Last resort: a mass replace (dispose + register of thousands of
        // labels in one commit) can exhaust fresh indices while disposed
        // ones are still cooling down. Reusing a cooling index risks one
        // frame of the old label's quads at the new position -- better than
        // permanently dropping the label.
        labelIndex = state.pendingFreeIndices.shift()!.index;
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
      markGroupChanged(entryGroup);

      return {
        update: (newConfig: LabelConfig) => {
          const entry = state.entries.get(key);
          if (!entry) return;
          entry.config = newConfig;
          entry.clusters = undefined;
          entry.parentName = newConfig.name.split("/").slice(0, -1).join("/");
          // The current group re-renders immediately (the text may have
          // changed); retargetEntry additionally starts a transactional
          // migration if the bucket/depth-test changed.
          markGroupChanged(entry.groupKey);
          retargetEntry(entry, groupKey(newConfig));
        },
        dispose: () => {
          const entry = state.entries.get(key);
          if (!entry) return;
          state.entries.delete(key);
          state.pendingFreeIndices.push({
            index: entry.labelIndex,
            groupKey: entry.groupKey,
          });
          // Zero the slot so a stale texel can't flash before rebuild.
          state.labelData.fill(
            0,
            entry.labelIndex * 4,
            entry.labelIndex * 4 + 4,
          );
          markGroupChanged(entry.groupKey);
          if (entry.targetGroupKey) markGroupChanged(entry.targetGroupKey);
        },
      };
    },
    [state, markGroupChanged, retargetEntry],
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

  useFrame(({ camera, size }) => {
    // A device-pixel-ratio change (browser zoom, moving the window between
    // monitors) changes every screen-mode label's ideal rasterization size;
    // re-key all entries so they migrate to matching atlases.
    const dpr = labelDpr();
    if (dpr !== lastDpr.current) {
      lastDpr.current = dpr;
      state.entries.forEach((entry) => {
        retargetEntry(entry, groupKey(entry.config));
      });
    }

    // Rebuild groups whose labels were added/removed/changed, within this
    // frame's glyph rasterization budget. Atlas growth (stale UVs) is
    // handled inside the rebuild; budget-deferred groups stay dirty and
    // continue next frame.
    if (state.dirtyGroups.size > 0) {
      rebuildDirtyGroups(performance.now() + GLYPH_BUDGET_MS);
    }

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
