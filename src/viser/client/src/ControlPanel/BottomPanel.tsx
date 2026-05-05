import { Box, Collapse, Divider, Paper, ScrollArea } from "@mantine/core";
import React from "react";
import { useDisclosure } from "@mantine/hooks";

const BottomPanelContext = React.createContext<null | {
  wrapperRef: React.RefObject<HTMLDivElement>;
  expanded: boolean;
  toggleExpanded: () => void;
}>(null);

/** A bottom panel is used to display the controls on mobile devices. */
export default function BottomPanel({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const panelWrapperRef = React.useRef<HTMLDivElement>(null);
  const [expanded, { toggle: toggleExpanded }] = useDisclosure(true);
  return (
    <BottomPanelContext.Provider
      value={{
        wrapperRef: panelWrapperRef,
        expanded: expanded,
        toggleExpanded: toggleExpanded,
      }}
    >
      <>
        <Paper
          radius="0"
          shadow="0 0 1em 0 rgba(0,0,0,0.1)"
          style={{
            boxSizing: "border-box",
            zIndex: 10,
            position: "fixed",
            bottom: 0,
            right: 0,
            margin: 0,
            minHeight: "3.5em",
            maxHeight: "60%",
            width: "20em",
            transition: "height 0.3s linear",
          }}
          component={ScrollArea.Autosize}
          ref={panelWrapperRef}
        >
          <Box
            /* Prevent internals from getting too wide. Needs to match the
             * width of the wrapper element above. */
            style={{ width: "20em" }}
          >
            {children}
          </Box>
        </Paper>
      </>
    </BottomPanelContext.Provider>
  );
}
BottomPanel.Handle = function BottomPanelHandle({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const panelContext = React.useContext(BottomPanelContext)!;
  return (
    <Box
      style={{
        cursor: "pointer",
        position: "relative",
        fontWeight: 400,
        userSelect: "none",
        display: "flex",
        alignItems: "center",
        padding: "0 0.8em",
        height: "3.5em",
      }}
      onClick={() => {
        panelContext.toggleExpanded();
      }}
    >
      {children}
    </Box>
  );
};

/** Contents of a panel. */
BottomPanel.Contents = function BottomPanelContents({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const panelContext = React.useContext(BottomPanelContext)!;
  return (
    <Collapse in={panelContext.expanded}>
      <Divider mx="xs" />
      {children}
    </Collapse>
  );
};

/** Hides contents when panel is collapsed. */
BottomPanel.HideWhenCollapsed = function BottomPanelHideWhenCollapsed({
  children,
}: {
  children: React.ReactNode;
}) {
  const expanded = React.useContext(BottomPanelContext)?.expanded ?? true;
  return expanded ? children : null;
};
