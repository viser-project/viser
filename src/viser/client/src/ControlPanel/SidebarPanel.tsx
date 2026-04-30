// @refresh reset

import {
  ActionIcon,
  Box,
  Divider,
  Paper,
  ScrollArea,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import React from "react";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

const SidebarPanelContext = React.createContext<null | {
  collapsible: boolean;
  toggleCollapsed: () => void;
}>(null);

/** A fixed or collapsible side panel for displaying controls. */
export default function SidebarPanel({
  children,
  collapsible,
  width,
}: {
  children: string | React.ReactNode;
  collapsible: boolean;
  width: string;
}) {
  const [collapsed, { toggle: toggleCollapsed }] = useDisclosure(false);
  const { colorScheme } = useMantineColorScheme();

  const collapsedView = (
    <Box
      style={(theme) => ({
        /* Animate in when collapsed. */
        position: "absolute",
        top: 0,
        right: collapsed ? "0em" : "-3em",
        transitionProperty: "right",
        transitionDuration: "0.5s",
        transitionDelay: "0.25s",
        /* Visuals. */
        borderBottomLeftRadius: "0.5em",
        backgroundColor:
          colorScheme == "dark"
            ? theme.colors.dark[5]
            : theme.colors.gray[2],
        padding: "0.5em",
      })}
    >
      <ActionIcon
        onClick={(evt) => {
          evt.stopPropagation();
          toggleCollapsed();
        }}
      >
        <Tooltip zIndex={100} label={"Show sidebar"}>
          {<IconChevronLeft />}
        </Tooltip>
      </ActionIcon>
    </Box>
  );

  return (
    <SidebarPanelContext.Provider
      value={{
        collapsible: collapsible,
        toggleCollapsed: toggleCollapsed,
      }}
    >
      {collapsedView}
      {/* Using an <Aside /> below will break Mantine color inputs. */}
      {/* We create two <Paper /> elements. The first is only used for a drop
      shadow. Note the z-index difference, which is used to put the shadow
      behind the titlebar but the content in front of it. (and thus also in
      front of the titlebar's shadow) */}
      <Paper
        shadow="0 0 1em 0 rgba(0,0,0,0.1)"
        style={{
          width: collapsed ? 0 : width,
          boxSizing: "content-box",
          transition: "width 0.5s 0s",
          zIndex: 8,
        }}
      ></Paper>
      <Paper
        radius={0}
        style={{
          width: collapsed ? 0 : width,
          top: 0,
          bottom: 0,
          right: 0,
          position: "absolute",
          boxSizing: "content-box",
          transition: "width 0.5s 0s",
          zIndex: 20,
        }}
      >
        <Box
          /* Prevent DOM reflow, as well as internals from getting too wide.
           * Needs to match the width of the wrapper element above. */
          style={{
            width: width,
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </Box>
      </Paper>
    </SidebarPanelContext.Provider>
  );
}

/** Handle object helps us hide, show, and drag our panel.*/
SidebarPanel.Handle = function SidebarPanelHandle({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const { toggleCollapsed, collapsible } =
    React.useContext(SidebarPanelContext)!;

  const collapseSidebarToggleButton = (
    <ActionIcon
      onClick={(evt) => {
        evt.stopPropagation();
        toggleCollapsed();
      }}
    >
      <Tooltip zIndex={100} label={"Collapse sidebar"}>
        {<IconChevronRight stroke={1.625} />}
      </Tooltip>
    </ActionIcon>
  );
  return (
    <>
      <Box
        p="xs"
        style={{
          lineHeight: "1.5em",
          fontWeight: 400,
          position: "relative",
          zIndex: 20,
          alignItems: "center",
          display: "flex",
          flexDirection: "row",
        }}
      >
        {children}
        {collapsible ? collapseSidebarToggleButton : null}
      </Box>
      <Divider mx="xs" />
    </>
  );
};
/** Contents of a panel. */
SidebarPanel.Contents = function SidebarPanelContents({
  children,
}: {
  children: string | React.ReactNode;
}) {
  return <ScrollArea style={{ flexGrow: 1 }}>{children}</ScrollArea>;
};
