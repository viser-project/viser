// End-to-end Gaussian-splat render benchmark.
//
// This imports the REAL splat material/shader (createGaussianMeshProps) and the
// REAL WASM sorter, so what we measure is exactly what Viser ships. It renders
// synthetic splat clouds with a moving camera and reports, per frame:
//   - sortMs:  WASM depth sort (main-thread, blocking)
//   - drawMs:  renderer.render() + a readPixels GPU sync (so GPU work is timed)
//
// Driven by run_splat_bench.py (headed Chromium + ANGLE/Metal for a real GPU).

import * as THREE from "three";
import { createGaussianMeshProps } from "../src/Splatting/GaussianSplatsHelpers";
import MakeSorterModuleFactory from "../src/Splatting/WasmSorter/Sorter.mjs";
import SorterWasmUrl from "../src/Splatting/WasmSorter/Sorter.wasm?url";

// Float32 -> float16 bits (for packing covariances the same way Python does).
function f32ToF16(val: number): number {
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  f32[0] = val;
  const x = i32[0];
  const sign = (x >> 16) & 0x8000;
  let mantissa = x & 0x007fffff;
  let exp = (x >> 23) & 0xff;
  if (exp === 255) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mantissa = (mantissa | 0x00800000) >> (1 - exp);
    return sign | (mantissa >> 13);
  }
  return sign | (exp << 10) | (mantissa >> 13);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a synthetic packed splat buffer (8 uint32 / Gaussian), matching the
// layout produced by viser's add_gaussian_splats: [cx,cy,cz (f32), group (u32),
// cov0..5 (f16 x6 -> 3 u32), rgba (u32)].
function makeSplatBuffer(numGaussians: number, seed = 7) {
  const rng = mulberry32(seed);
  const buffer = new Uint32Array(numGaussians * 8);
  const f32 = new Float32Array(buffer.buffer);

  const numClusters = 10;
  const clusters: number[][] = [];
  for (let c = 0; c < numClusters; c++)
    clusters.push([(rng() - 0.5) * 5, (rng() - 0.5) * 5, (rng() - 0.5) * 5]);

  for (let i = 0; i < numGaussians; i++) {
    const c = clusters[i % numClusters];
    const cx = c[0] + (rng() - 0.5) * 1.6;
    const cy = c[1] + (rng() - 0.5) * 1.6;
    const cz = c[2] + (rng() - 0.5) * 1.6;
    f32[i * 8 + 0] = cx;
    f32[i * 8 + 1] = cy;
    f32[i * 8 + 2] = cz;
    buffer[i * 8 + 3] = 0; // single group

    // Anisotropic-ish covariance with a realistic small scale (~2-4cm).
    const s0 = 0.02 + rng() * 0.03;
    const s1 = 0.02 + rng() * 0.03;
    const s2 = 0.02 + rng() * 0.03;
    const triu = [s0 * s0, 0, 0, s1 * s1, 0, s2 * s2]; // diag covariance
    buffer[i * 8 + 4] = (f32ToF16(triu[0]) | (f32ToF16(triu[1]) << 16)) >>> 0;
    buffer[i * 8 + 5] = (f32ToF16(triu[2]) | (f32ToF16(triu[3]) << 16)) >>> 0;
    buffer[i * 8 + 6] = (f32ToF16(triu[4]) | (f32ToF16(triu[5]) << 16)) >>> 0;

    const r = (rng() * 255) & 0xff;
    const g = (rng() * 255) & 0xff;
    const b = (rng() * 255) & 0xff;
    const a = 200 + ((rng() * 55) & 0xff); // mostly opaque
    buffer[i * 8 + 7] =
      (r | (g << 8) | (b << 16) | ((a & 0xff) << 24)) >>> 0;
  }
  return buffer;
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    median: +at(0.5).toFixed(4),
    mean: +mean.toFixed(4),
    p10: +at(0.1).toFixed(4),
    p90: +at(0.9).toFixed(4),
  };
}

const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
const gl = renderer.getContext();

function gpuString() {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext
    ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
    : (gl.getParameter(gl.RENDERER) as string);
}

const syncPixel = new Uint8Array(4);
function forceGpuSync() {
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
}

