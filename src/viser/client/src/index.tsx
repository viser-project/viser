import ReactDOM from "react-dom/client";
import { Root } from "./App";
import { installInputManagerTestApi } from "./inputManager/devTestApi";

installInputManagerTestApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <Root />,
);
