import { notifications } from "@mantine/notifications";
import { detect } from "detect-browser";
import { useEffect } from "react";
import { Box } from "@mantine/core";

/** Check if WebGL is supported in the current browser.
 *
 * Returns:
 * - supported: true if WebGL context can be created
 * - renderer: the WebGL renderer string (may be available even if context creation fails later)
 * - vendor: the WebGL vendor string
 * - contextCreationFailed: true if WebGL is detected but context creation failed
 */
function checkWebGLSupport(): {
  supported: boolean;
  renderer: string;
  vendor: string;
  contextCreationFailed: boolean;
} {
  const canvas = document.createElement("canvas");
  let supported = false;
  let renderer = "unknown";
  let vendor = "unknown";
  let contextCreationFailed = false;

  // Try WebGL2 first, then WebGL1
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  } catch (e) {
    // Context creation raised an exception
    contextCreationFailed = true;
  }

  if (gl) {
    supported = true;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "unknown";
      vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? "unknown";
    }
  } else if (!contextCreationFailed) {
    // getContext returned null but no exception - WebGL might not exist
    supported = false;
  }

  return { supported, renderer, vendor, contextCreationFailed };
}

/** Get the Chrome launch command for software rendering. */
function getSoftwareRenderingCommand(): string {
  return "google-chrome --ignore-gpu-blocklist";
}

export function BrowserWarning() {
  useEffect(() => {
    const browser = detect();

    // Browser version are based loosely on support for SIMD, OffscreenCanvas.
    //
    // https://caniuse.com/?search=simd
    // https://caniuse.com/?search=OffscreenCanvas
    if (browser === null || browser.version === null) {
      console.log("Failed to detect browser");
      notifications.show({
        title: "Could not detect browser version",
        message:
          "Your browser version could not be detected. It may not be supported.",
        autoClose: false,
        color: "red",
      });
    } else {
      const version = parseFloat(browser.version);
      console.log(`Detected ${browser.name} version ${version}`);
      if (
        (browser.name === "chrome" && version < 91) ||
        (browser.name === "edge" && version < 91) ||
        (browser.name === "firefox" && version < 89) ||
        (browser.name === "opera" && version < 77) ||
        (browser.name === "safari" && version < 16.4)
      )
        notifications.show({
          title: "Unsuppported browser",
          message: `Your browser (${
            browser.name.slice(0, 1).toUpperCase() + browser.name.slice(1)
          }/${
            browser.version
          }) is outdated, which may cause problems. Consider updating.`,
          autoClose: false,
          color: "red",
        });
    }

    // Check WebGL support
    const webglInfo = checkWebGLSupport();
    console.log(
      `WebGL support: ${webglInfo.supported}, renderer: ${webglInfo.renderer}, vendor: ${webglInfo.vendor}, contextCreationFailed: ${webglInfo.contextCreationFailed}`,
    );

    const softwareCmd = getSoftwareRenderingCommand();

    if (!webglInfo.supported || webglInfo.contextCreationFailed) {
      notifications.show({
        title: webglInfo.contextCreationFailed
          ? "WebGL context creation failed"
          : "WebGL not supported",
        message: (
          <>
            {webglInfo.contextCreationFailed
              ? "WebGL context could not be created (likely due to GPU/display configuration). "
              : "Your browser/GPU configuration does not support WebGL. "}
            Try running Chrome with software rendering:{" "}
            <Box
              component="code"
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: "4px 8px",
                backgroundColor: "#f5f5f5",
                border: "1px solid #ddd",
                borderRadius: 4,
                fontFamily: "monospace",
                fontSize: "0.85em",
                color: "#333",
                wordBreak: "break-all",
              }}
            >
              {softwareCmd}
            </Box>
          </>
        ),
        autoClose: false,
        color: "red",
      });
    } else if (
      webglInfo.renderer.toLowerCase().includes("llvmpipe") ||
      webglInfo.renderer.toLowerCase().includes("software")
    ) {
      // Software rendering is active - show an info notification
      notifications.show({
        title: "Software WebGL rendering",
        message:
          "WebGL is running in software mode. Performance may be slow.",
        autoClose: 8000,
        color: "orange",
      });
    }
  });
  return null;
}
