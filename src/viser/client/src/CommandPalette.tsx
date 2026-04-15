import {
  Spotlight,
  SpotlightActionData,
  SpotlightActionGroupData,
} from "@mantine/spotlight";

type SpotlightActions = SpotlightActionData | SpotlightActionGroupData;
import "@mantine/spotlight/styles.css";
import { useHotkeys } from "@mantine/hooks";
import Fuse, { IFuseOptions } from "fuse.js";
import React, { useCallback, useContext, useMemo, useRef } from "react";
import { ViewerContext } from "./ViewerContext";
import { RegisterActionMessage } from "./WebsocketMessages";
import { isMac } from "./utils/platform";

type Hotkey = RegisterActionMessage["props"]["hotkey"];

/** Convert a hotkey value to the "mod+shift+R" string format for Mantine. */
function hotkeyToString(hotkey: NonNullable<Hotkey>): string {
  if (typeof hotkey === "string") return hotkey;
  return hotkey.join("+");
}

/** Format a hotkey for display (e.g. ("mod", "shift", "R") → "⌘⇧R" or "Ctrl+Shift+R"). */
function formatHotkey(hotkey: NonNullable<Hotkey>): string {
  const parts = typeof hotkey === "string" ? [hotkey] : hotkey;
  return parts
    .map((part) => {
      const key = part.toLowerCase();
      if (key === "mod") return isMac ? "⌘" : "Ctrl+";
      if (key === "shift") return isMac ? "⇧" : "Shift+";
      if (key === "alt") return isMac ? "⌥" : "Alt+";
      if (key === "ctrl") return isMac ? "⌃" : "Ctrl+";
      return part;
    })
    .join("");
}

/** Build Spotlight-compatible actions from the registered action map. */
function useSpotlightActions(
  actions: Record<string, RegisterActionMessage>,
  onTrigger: (uuid: string) => void,
): SpotlightActionData[] {
  return useMemo(
    () =>
      Object.values(actions).map((action) => {
        const hotkey = action.props.hotkey;
        const desc = action.props.description;
        const description =
          desc && hotkey
            ? `${desc}  (${formatHotkey(hotkey)})`
            : desc
              ? desc
              : hotkey
                ? formatHotkey(hotkey)
                : undefined;
        const disabled = action.props.disabled;
        return {
          id: action.uuid,
          label: action.props.label,
          description,
          disabled,
          onClick: disabled ? undefined : () => onTrigger(action.uuid),
          style: disabled
            ? { opacity: 0.5, cursor: "not-allowed" }
            : undefined,
          leftSection:
            action.props._icon_html != null ? (
              <span
                style={{ display: "flex", alignItems: "center" }}
                dangerouslySetInnerHTML={{ __html: action.props._icon_html }}
              />
            ) : undefined,
          keywords: action.props.description
            ? [action.props.description]
            : undefined,
        };
      }),
    [actions, onTrigger],
  );
}

const FUSE_OPTIONS: IFuseOptions<SpotlightActionData> = {
  keys: ["label", "description", "keywords"],
  threshold: 0.4,
  ignoreLocation: true,
};

/** Hook returning a stable fuzzy filter function that reuses its Fuse index. */
function useFuseFilter() {
  const fuseRef = useRef<{
    actions: SpotlightActions[];
    fuse: Fuse<SpotlightActionData>;
  } | null>(null);

  return useCallback((query: string, actions: SpotlightActions[]) => {
    if (!query) return actions;

    const flat: SpotlightActionData[] = actions.flatMap((a) =>
      "group" in a
        ? (a as SpotlightActionGroupData).actions
        : [a as SpotlightActionData],
    );

    // Rebuild the Fuse index only when the actions list changes.
    if (!fuseRef.current || fuseRef.current.actions !== actions) {
      fuseRef.current = { actions, fuse: new Fuse(flat, FUSE_OPTIONS) };
    }
    return fuseRef.current.fuse.search(query).map((result) => result.item);
  }, []);
}

export function CommandPalette() {
  const viewer = useContext(ViewerContext)!;
  const actions = viewer.useGui((state) => state.actions);
  const sendMessage = viewer.mutable.current.sendMessage;

  const handleTrigger = useCallback(
    (uuid: string) => {
      sendMessage({
        type: "ActionTriggerMessage",
        uuid,
      });
    },
    [sendMessage],
  );

  const spotlightActions = useSpotlightActions(actions, handleTrigger);
  const fuseFilter = useFuseFilter();

  // Register per-action hotkeys.
  const hotkeyItems = useMemo(
    () =>
      Object.values(actions)
        .filter((a) => a.props.hotkey != null && !a.props.disabled)
        .map(
          (a) =>
            [hotkeyToString(a.props.hotkey!), () => handleTrigger(a.uuid)] as [
              string,
              (event: KeyboardEvent) => void,
            ],
        ),
    [actions, handleTrigger],
  );
  useHotkeys(hotkeyItems);

  return (
    <Spotlight
      actions={spotlightActions}
      shortcut={["mod + K", "mod + P"]}
      nothingFound="No matching actions..."
      highlightQuery
      filter={fuseFilter}
      scrollable
      maxHeight={350}
      searchProps={{
        placeholder: "Search actions...",
      }}
    />
  );
}
