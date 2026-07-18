import * as React from "react";
import { GuiTabGroupMessage } from "../WebsocketMessages";
import { Box, Tabs } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { GuiDockContext } from "../ControlPanel/GuiDockContext";
import { DockArea } from "../dock/DockArea";
import { DockContext, useDock } from "../dock/DockContext";
import * as layoutOps from "../dock/layoutOps";
import { htmlIconWrapper, tabGroupWrap } from "./ComponentStyles.css";

export default function TabGroupComponent(message: GuiTabGroupMessage) {
  // Inside the dock surface (the floating control-panel layout), a tab group
  // renders as a nested DOCKABLE area: its tabs are real dock panes that can
  // be dragged out to float, dock, or merge anywhere -- and dragged back in.
  // Everywhere else (mobile bottom sheet, static export, modals -- which mount
  // outside the dock surface) it renders as plain tabs, exactly as before.
  const dock = React.useContext(DockContext);
  const guiDock = React.useContext(GuiDockContext);
  const inDockSurface = dock !== null && guiDock !== null;

  if (inDockSurface) {
    return <DockableTabGroup {...message} />;
  }
  return <PlainTabGroup {...message.props} />;
}

function DockableTabGroup({
  uuid,
  props: { _tab_container_ids: tab_container_ids, visible },
}: GuiTabGroupMessage) {
  const dock = useDock();
  const guiDock = React.useContext(GuiDockContext)!;
  const areaId = `gui-tabs-${uuid}`;

  // Register with the dock surface: it owns the tabs' panel specs (titles,
  // icons, render functions) and keeps them alive while the SERVER has this
  // tab group, even when this component unmounts (ancestor tab inactive).
  React.useEffect(() => {
    guiDock.registerTabGroup(uuid);
  }, [uuid, guiDock]);

  // Place the tabs into the area once their specs are registered (one render
  // after registration -- placing earlier would race the registry
  // reconciliation, which removes spec-less panes). Panels the user dragged
  // out of the area are left where they are (addPaneToArea no-ops); the rest
  // follow the server's tab order.
  const ready = tab_container_ids.every((cid) => dock.panes[cid] !== undefined);
  const orderKey = tab_container_ids.join("\n");
  React.useEffect(() => {
    if (!ready) return;
    tab_container_ids.forEach((cid, i) =>
      dock.api.addPaneToArea(areaId, cid, i),
    );
    dock.api.apply((layout) =>
      layoutOps.setAreaTabOrder(layout, areaId, tab_container_ids),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, orderKey, areaId, dock.api]);

  if (!visible) return null;
  return (
    <Box style={{ marginTop: "-0.55em" }}>
      <DockArea areaId={areaId} minHeight="2.4em" />
    </Box>
  );
}

/** The fields PlainTabGroup needs -- shared by inline tab groups and standalone
 * panels (which carry the same tab triple). */
export interface PlainTabGroupProps {
  _tab_labels: string[];
  _tab_icons_html: (string | null)[];
  _tab_container_ids: string[];
  visible: boolean;
}

/** Controlled tab selection over a mutable container-id list. Tabs are
 * identified by stable container UUID rather than array index (tabs can be
 * added/removed at runtime; index-based values would shift the selection ->
 * content mapping). Removing a non-active tab keeps the active one selected;
 * removing the active tab falls back to the first remaining -- the selection
 * always points at a tab that still exists. Shared by PlainTabGroup and the
 * mobile panel sections (ControlPanel). */
export function useStableTabSelection(
  ids: string[],
): [string | null, (v: string | null) => void] {
  const [active, setActive] = React.useState<string | null>(ids[0] ?? null);
  React.useEffect(() => {
    if (active === null || !ids.includes(active)) {
      setActive(ids[0] ?? null);
    }
  }, [ids, active]);
  return [active, setActive];
}

export function PlainTabGroup({
  _tab_labels: tab_labels,
  _tab_icons_html: tab_icons_html,
  _tab_container_ids: tab_container_ids,
  visible,
}: PlainTabGroupProps) {
  const { GuiContainer } = React.useContext(GuiComponentContext)!;
  const [activeTab, setActiveTab] = useStableTabSelection(tab_container_ids);

  if (!visible) return null;
  return (
    <Tabs
      radius="xs"
      value={activeTab}
      onChange={setActiveTab}
      className={tabGroupWrap}
      style={{ marginTop: "-0.55em" }}
    >
      <Tabs.List>
        {tab_labels.map((label, index) => (
          <Tabs.Tab
            value={tab_container_ids[index]}
            key={tab_container_ids[index]}
            styles={{
              tabSection: { marginRight: "0.5em" },
              tab: { padding: "0.75em" },
            }}
            leftSection={
              tab_icons_html[index] === null ? undefined : (
                <div
                  className={htmlIconWrapper}
                  dangerouslySetInnerHTML={{ __html: tab_icons_html[index]! }}
                />
              )
            }
          >
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tab_container_ids.map((containerUuid) => (
        <Tabs.Panel value={containerUuid} key={containerUuid}>
          <GuiContainer containerUuid={containerUuid} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
