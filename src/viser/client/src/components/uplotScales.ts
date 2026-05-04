// Helpers for normalizing the `scales` config we hand to uPlot.

import type uPlot from "uplot";

type Scale = NonNullable<uPlot.Options["scales"]>[string];

/**
 * Rewrite an x-scale that uses a static [min, max] tuple `range` so user
 * zoom is preserved across data updates.
 *
 * uPlot's tuple-range path wraps the array via `fnOrSelf` into a function
 * that ignores its inputs and always returns the static bounds. Every
 * redraw — including the one `uplot-react` issues on each data push —
 * re-commits the current scale through that range function, silently
 * reverting any drag-to-zoom.
 *
 * The replacement function uses the tuple as a default at init (uPlot
 * calls range(self, null, null) on the x-scale's first commit) but honors
 * the explicit min/max uPlot supplies for every subsequent setScale —
 * including the redraw scale-preservation path that pushes the current
 * scaleX.min/max back through.
 *
 * Non-x tuple ranges are deliberately left untouched: `range=(ymin, ymax)`
 * on a y-scale almost always means "lock this axis." uPlot calls a y-scale's
 * range function with non-null `accScale`-derived inputs even on first
 * render, so a smart-range here would silently replace the user's static
 * bounds with the data extrema. See `examples/02_gui/08_uplot.py`.
 */
export function transformScales(
  scales: { [key: string]: Scale } | null | undefined,
): { [key: string]: Scale } | undefined {
  if (!scales) return undefined;
  const out: { [key: string]: Scale } = {};
  for (const [key, scale] of Object.entries(scales)) {
    if (key !== "x" || !scale || !Array.isArray(scale.range)) {
      out[key] = scale;
      continue;
    }
    const [hardMin, hardMax] = scale.range as [number | null, number | null];
    out[key] = {
      ...scale,
      range: (_u, dataMin, dataMax) =>
        dataMin == null && dataMax == null
          ? [hardMin, hardMax]
          : [dataMin ?? hardMin, dataMax ?? hardMax],
    };
  }
  return out;
}
