import {
  Spotlight,
  SpotlightActionData,
  SpotlightActionGroupData,
} from "@mantine/spotlight";
import "@mantine/spotlight/styles.css";
import { useHotkeys } from "@mantine/hooks";
import Fuse, { FuseResult, IFuseOptions } from "fuse.js";
import React, { useCallback, useContext, useMemo, useRef } from "react";
import { ViewerContext } from "./ViewerContext";
import { RegisterCommandMessage } from "./WebsocketMessages";
import { isMac } from "./utils/platform";

type SpotlightItems = SpotlightActionData | SpotlightActionGroupData;
type Hotkey = RegisterCommandMessage["props"]["hotkey"];

/** Convert a hotkey value to Mantine hotkey strings (e.g. "ctrl+shift+R").
 *
 * ``"cmd/ctrl"`` in the viser hotkey is OR semantics (either Ctrl or Meta
 * counts), so we emit *both* a `"ctrl+..."` and `"meta+..."` variant — on
 * any platform, pressing either modifier triggers the hotkey. This matches
 * the drag-binding semantics so users don't have to remember two rules. */
function hotkeyToStrings(hotkey: NonNullable<Hotkey>): string[] {
  const parts: string[] =
    typeof hotkey === "string" ? [hotkey] : (hotkey as string[]);
  if (!parts.includes("cmd/ctrl")) {
    return [parts.join("+")];
  }
  return [
    parts.map((p) => (p === "cmd/ctrl" ? "ctrl" : p)).join("+"),
    parts.map((p) => (p === "cmd/ctrl" ? "meta" : p)).join("+"),
  ];
}

/** Format a hotkey for display (e.g. ("cmd/ctrl", "shift", "R") -> "⌘⇧R" or "Ctrl+Shift+R"). */
function formatHotkey(hotkey: NonNullable<Hotkey>): string {
  const parts = typeof hotkey === "string" ? [hotkey] : hotkey;
  return parts
    .map((part) => {
      const key = part.toLowerCase();
      if (key === "cmd/ctrl") return isMac ? "⌘" : "Ctrl+";
      if (key === "shift") return isMac ? "⇧" : "Shift+";
      if (key === "alt") return isMac ? "⌥" : "Alt+";
      if (key === "ctrl") return isMac ? "⌃" : "Ctrl+";
      return part;
    })
    .join("");
}

/** Build Spotlight-compatible entries from the registered command map. */
function useSpotlightActions(
  commands: Record<string, RegisterCommandMessage>,
  onTrigger: (uuid: string) => void,
): SpotlightActionData[] {
  return useMemo(
    () =>
      Object.values(commands).map((command) => {
        const hotkey = command.props.hotkey;
        const desc = command.props.description;
        const description =
          desc && hotkey
            ? `${desc}  (${formatHotkey(hotkey)})`
            : desc
              ? desc
              : hotkey
                ? formatHotkey(hotkey)
                : undefined;
        const disabled = command.props.disabled;
        return {
          id: command.uuid,
          label: command.props.label,
          description,
          disabled,
          onClick: disabled ? undefined : () => onTrigger(command.uuid),
          style: disabled
            ? { opacity: 0.5, cursor: "not-allowed" }
            : undefined,
          leftSection:
            command.props._icon_html != null ? (
              <span
                style={{ display: "flex", alignItems: "center" }}
                dangerouslySetInnerHTML={{ __html: command.props._icon_html }}
              />
            ) : undefined,
          keywords: command.props.description
            ? [command.props.description]
            : undefined,
        };
      }),
    [commands, onTrigger],
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
    items: SpotlightItems[];
    fuse: Fuse<SpotlightActionData>;
  } | null>(null);

  return useCallback((query: string, items: SpotlightItems[]) => {
    if (!query) return items;

    const flat: SpotlightActionData[] = items.flatMap((a) =>
      "group" in a
        ? (a as SpotlightActionGroupData).actions
        : [a as SpotlightActionData],
    );

    // Rebuild the Fuse index only when the items list changes.
    if (!fuseRef.current || fuseRef.current.items !== items) {
      fuseRef.current = { items, fuse: new Fuse(flat, FUSE_OPTIONS) };
    }
    return fuseRef.current.fuse
      .search(query)
      .map((result: FuseResult<SpotlightActionData>) => result.item);
  }, []);
}

export function CommandPalette() {
  const viewer = useContext(ViewerContext)!;
  const commands = viewer.useGui((state) => state.commands);
  const viewerMutable = viewer.mutable.current;

  const handleTrigger = useCallback(
    (uuid: string) => {
      viewerMutable.sendMessage({
        type: "CommandTriggerMessage",
        uuid,
      });
    },
    [viewerMutable],
  );

  const spotlightActions = useSpotlightActions(commands, handleTrigger);
  const fuseFilter = useFuseFilter();

  // Register per-command hotkeys. Each viser hotkey can expand to multiple
  // Mantine entries (e.g. "cmd/ctrl" → both "ctrl+K" and "meta+K") so that
  // either modifier matches on any platform — same OR semantics as drag
  // bindings.
  const hotkeyItems = useMemo(
    () =>
      Object.values(commands)
        .filter((c) => c.props.hotkey != null && !c.props.disabled)
        .flatMap((c) => {
          const trigger = () => handleTrigger(c.uuid);
          return hotkeyToStrings(c.props.hotkey!).map(
            (key) =>
              [key, trigger] as [string, (event: KeyboardEvent) => void],
          );
        }),
    [commands, handleTrigger],
  );
  useHotkeys(hotkeyItems);

  if (spotlightActions.length === 0) return null;

  return (
    <Spotlight
      actions={spotlightActions}
      shortcut={["mod + K", "mod + shift + P"]}
      nothingFound="No matching commands..."
      highlightQuery
      filter={fuseFilter}
      scrollable={spotlightActions.length >= 5}
      maxHeight={400}
      searchProps={{
        placeholder: "Search commands...",
      }}
    />
  );
}
