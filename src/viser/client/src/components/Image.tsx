import React, { useEffect, useState } from "react";
import { GuiImageMessage } from "../WebsocketMessages";
import { Box, Text, Modal, Tooltip, ActionIcon } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconMaximize } from "@tabler/icons-react";

const ImageWithExpand = React.memo(function ImageWithExpand({
  imageUrl,
  label,
  onExpand,
}: {
  imageUrl: string;
  label: string | null;
  onExpand?: () => void;
}) {
  // Hover state for expand button.
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Box px="xs" pb="0.5em">
      {label === null ? null : (
        <Text fz="sm" style={{ display: "block" }}>
          {label}
        </Text>
      )}
      <Box
        style={{ position: "relative" }}
        onMouseEnter={onExpand ? () => setIsHovered(true) : undefined}
        onMouseLeave={onExpand ? () => setIsHovered(false) : undefined}
      >
        <img
          src={imageUrl}
          style={{
            maxWidth: "100%",
            height: "auto",
            display: "block",
          }}
        />
        {/* Show expand icon on hover. */}
        {onExpand && isHovered && (
          <Tooltip label="Expand image">
            <ActionIcon
              onClick={onExpand}
              variant="subtle"
              color="gray"
              size="sm"
              style={{
                position: "absolute",
                bottom: 8,
                right: 8,
                backgroundColor: "rgba(255, 255, 255, 0.9)",
                backdropFilter: "blur(4px)",
                zIndex: 1001,
              }}
            >
              <IconMaximize size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
});

// Mantine's "xl" modal size in pixels.
const XL_SIZE_PX = 880;

function ImageComponent(message: GuiImageMessage) {
  if (!message.props.visible) return null;
  return <ImageComponentInner {...message} />;
}

function ImageComponentInner({ props }: GuiImageMessage) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageWidth, setImageWidth] = useState<number | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

  useEffect(() => {
    if (props._data === null) {
      setImageUrl(null);
      setImageWidth(null);
      return;
    }
    const image_url = URL.createObjectURL(
      new Blob([props._data], { type: "image/" + props._format }),
    );
    setImageUrl(image_url);

    // Load image to get natural dimensions.
    const img = new Image();
    img.onload = () => setImageWidth(img.naturalWidth);
    img.src = image_url;

    return () => {
      URL.revokeObjectURL(image_url);
    };
  }, [props._data, props._format]);

  if (imageUrl === null) return null;

  // Calculate modal size: min(90%, max(xl, imageWidth)).
  const modalSize =
    imageWidth !== null
      ? `min(90%, max(${XL_SIZE_PX}px, ${imageWidth}px))`
      : "xl";

  return (
    <>
      {/* Draw image in the control panel with hover-to-expand icon. */}
      <ImageWithExpand
        imageUrl={imageUrl}
        label={props.label}
        onExpand={open}
      />

      {/* Modal contents. */}
      <Modal
        opened={opened}
        onClose={close}
        size={modalSize}
        title={props.label}
      >
        <img
          src={imageUrl}
          style={{
            maxWidth: "100%",
            height: "auto",
            display: "block",
            margin: "0 auto",
          }}
        />
      </Modal>
    </>
  );
}

export default ImageComponent;
