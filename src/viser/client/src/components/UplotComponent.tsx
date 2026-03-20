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

// Individual plot component.
function PlotComponent({
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

  // Build uPlot options from the props.
  //
  // There are some `any` casts because the types here come through multiple
  // transpiler layers, which are imperfect: TS=>Python=>TS.
  const plotOptions = useMemo(() => {
    // Get theme-aware default colors.
    const textColor =
      colorScheme === "dark" ? theme.colors.gray[5] : theme.colors.gray[7];
    const gridColor =
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.03)"
        : theme.colors.gray[2];

    // Process axes to add theme-aware defaults if not specified by user.
    // If axes are not provided, create default axes with theme colors.
    let processedAxes = props.axes as any;
    if (processedAxes === undefined || processedAxes === null) {
      // Create default axes if none provided.
      processedAxes = [
        { stroke: textColor, grid: { stroke: gridColor, show: true } }, // x-axis
        { stroke: textColor, grid: { stroke: gridColor, show: true } }, // y-axis
      ];
    } else {
      processedAxes = processedAxes.map((axis: any) => {
        if (axis === undefined || axis === null) return axis;

        // Only set defaults if user hasn't specified values.
        const result = { ...axis };

        // Set axis line color default.
        if (result.stroke === undefined) {
          result.stroke = textColor;
        }

        // Set grid color default.
        if (result.grid === undefined) {
          result.grid = { stroke: gridColor };
        } else if (result.grid !== null && result.grid.stroke === undefined) {
          result.grid = { ...result.grid, stroke: gridColor };
        }

        // Set tick color default.
        if (result.ticks === undefined) {
          result.ticks = { stroke: textColor };
        } else if (result.ticks !== null && result.ticks.stroke === undefined) {
          result.ticks = { ...result.ticks, stroke: textColor };
        }

        return result;
      });
    }

    return {
      width: containerWidth,
      height: (containerWidth / props.aspect) as any,
      title: props.title || undefined,
      mode: props.mode || undefined,
      series: (props.series as any) || [],
      cursor: (props.cursor as any) || undefined,
      bands: props.bands || undefined,
      scales: props.scales || undefined,
      axes: processedAxes,
      legend: (props.legend as any) || undefined,
      focus: props.focus || undefined,
      // Set tighter default padding [top, right, bottom, left].
      padding: [0, 24, 0, 0] as [number, number, number, number],
    };
  }, [
    containerWidth,
    props.aspect,
    props.title,
    props.mode,
    props.series,
    props.cursor,
    props.bands,
    props.scales,
    props.axes,
    props.legend,
    props.focus,
    colorScheme,
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
    if (xScale.auto === false) {
      // If the x-axis is manually scaled, we don't need to reset it.
      return;
    }
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
          }}
          onDelete={() => {
            setPlotObj(undefined);
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
  // Modal state.
  const [opened, { open, close }] = useDisclosure(false);

  // Visibility check
  if (message.props.visible === false) return null;

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
