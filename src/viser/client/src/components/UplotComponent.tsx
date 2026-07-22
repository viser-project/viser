import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import "uplot/dist/uPlot.min.css";
import "./UplotComponent.css";

import {
  Modal,
  Box,
  Paper,
  Tooltip,
  ActionIcon,
  useMantineTheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure, useElementSize } from "@mantine/hooks";
import { IconMaximize } from "@tabler/icons-react";
import { GuiUplotMessage } from "../WebsocketMessages";
import { folderWrapper } from "./Folder.css";
import uPlot from "uplot";

type UplotScale = NonNullable<uPlot.Options["scales"]>[string];

type DblclickBind = (
  self: uPlot,
  targ: HTMLElement,
  handle: (e: Event) => void,
  onlyTarg?: boolean,
) => (e: MouseEvent) => void;

/**
 * Rewrite x-scales whose `range` is a static [min, max] tuple so user
 * zoom is preserved across data updates, and emit:
 *   - init hooks that pin the initial bounds, bypassing uPlot's
 *     unconditional `autoScaleX()` at construction (uPlot.cjs.js:6080);
 *   - a dblclick `cursor.bind` that resets to the user's tuple instead
 *     of running uPlot's default fit-to-data autoscale.
 *
 * uPlot's tuple-range path wraps the array via `fnOrSelf` into a function
 * that ignores its inputs and always returns the static bounds. Every
 * redraw — including the one `uplot-react` issues on each data push —
 * re-commits the current scale through that range function, silently
 * reverting any drag-to-zoom. Replacing the array with a callable that
 * honors uPlot's explicit min/max fixes the zoom-reverts-on-redraw case;
 * the init hook covers first render; the dblclick bind covers reset.
 *
 * Non-x tuple ranges are left untouched: `range=(ymin, ymax)` on a
 * y-scale almost always means "lock this axis," and uPlot's existing
 * tuple-range semantic is exactly that. See `examples/02_gui/08_uplot.py`.
 *
 * We also pin `auto: false` to mirror uPlot's own
 * `sc.auto = fnOrSelf(rangeIsArr ? false : sc.auto)` (uPlot.cjs.js:3070).
 */
function transformScales(scales: GuiUplotMessage["props"]["scales"]): {
  scales: { [key: string]: UplotScale } | undefined;
  hooks: { init: ((u: uPlot) => void)[] };
  dblclickBind: DblclickBind | undefined;
} {
  if (!scales) {
    return { scales: undefined, hooks: { init: [] }, dblclickBind: undefined };
  }
  const out: { [key: string]: UplotScale } = {};
  // uPlot's `init` hook is typed `(u: uPlot) => void`, but is actually
  // invoked as `(u, opts, data)` — see `fire("init", opts, data)` in
  // uPlot.cjs.js. We accept the third arg via an `as` cast at return.
  const initHooks: ((u: uPlot) => void)[] = [];
  const resets: ((u: uPlot) => void)[] = [];
  for (const [key, scale] of Object.entries(scales)) {
    if (key !== "x" || !scale || !Array.isArray(scale.range)) {
      out[key] = scale as UplotScale;
      continue;
    }
    const [hardMin, hardMax] = scale.range as [number | null, number | null];
    // Resolve null sides of a partial-null tuple (e.g. (None, 0)) from
    // the x-data extrema. uPlot keeps the x-series sorted ascending, so
    // xs[0] / xs[last] are the data min / max. uPlot's own
    // array-to-soft-bound conversion (uPlot.cjs.js:3041) is gated to
    // non-x scales; for x we have to do it ourselves.
    const resolve = (xs: ArrayLike<number> | undefined) => ({
      min: hardMin ?? (xs && xs.length > 0 ? xs[0] : null),
      max: hardMax ?? (xs && xs.length > 0 ? xs[xs.length - 1] : null),
    });
    out[key] = {
      ...scale,
      auto: false,
      range: (u, dataMin, dataMax) => {
        const { min, max } = resolve(u.data?.[0] as ArrayLike<number>);
        return [dataMin ?? min, dataMax ?? max];
      },
    } as UplotScale;
    // At init-hook fire time `self.data` is not yet assigned; the third
    // argument to the hook is the constructor's data tuple.
    initHooks.push(((
      u: uPlot,
      _opts: unknown,
      data: ArrayLike<ArrayLike<number>>,
    ) => {
      const { min, max } = resolve(data?.[0]);
      if (min == null || max == null) return;
      u.setScale(key, { min, max });
    }) as (u: uPlot) => void);
    resets.push((u) => {
      const { min, max } = resolve(u.data?.[0] as ArrayLike<number>);
      if (min == null || max == null) return;
      u.setScale(key, { min, max });
    });
  }
  const dblclickBind: DblclickBind | undefined =
    resets.length === 0
      ? undefined
      : (self, targ, _handle, onlyTarg = true) =>
          (e) => {
            // Mirror uPlot's `filtBtn0` filter: left-click only, on-target
            // only by default.
            if (e.button !== 0) return;
            if (onlyTarg && e.target !== targ) return;
            resets.forEach((r) => r(self));
          };
  return { scales: out, hooks: { init: initHooks }, dblclickBind };
}