// Sorter loaded once (main-thread, blocking sort -- mirrors blockingSort path).
const SorterModule = await fetch(SorterWasmUrl)
  .then((r) => r.arrayBuffer())
  .then((wasmBinary) => MakeSorterModuleFactory({ wasmBinary }));

const tmpT = new THREE.Matrix4();

async function benchSplats(
  numGaussians: number,
  width: number,
  height: number,
  iters: number,
  warmup: number,
) {
  renderer.setSize(width, height, false);

  const buffer = makeSplatBuffer(numGaussians);
  const groupIndices = new Uint32Array(numGaussians); // all group 0
  const maxTextureSize = renderer.capabilities.maxTextureSize;
  const meshProps = createGaussianMeshProps(buffer, 1, maxTextureSize);
  meshProps.material.uniforms.transitionInState.value = 1.0; // skip fade-in

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(meshProps.geometry, meshProps.material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);

  const sorter = new SorterModule.Sorter(buffer, groupIndices);
  const Tz = new Float32Array(4);
  const projCustom = new THREE.Matrix4();

  const sortSamples: number[] = [];
  const drawSamples: number[] = [];
  const total = iters + warmup;
  for (let it = 0; it < total; it++) {
    // Orbit the camera so every frame re-sorts (worst realistic case).
    const angle = (it / 30) * Math.PI * 2;
    const R = 7.0;
    camera.position.set(Math.sin(angle) * R, 1.5, Math.cos(angle) * R);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // Replicate updateCamera(): T_camera_group == T_camera_world (group 0 has
    // identity model transform).
    tmpT.copy(camera.matrixWorldInverse);
    const cm = tmpT.elements;
    Tz[0] = cm[2];
    Tz[1] = cm[6];
    Tz[2] = cm[10];
    Tz[3] = cm[14];
    const rowMajor = tmpT.transpose().elements;
    meshProps.rowMajorT_camera_groups.set(rowMajor.slice(0, 12), 0);
    meshProps.textureT_camera_groups.needsUpdate = true;

    const u = meshProps.material.uniforms;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.viewport.value = [width, height];
    // Custom projection matrix (matches updateCamera's makePerspective).
    const fovY = (camera.fov * Math.PI) / 180.0;
    const tanHalf = Math.tan(fovY / 2);
    const top = camera.near * tanHalf;
    const right = top * (width / height);
    projCustom.makePerspective(
      -right,
      right,
      top,
      -top,
      camera.near,
      camera.far,
      THREE.WebGLCoordinateSystem,
    );
    u.projectionMatrixCustom.value.copy(projCustom);

    // --- Sort (CPU) ---
    const t0 = performance.now();
    const sortedIndices = sorter.sort(Tz) as Uint32Array;
    meshProps.sortedIndexAttribute.set(sortedIndices);
    meshProps.sortedIndexAttribute.needsUpdate = true;
    const t1 = performance.now();

    // --- Draw (GPU) ---
    renderer.render(scene, camera);
    forceGpuSync();
    const t2 = performance.now();

    if (it >= warmup) {
      sortSamples.push(t1 - t0);
      drawSamples.push(t2 - t1);
    }
  }

  meshProps.geometry.dispose();
  meshProps.material.dispose();
  meshProps.textureBuffer.dispose();
  meshProps.textureT_camera_groups.dispose();

  return {
    n: numGaussians,
    width,
    height,
    sort: stats(sortSamples),
    draw: stats(drawSamples),
  };
}

// @ts-ignore - exposed for playwright.
window.benchSplats = async function () {
  const results: any = { gpu: gpuString(), cases: [] };
  const cases = [
    { n: 500_000, w: 1280, h: 720 },
    { n: 1_000_000, w: 1280, h: 720 },
    { n: 2_000_000, w: 1280, h: 720 },
    { n: 1_000_000, w: 1920, h: 1080 },
  ];
  for (const c of cases) {
    results.cases.push(await benchSplats(c.n, c.w, c.h, 90, 20));
    await new Promise((r) => setTimeout(r, 20));
  }
  return results;
};
// @ts-ignore
window.__ready = true;
