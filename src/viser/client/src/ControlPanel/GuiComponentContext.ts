import * as React from "react";
import * as Messages from "../WebsocketMessages";

interface GuiComponentContext {
  folderDepth: number;
  setValue: (id: string, value: NonNullable<unknown>) => void;
  messageSender: (message: Messages.Message) => void;
  GuiContainer: React.FC<{ containerUuid: string }>;
}

export const GuiComponentContext = React.createContext<GuiComponentContext>({
  folderDepth: 0,
  setValue: () => undefined,
  messageSender: () => undefined,
  GuiContainer: () => {
    throw new Error("GuiComponentContext not initialized");
  },
});
