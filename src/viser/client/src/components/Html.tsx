import { GuiHtmlMessage } from "../WebsocketMessages";

function HtmlComponent({ props }: GuiHtmlMessage) {
  if (!props.visible) return null;
  return <div dangerouslySetInnerHTML={{ __html: props.content }} />;
}

export default HtmlComponent;
