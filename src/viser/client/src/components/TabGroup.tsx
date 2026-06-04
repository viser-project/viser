import * as React from "react";
import { GuiTabGroupMessage } from "../WebsocketMessages";
import { Tabs } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { htmlIconWrapper, tabGroupWrap } from "./ComponentStyles.css";

export default function TabGroupComponent({
  props: {
    _tab_labels: tab_labels,
    _tab_icons_html: tab_icons_html,
    _tab_container_ids: tab_container_ids,
    visible,
  },
}: GuiTabGroupMessage) {
  const { GuiContainer } = React.useContext(GuiComponentContext)!;

  // Identify each tab by its stable container UUID rather than its array index.
  // Tabs can be added/removed at runtime; index-based values would shift the
  // selection -> content mapping, leaving the active tab unselected (or showing
  // the wrong content) after a sibling tab is removed.
  //
  // We track the selection ourselves (controlled) so that removing a *non*
  // active tab keeps the active tab selected, and removing the active tab
  // falls back to the first remaining tab -- the selection always points at a
  // tab that still exists.
  const [activeTab, setActiveTab] = React.useState<string | null>(
    tab_container_ids[0] ?? null,
  );
  React.useEffect(() => {
    if (activeTab === null || !tab_container_ids.includes(activeTab)) {
      setActiveTab(tab_container_ids[0] ?? null);
    }
  }, [tab_container_ids, activeTab]);

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
