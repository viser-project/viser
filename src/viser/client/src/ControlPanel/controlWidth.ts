/** Control panel width presets, keyed by the server's `control_width` theme
 * setting. One source of truth for both representations: the em width used by
 * the sidebar / bottom-sheet layouts, and the px width used by the dock
 * layout (em x the panel's 16px font size). */
export const CONTROL_WIDTH_EM: Record<string, number> = {
  small: 16,
  medium: 20,
  large: 24,
};

export function controlWidthEm(name: string): string {
  return `${CONTROL_WIDTH_EM[name] ?? 20}em`;
}

export function controlWidthPx(name: string): number {
  return (CONTROL_WIDTH_EM[name] ?? 20) * 16;
}