// E2E testpoint: lives under the same `__viserTestpoints` namespace as
// `rendererInfo` and `devSettings` (App.tsx). `createCount` lets tests
// assert the chart was not torn down and rebuilt across resize / data
// pushes — silent destroy/create would lose the user's zoom.
type UplotTestpoint = { chart: uPlot; createCount: number };
function registerUplotTestpoint(uuid: string, chart: uPlot): void {
  const w = window as unknown as {
    __viserTestpoints?: { uplots?: Record<string, UplotTestpoint> };
  };
  const tp = (w.__viserTestpoints ??= {});
  const reg = (tp.uplots ??= {});
  const prev = reg[uuid];
  reg[uuid] = { chart, createCount: (prev?.createCount ?? 0) + 1 };
}
function unregisterUplotTestpoint(uuid: string): void {
  const reg = (
    window as unknown as {
      __viserTestpoints?: { uplots?: Record<string, UplotTestpoint> };
    }
  ).__viserTestpoints?.uplots;
  if (reg) delete reg[uuid];
}

function PlotComponent({
  uuid,
  props,
  onExpand,
}: GuiUplotMessage & {
  onExpand?: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { ref: containerSizeRef, width: containerWidth } = useElementSize();
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();

  // Data arrives as Float64Array views. Use directly, zero copy.
  const [data, xMin, xMax] = useMemo(() => {
    const convertedData = props.data;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (const val of convertedData[0]) {
      if (val < xMin) xMin = val;
      if (val > xMax) xMax = val;
    }
    return [convertedData, xMin, xMax];
  }, [props.data]);

  // Memoized on `props.scales` alone so width / theme re-renders don't
  // mint fresh `range` / `hooks` / `cursor.bind` references each tick —
  // uplot-react would diff those as `'create'` and rebuild the chart,
  // dropping user zoom. See `transformScales` for what the rewrite does.
  const {
    scales: processedScales,
    hooks: scaleHooks,
    dblclickBind,
  } = useMemo(() => transformScales(props.scales), [props.scales]);

  // Merge user-supplied cursor config with our dblclick override (if any).
  // Stable-ref'd so plotOptions doesn't churn it.
  const mergedCursor = useMemo(() => {
    const userCursor = props.cursor as any;
    if (!dblclickBind) return userCursor || undefined;
    return {
      ...userCursor,
      bind: { ...userCursor?.bind, dblclick: dblclickBind },
    };
  }, [props.cursor, dblclickBind]);

  // Apply theme-aware defaults to axes. Hoisted so a resize/width change
  // (which churns the outer plotOptions memo) doesn't spawn fresh axes
  // object identities — uplot-react would diff them as `'create'` and
  // tear the chart down, dropping the user's zoom.
  const processedAxes = useMemo(() => {
    const textColor =
      colorScheme === "dark" ? theme.colors.gray[5] : theme.colors.gray[7];
    const gridColor =
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.03)"
        : theme.colors.gray[2];

    if (props.axes === undefined || props.axes === null) {
      return [
        { stroke: textColor, grid: { stroke: gridColor, show: true } }, // x-axis
        { stroke: textColor, grid: { stroke: gridColor, show: true } }, // y-axis
      ];
    }
    return (props.axes as any).map((axis: any) => {
      if (axis === undefined || axis === null) return axis;
      const result = { ...axis };
      if (result.stroke === undefined) result.stroke = textColor;
      if (result.grid === undefined) {
        result.grid = { stroke: gridColor };
      } else if (result.grid !== null && result.grid.stroke === undefined) {
        result.grid = { ...result.grid, stroke: gridColor };
      }
      if (result.ticks === undefined) {
        result.ticks = { stroke: textColor };
      } else if (result.ticks !== null && result.ticks.stroke === undefined) {
        result.ticks = { ...result.ticks, stroke: textColor };
      }
      return result;
    });
  }, [props.axes, colorScheme, theme.colors.gray]);

  // Build uPlot options from the props.
  //
  // There are some `any` casts because the types here come through multiple
  // transpiler layers, which are imperfect: TS=>Python=>TS.
  const plotOptions = useMemo(() => {
    return {
      width: containerWidth,
      height: (props.height ?? containerWidth / props.aspect) as any,
      title: props.title || undefined,
      mode: props.mode || undefined,
      series: (props.series as any) || [],
      cursor: mergedCursor,
      bands: props.bands || undefined,
      scales: processedScales,
      axes: processedAxes,
      hooks: scaleHooks,
      legend: (props.legend as any) || undefined,
      focus: props.focus || undefined,
      // Set tighter default padding [top, right, bottom, left].
      padding: (props.padding ?? [0, 24, 0, 0]) as [
        number,
        number,
        number,
        number,
      ],
    };
  }, [
    containerWidth,
    props.aspect,
    props.height,
    props.padding,
    props.title,
    props.mode,
    props.series,
    mergedCursor,
    props.bands,
    processedScales,
    scaleHooks,
    processedAxes,
    props.legend,
    props.focus,
  ]);

  // Somewhat experimental: manual scale reset logic. When the plot data is
  // updated, uPlot's default behavior will either:
  // - Persist the absolute x bounds (resetScales=false)
  //     - Unideal because new data can be rendered off the plot.
  // -Reset x bounds to the min/max of the data (resetScales=true)
  //     - Unideal because any manual zooming from the user is lost.
  //
  // Here: we instead persist the relative x bounds, which are proportional to the
  // xMin/xMax of the data. This makes the plot resilient to data updates,
  // without losing user zooming.
  const [plotObj, setPlotObj] = useState<uPlot>();
  const xScaleState = useRef({
    relMin: 0.0,
    relMax: 1.0,
  });
  useEffect(() => {
    if (!plotObj) return;
    const xScaleKey = Object.keys(plotObj.scales)[0];
    const xScale = plotObj.scales[xScaleKey];
    // uPlot wraps `sc.auto` via `fnOrSelf` at init, so it is always a
    // callable here — `=== false` would never match.
    const autoFn = xScale.auto as
      boolean | ((u: uPlot, viaAutoScaleX: boolean) => boolean);
    const isAuto =
      typeof autoFn === "function" ? autoFn(plotObj, false) : autoFn;
    if (isAuto === false) return;
    const span = xMax - xMin;
    if (span === 0) {
      // Avoid degenerate spans.
      return;
    }
    plotObj.setScale(xScaleKey, {
      min: xMin + xScaleState.current.relMin * span,
      max: xMin + xScaleState.current.relMax * span,
    });
    return () => {
      // Set the x scale state to the current plot state.
      xScaleState.current = {
        relMin: ((xScale.min ?? 0.0) - xMin) / span,
        relMax: ((xScale.max ?? 1.0) - xMin) / span,
      };
    };
  }, [xMin, xMax, plotObj]);

  return (
    <Paper
      ref={containerSizeRef}
      className={`${folderWrapper} uplot-container`}
      withBorder
      style={{ position: "relative" }}
      onMouseEnter={onExpand ? () => setIsHovered(true) : undefined}
      onMouseLeave={onExpand ? () => setIsHovered(false) : undefined}
    >
      {plotOptions && (
        <UplotReact
          key={colorScheme} // Force remount when theme changes.
          resetScales={false}
          onCreate={(chart) => {
            setPlotObj(chart);
            // Only the INLINE instance registers: the expand-modal renders a
            // second PlotComponent with the same uuid, and letting it share
            // the key would overwrite the entry on open and delete the
            // still-alive inline chart's entry on close. The inline instance
            // is the one given an expand affordance.
            if (onExpand !== undefined) registerUplotTestpoint(uuid, chart);
          }}
          onDelete={() => {
            setPlotObj(undefined);
            if (onExpand !== undefined) unregisterUplotTestpoint(uuid);
          }}
          options={plotOptions}
          data={data}
        />
      )}
      {onExpand && isHovered && (
        <Tooltip label="Expand plot">
          <ActionIcon
            onClick={onExpand}
            variant="subtle"
            color="gray"
            size="sm"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              backgroundColor:
                colorScheme === "dark"
                  ? "rgba(255, 255, 255, 0.1)"
                  : "rgba(255, 255, 255, 0.9)",
              backdropFilter: "blur(4px)",
              // Safari < 18 only supports the prefixed form, and inline
              // styles bypass autoprefixing.
              WebkitBackdropFilter: "blur(4px)",
            }}
          >
            <IconMaximize size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Paper>
  );
}

export default function UplotComponent(message: GuiUplotMessage) {
  if (message.props.visible === false) return null;
  return <UplotComponentInner {...message} />;
}

function UplotComponentInner(message: GuiUplotMessage) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <Box>
      {/* Small plot with expand button. */}
      <PlotComponent {...message} onExpand={open} />

      {/* Modal with larger plot. */}
      <Modal opened={opened} onClose={close} size="xl">
        <PlotComponent {...message} />
      </Modal>
    </Box>
  );
}
