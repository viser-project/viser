/** Utilities for interacting with the URL search parameters.
 *
 * This lets us specify the websocket server + port from the URL. */

export const searchParamKey = "websocket";

export function syncSearchParamServer(server: string) {
  // Skip URL updates in srcdoc iframes (e.g., Jupyter notebook embeds).
  if (window.location.protocol === "about:") return;

  const searchParams = new URLSearchParams(window.location.search);
  // No need to update the URL bar if the websocket port matches the HTTP port.
  // So if we navigate to http://localhost:8081, this should by default connect to ws://localhost:8081.
  const isDefaultServer =
    window.location.host.includes(
      server.replace("ws://", "").replace("/", ""),
    ) ||
    window.location.host.includes(
      server.replace("wss://", "").replace("/", ""),
    );
  if (isDefaultServer && searchParams.has(searchParamKey)) {
    searchParams.delete(searchParamKey);
  } else if (!isDefaultServer) {
    searchParams.set(searchParamKey, server);
  }
  window.history.replaceState(
    null,
    "Viser",
    // We could use URLSearchParams.toString() to build this string, but that
    // would escape it. We're going to just not escape the string. :)
    searchParams.size === 0
      ? window.location.href.split("?")[0]
      : "?" +
          Array.from(searchParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("&"),
  );
}
