// Benchmark runner for the splat sorter.
//
// Usage:
//   node bench_sorter.mjs [moduleA.mjs] [moduleB.mjs]
//
// With no args it benchmarks the production ./Sorter.mjs. With two paths it
// benchmarks both and prints a speedup comparison (A = baseline, B = candidate).
// Correctness is verified for every (scale, groups) cell before timing.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeScene,
  makeCameraTz,
  verifyOrder,
  benchSort,
  loadSorter,
} from "./bench_lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCALES = [
  { n: 500_000, iters: 120, warmup: 20 },
  { n: 1_000_000, iters: 80, warmup: 15 },
  { n: 2_000_000, iters: 50, warmup: 10 },
  { n: 4_000_000, iters: 30, warmup: 8 },
];
const GROUP_COUNTS = [1, 4];

function toAbs(p) {
  if (!p) return null;
  return p.startsWith("/") ? p : path.resolve(process.cwd(), p);
}

const argA = toAbs(process.argv[2]) ?? path.join(__dirname, "Sorter.mjs");
const argB = toAbs(process.argv[3]);

function verifyCell(Sorter, n, groups) {
  const scene = makeScene(n, groups);
  const sorter = new Sorter(scene.buffer, scene.groupIndices);
  // Check a couple of distinct camera angles.
  for (const angle of [0.0, 1.3, 3.7]) {
    const tz = makeCameraTz(groups, angle);
    const out = sorter.sort(tz);
    const err = verifyOrder(out, scene, tz);
    if (err) return err;
  }
  return null;
}

async function runSuite(label, mjsPath) {
  const Sorter = await loadSorter(mjsPath);
  const rows = [];
  for (const { n, iters, warmup } of SCALES) {
    for (const groups of GROUP_COUNTS) {
      const err = verifyCell(Sorter, n, groups);
      if (err) {
        console.error(`  [FAIL] ${label} n=${n} g=${groups}: ${err}`);
        rows.push({ n, groups, median: NaN, mgps: NaN, bad: true });
        continue;
      }
      const scene = makeScene(n, groups);
      const r = benchSort(Sorter, scene, groups, iters, warmup);
      const mgps = n / (r.median / 1000) / 1e6; // million gaussians / sec
      rows.push({ n, groups, ...r, mgps });
      console.log(
        `  ${label}  n=${(n / 1e6).toFixed(2)}M g=${groups}  ` +
          `median=${r.median.toFixed(3)}ms  p10=${r.p10.toFixed(3)}  p90=${r.p90.toFixed(3)}  ` +
          `${mgps.toFixed(1)} Mgauss/s`,
      );
    }
  }
  return rows;
}

console.log(`\n=== Sorter benchmark ===`);
console.log(`A (baseline):  ${argA}`);
if (argB) console.log(`B (candidate): ${argB}`);
console.log("");

const rowsA = await runSuite("A", argA);

if (argB) {
  console.log("");
  const rowsB = await runSuite("B", argB);
  console.log(`\n=== Speedup (B vs A), median sort time ===`);
  for (let i = 0; i < rowsA.length; i++) {
    const a = rowsA[i],
      b = rowsB[i];
    if (a.bad || b.bad) {
      console.log(
        `  n=${(a.n / 1e6).toFixed(2)}M g=${a.groups}  (verify failed)`,
      );
      continue;
    }
    const speedup = a.median / b.median;
    const tag = speedup >= 1 ? "faster" : "SLOWER";
    console.log(
      `  n=${(a.n / 1e6).toFixed(2)}M g=${a.groups}  ` +
        `${a.median.toFixed(3)}ms -> ${b.median.toFixed(3)}ms  ` +
        `${speedup.toFixed(2)}x ${tag}`,
    );
  }
}
console.log("");
