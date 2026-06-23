/** Control panel width presets, keyed by the server's `control_width` theme
 * setting. Converted to px for the dock layout (em x the panel's 16px font
 * size). */
const CONTROL_WIDTH_EM: Record<string, number> = {
  small: 16,
  medium: 20,
  large: 24,
};

export function controlWidthPx(name: string): number {
  return (CONTROL_WIDTH_EM[name] ?? 20) * 16;
}
