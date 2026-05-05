import { Box, Text } from "@mantine/core";
import Markdown from "../Markdown";
import { ErrorBoundary } from "react-error-boundary";
import { GuiMarkdownMessage } from "../WebsocketMessages";

export default function MarkdownComponent({
  props: { visible, _markdown: markdown },
}: GuiMarkdownMessage) {
  if (!visible) return null;
  return (
    <Box pb="xs" px="sm" style={{ maxWidth: "95%" }}>
      <ErrorBoundary
        fallback={
          <Text style={{ textAlign: "center" }}>Markdown Failed to Render</Text>
        }
      >
        <Markdown>{markdown}</Markdown>
      </ErrorBoundary>
    </Box>
  );
}
