/** Guards for the explicit R3F three-class catalogue.
 *
 * Production builds patch out R3F's automatic `extend(THREE)` (see
 * vite.config.mts) to enable tree-shaking; the dev server keeps the
 * automatic catalogue. That asymmetry means a newly used JSX intrinsic works
 * in dev but silently fails to construct in production -- so this test scans
 * the JSX in src/ and fails when an intrinsic is missing from
 * threeCatalogue.ts. A second test pins the fiber code pattern the build
 * patch replaces, so a fiber upgrade that changes it fails loudly instead of
 * silently regrowing the bundle.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dreiThreeCatalogue, viserThreeCatalogue } from "./threeCatalogue";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Standard DOM elements (HTML + the SVG subset viser uses). */
const DOM_TAGS = new Set(
  (
    "a abbr article aside b br button canvas circle cite code defs details " +
    "dialog div ellipse em footer form g h1 h2 h3 h4 h5 h6 header hr i " +
    "iframe img input label li line linearGradient main mask nav ol option " +
    "p path pattern picture polygon polyline pre radialGradient rect " +
    "section select small source span stop strong style sub summary sup " +
    "svg symbol table tbody td template text textarea th thead title tr " +
    "tspan ul use video wbr"
  ).split(" "),
);

/** R3F intrinsics with no backing class. */
const SPECIAL_TAGS = new Set(["primitive"]);

/** Custom classes registered in r3f-extend.ts outside the catalogue. */
const LINE_TAGS = new Set([
  "lineMaterial",
  "line2",
  "lineSegments2",
  "lineGeometry",
  "lineSegmentsGeometry",
]);

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...collectTsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Strip string literals and comments so shader chunks (`#include <common>`)
 * and text content don't read as JSX. */
function stripNonCode(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/gs, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/\*.*?\*\//gs, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

describe("three JSX catalogue", () => {
  it("covers every lowercase intrinsic rendered in src/", () => {
    const registered = new Set([
      ...[
        ...Object.keys(viserThreeCatalogue),
        ...Object.keys(dreiThreeCatalogue),
      ].map((name) => name[0].toLowerCase() + name.slice(1)),
      ...SPECIAL_TAGS,
      ...LINE_TAGS,
    ]);

    const missing = new Map<string, string>();
    for (const file of collectTsxFiles(SRC_DIR)) {
      const code = stripNonCode(readFileSync(file, "utf8"));
      // JSX intrinsic: `<tag ...`, not preceded by an identifier (excludes
      // TS generics like useState<uPlot>), not followed by `.` (excludes
      // member-expression components like <guiContext.GuiContainer>).
      for (const m of code.matchAll(
        /[^A-Za-z0-9_$]<([a-z][a-zA-Z0-9]*)[\s/>]/g,
      )) {
        const tag = m[1];
        if (!DOM_TAGS.has(tag) && !registered.has(tag)) {
          missing.set(tag, file);
        }
      }
    }
    expect(
      [...missing.entries()].map(([tag, file]) => `<${tag}> in ${file}`),
    ).toEqual([]);
  });

  it("matches the fiber code the build patch replaces", () => {
    const fiberDist = readFileSync(
      join(
        SRC_DIR,
        "../node_modules/@react-three/fiber/dist/react-three-fiber.esm.js",
      ),
      "utf8",
    );
    // Must stay in sync with fiberNoAutoExtend in vite.config.mts.
    expect(fiberDist).toContain("React.useMemo(() => extend(THREE), [])");
  });
});
