// Shared benchmark + correctness harness for the splat sorter WASM module.
//
// This loads a compiled Sorter.mjs (production or a candidate build), feeds it
// synthetic Gaussian scenes, and times sort() with a moving camera. It also
// verifies that the returned order is a valid back-to-front permutation, so we
// never trade correctness for speed without noticing.

// Deterministic PRNG so runs are reproducible across builds.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a synthetic scene: `numGaussians` centers spread across a few clusters
// in a volume, assigned round-robin to `numGroups` groups. We only need the
// center xyz (floats 0..2 of each 8-uint32 record) for sorting; the rest is
// covariance/color which the sorter ignores.
export function makeScene(numGaussians, numGroups, seed = 12345) {
  const rng = mulberry32(seed);
  const buffer = new Uint32Array(numGaussians * 8);
  const floats = new Float32Array(buffer.buffer);
  const groupIndices = new Uint32Array(numGaussians);

  // A handful of cluster centers to mimic real captures (not uniform noise).
  const numClusters = 8;
  const clusters = [];
  for (let c = 0; c < numClusters; c++) {
    clusters.push([
      (rng() - 0.5) * 6.0,
      (rng() - 0.5) * 6.0,
      (rng() - 0.5) * 6.0,
    ]);
  }

  for (let i = 0; i < numGaussians; i++) {
    const c = clusters[i % numClusters];
    floats[i * 8 + 0] = c[0] + (rng() - 0.5) * 2.0;
    floats[i * 8 + 1] = c[1] + (rng() - 0.5) * 2.0;
    floats[i * 8 + 2] = c[2] + (rng() - 0.5) * 2.0;
    // Viser merges splat objects as contiguous blocks (group 0's Gaussians,
    // then group 1's, ...) -- see mergeGaussianGroups. Mirror that layout.
    groupIndices[i] = Math.min(
      numGroups - 1,
      Math.floor((i * numGroups) / numGaussians),
    );
  }
  return { buffer, floats, groupIndices };
}

// Camera depth-rows for each group. Tz_camera_group is row 2 (the z row) of the
// 3x4 world->camera transform for that group: [r20, r21, r22, r23], so that
// cam_z = dot([r20,r21,r22,r23], [x,y,z,1]). We orbit the camera around the
// origin so each frame produces a genuinely different sort.
export function makeCameraTz(numGroups, angle) {
  const tz = new Float32Array(numGroups * 4);
  // Camera orbits in the xz-plane at radius R, looking at the origin.
  const R = 8.0;
  const eye = [Math.sin(angle) * R, 1.5, Math.cos(angle) * R];
  // Forward = normalize(target - eye), target = origin.
  let fx = -eye[0],
    fy = -eye[1],
    fz = -eye[2];
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // The camera-space z row is -forward (OpenGL: camera looks down -z), and the
  // translation component is -dot(zrow_dir, eye).
  const zx = -fx,
    zy = -fy,
    zz = -fz;
  const zt = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  for (let g = 0; g < numGroups; g++) {
    // Give each group a tiny per-group offset so multi-group paths are exercised.
    tz[g * 4 + 0] = zx;
    tz[g * 4 + 1] = zy;
    tz[g * 4 + 2] = zz;
    tz[g * 4 + 3] = zt + g * 0.01;
  }
  return tz;
}

// Verify the sorted order is (a) a permutation of [0, N) and (b) monotonically
// non-decreasing in cam_z (back-to-front), allowing for 16-bit quantization
// ties. Returns null on success or an error string.
export function verifyOrder(sorted, scene, tz) {
  const N = scene.floats.length / 8;
  if (sorted.length !== N) return `length ${sorted.length} != ${N}`;
  const seen = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const idx = sorted[i];
    if (idx >= N || seen[idx]) return `not a permutation at ${i} (idx=${idx})`;
    seen[idx] = 1;
  }
  // Recompute cam_z for each and check monotonicity within a quantization
  // tolerance (range / 65536, times a small slack for trunc rounding).
  let minZ = Infinity,
    maxZ = -Infinity;
  const camZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const g = scene.groupIndices[i];
    const z =
      tz[g * 4 + 0] * scene.floats[i * 8 + 0] +
      tz[g * 4 + 1] * scene.floats[i * 8 + 1] +
      tz[g * 4 + 2] * scene.floats[i * 8 + 2] +
      tz[g * 4 + 3];
    camZ[i] = z;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const tol = ((maxZ - minZ) / 65536) * 4 + 1e-4;
  for (let i = 1; i < N; i++) {
    if (camZ[sorted[i]] < camZ[sorted[i - 1]] - tol) {
      return `non-monotonic at ${i}: ${camZ[sorted[i - 1]]} -> ${camZ[sorted[i]]} (tol ${tol})`;
    }
  }
  return null;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    median: +at(0.5).toFixed(4),
    mean: +mean.toFixed(4),
    p10: +at(0.1).toFixed(4),
    p90: +at(0.9).toFixed(4),
  };
}

// Time sort() over many frames of a moving camera. We include the embind
// marshaling of Tz plus a checksum read of the result, which is exactly what
// the worker pays each frame (minus the .slice copy, measured separately).
export function benchSort(Sorter, scene, numGroups, iters, warmup) {
  const sorter = new Sorter(scene.buffer, scene.groupIndices);
  const samples = [];
  let checksum = 0;
  const total = iters + warmup;
  for (let it = 0; it < total; it++) {
    const angle = (it / 40) * Math.PI * 2;
    const tz = makeCameraTz(numGroups, angle);
    const t0 = performance.now();
    const out = sorter.sort(tz);
    // Touch the result so the call can't be optimized away; mirrors the worker
    // consuming sortedIndices.
    checksum += out[0] + out[(out.length >> 1) | 0] + out[out.length - 1];
    const dt = performance.now() - t0;
    if (it >= warmup) samples.push(dt);
  }
  return { ...stats(samples), checksum };
}

export async function loadSorter(mjsPath) {
  const Make = (await import(mjsPath)).default;
  const M = await Make();
  return M.Sorter;
}
