import React from "react";
import { GuiPlotlyMessage } from "../WebsocketMessages";
import { useDisclosure } from "@mantine/hooks";
import { Modal, Box, Paper, Tooltip, ActionIcon } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconMaximize } from "@tabler/icons-react";

// When drawing border around the plot, it should be aligned with the folder's.
import { folderWrapper } from "./Folder.css";

function PlotWithAspect(props: {
  jsonStr: string;
  aspectRatio: number;
  onExpand?: () => void;
}) {
  if (props.jsonStr === "") return <div></div>;
  return <PlotWithAspectInner {...props} />;
}

const PlotWithAspectInner = React.memo(function PlotWithAspectInner({
  jsonStr,
  aspectRatio,
  onExpand,
}: {
  jsonStr: string;
  aspectRatio: number;
  onExpand?: () => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  // Box size change -> width value change -> plot rerender trigger.
  const { ref, width } = useElementSize();
  // Used to imperatively call ``Plotly.react``.
  // based on https://github.com/plotly/react-plotly.js/issues/242.
  const plotRef = React.useRef<HTMLDivElement>(null);

  // Parse JSON only when ``jsonStr`` changes. Memoizing avoids re-parsing
  // on every render and keeps ``plotJson`` referentially stable across
  // resizes -- the effect below adds ``width`` / ``aspectRatio`` to deps
  // so it still re-fires on container size changes.
  const plotJson = React.useMemo(() => {
    const parsed = JSON.parse(jsonStr);
    // This keeps the zoom-in state, etc, see https://plotly.com/javascript/uirevision/.
    parsed.layout.uirevision = "true";
    return parsed;
  }, [jsonStr]);

  React.useEffect(() => {
    // @ts-ignore - Plotly.js is dynamically imported with an eval() call.
    Plotly.react(
      plotRef.current!,
      plotJson.data,
      { ...plotJson.layout, width, height: width * aspectRatio },
      plotJson.config,
    );
  }, [plotJson, width, aspectRatio]);

  return (
    <Paper
      ref={ref}
      className={folderWrapper}
      withBorder
      style={{ position: "relative" }}
      onMouseEnter={onExpand ? () => setIsHovered(true) : undefined}
      onMouseLeave={onExpand ? () => setIsHovered(false) : undefined}
    >
      <div ref={plotRef} />
      {/* Show expand icon on hover */}
      {onExpand && isHovered && (
        <Tooltip label="Expand plot">
          <ActionIcon
            onClick={onExpand}
            variant="subtle"
            color="gray"
            size="sm"
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              backgroundColor: "rgba(255, 255, 255, 0.9)",
              backdropFilter: "blur(4px)",
              zIndex: 1001,
            }}
          >
            <IconMaximize size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Paper>
  );
});

export default function PlotlyComponent(message: GuiPlotlyMessage) {
  if (!message.props.visible) return null;
  return <PlotlyComponentInner {...message} />;
}

function PlotlyComponentInner({
  props: { _plotly_json_str: plotly_json_str, aspect },
}: GuiPlotlyMessage) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <Box>
      {/* Draw interactive plot in the controlpanel with hover-to-expand icon */}
      <PlotWithAspect
        jsonStr={plotly_json_str}
        aspectRatio={aspect}
        onExpand={open}
      />

      {/* Modal contents. */}
      <Modal opened={opened} onClose={close} size="xl">
        <PlotWithAspect jsonStr={plotly_json_str} aspectRatio={aspect} />
      </Modal>
    </Box>
  );
}
