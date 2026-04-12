import * as React from "react";
import { useDisclosure } from "@mantine/hooks";
import { GuiFormMessage } from "../WebsocketMessages";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { Box, Collapse, Paper, Tooltip } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViewerContext } from "../ViewerContext";
import { folderLabel, folderToggleIcon, folderWrapper } from "./Folder.css";
import { shallowObjectKeysEqual } from "../utils/shallowObjectKeysEqual";

/** A form: a folder whose contents can be committed together.
 *
 * Children are wrapped in a native `<form>` element so the browser handles
 * implicit Enter submission for single-line inputs. The hidden submit button
 * below is required because HTML only guarantees implicit submission when
 * the form has a submit button or exactly one text input — otherwise
 * multi-input forms would not submit on Enter.
 */
export default function FormComponent({
  uuid,
  props: { label, visible, expand_by_default },
  nextGuiUuid,
}: GuiFormMessage & { nextGuiUuid: string | null }) {
  const viewer = React.useContext(ViewerContext)!;
  const guiContext = React.useContext(GuiComponentContext)!;
  const [opened, { toggle }] = useDisclosure(expand_by_default);
  const [isDirty, setIsDirty] = React.useState(false);

  const guiIdSet = viewer.useGui(
    (state) => state.guiUuidSetFromContainerUuid[uuid],
    shallowObjectKeysEqual,
  );
  const nextGuiType = viewer.useGuiConfig(nextGuiUuid ?? "", (conf) =>
    nextGuiUuid == null ? null : (conf?.type ?? null),
  );

  const submitCount = viewer.useGui(
    (state) => state.guiFormSubmitCountFromUuid[uuid] ?? 0,
  );
  React.useEffect(() => {
    setIsDirty(false);
  }, [submitCount]);

  const messageSender = guiContext.messageSender;
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    messageSender({ type: "GuiFormSubmitMessage", uuid });
  };

  const onChangeAny = () => {
    if (!isDirty) setIsDirty(true);
  };

  if (!visible) return null;

  const isEmpty = guiIdSet === undefined || Object.keys(guiIdSet).length === 0;

  const hiddenSubmitButton = <button type="submit" hidden tabIndex={-1} />;

  const innerFormContents = (unwrapped: boolean) => (
    <GuiComponentContext.Provider
      value={{
        ...guiContext,
        folderDepth: guiContext.folderDepth + 1,
      }}
    >
      <guiContext.GuiContainer containerUuid={uuid} unwrapped={unwrapped} />
    </GuiComponentContext.Provider>
  );

  if (label === null) {
    return (
      <form onSubmit={handleSubmit} onChange={onChangeAny}>
        {hiddenSubmitButton}
        {innerFormContents(true)}
      </form>
    );
  }

  const ToggleIcon = opened ? IconChevronUp : IconChevronDown;
  return (
    <Paper
      component="form"
      withBorder
      className={folderWrapper}
      mb={nextGuiType === "GuiFolderMessage" || nextGuiType === "GuiFormMessage" ? "md" : undefined}
      onSubmit={handleSubmit}
      onChange={onChangeAny}
    >
      {hiddenSubmitButton}
      <Tooltip
        label="Contains unsubmitted changes."
        withArrow
        openDelay={300}
        disabled={!isDirty}
      >
        <Paper
          className={folderLabel}
          style={{
            cursor: isEmpty ? undefined : "pointer",
          }}
          onClick={toggle}
        >
          {label}
          {isDirty ? <span style={{ opacity: 0.5 }}>*</span> : null}
          <ToggleIcon
            className={folderToggleIcon}
            style={{
              display: isEmpty ? "none" : undefined,
            }}
          />
        </Paper>
      </Tooltip>
      <Collapse in={opened && !isEmpty}>
        <Box pt="0.2em">{innerFormContents(false)}</Box>
      </Collapse>
      <Collapse in={!(opened && !isEmpty)}>
        <Box p="xs"></Box>
      </Collapse>
    </Paper>
  );
}
