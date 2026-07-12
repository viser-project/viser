import { describe, expect, it } from "vitest";
import { runSequence, startingLayouts } from "./fuzzHarness";

// Tuned so each file runs well under the timeout while still exploring
// deeply; the three fuzz files together apply ~600k fully invariant- and
// immutability-checked ops, in parallel workers.
const SEEDS = 800;
const STEPS = 120;

function runFixture(
  start: { name: string; make: () => import("./types").DockLayout },
  seedBase: number,
): void {
  it(
    `maintains invariants under random op sequences (${start.name})`,
    { timeout: 30000 },
    () => {
      const failures: string[] = [];
      for (let seed = seedBase + 1; seed <= seedBase + SEEDS; seed++) {
        const { failure, descs } = runSequence(start.make, seed, STEPS);
        if (failure !== null) {
          failures.push(
            `seed=${seed} step=${failure.step} op=${failure.desc}\n` +
              (failure.threw ? `  THREW: ${failure.threw}\n` : "") +
              (failure.mutatedInput ? `  MUTATED INPUT\n` : "") +
              failure.violations.map((x) => `  - ${x}`).join("\n") +
              `\n  sequence:\n    ${descs.join("\n    ")}`,
          );
          if (failures.length >= 3) break;
        }
      }
      expect(failures, failures.join("\n\n")).toEqual([]);
    },
  );
}

describe("layoutOps invariant fuzz (fixtures 2-3)", () => {
  const starts = startingLayouts();
  // Seed bands offset per fixture so the fixture tests explore disjoint
  // regions of the seed space.
  for (let i = 2; i <= Math.min(3, starts.length - 1); i++)
    runFixture(starts[i], i * 10000);
});
