import { ViewerContext } from "./ViewerContext";
import { GuiModalMessage } from "./WebsocketMessages";
import GeneratedGuiContainer from "./ControlPanel/Generated";
import { Modal } from "@mantine/core";
import { useContext } from "react";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";

export function ViserModal() {
  const viewer = useContext(ViewerContext)!;

  const modalList = viewer.useGui((state) => state.modals, shallowArrayEqual);
  const modals = modalList.map((conf, index) => {
    return <GeneratedModal key={conf.uuid} conf={conf} index={index} />;
  });

  return modals;
}

function GeneratedModal({
  conf,
  index,
}: {
  conf: GuiModalMessage;
  index: number;
}) {
  return (
    <Modal
      opened={true}
      title={conf.title}
      onClose={() => {
        // To make memory management easier, we should only close modals from
        // the server.
        // Otherwise, the client would need to communicate to the server that
        // the modal was deleted and contained GUI elements were cleared.
      }}
      withCloseButton={false}
      centered
      zIndex={100 + index}
    >
      <GeneratedGuiContainer containerUuid={conf.uuid} />
    </Modal>
  );
}
