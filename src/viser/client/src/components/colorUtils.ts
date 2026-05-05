// Utility functions for color conversions.

export type RgbTuple = [number, number, number];
export type RgbaTuple = [number, number, number, number]; // R, G, B in [0, 255], A in [0, 255].

/**
 * Convert an RGB tuple to a hex color string or handle null value
 * @param color RGB tuple, string color name, or null
 * @returns A hex color string (e.g. "#ff0000"), the original string color name, or undefined for null
 */
export function toMantineColor(
  color: [number, number, number] | string | null,
): string | undefined {
  // Handle null case.
  if (color === null) {
    return undefined;
  }

  // If color is an RGB tuple, convert to hex.
  if (Array.isArray(color)) {
    const [r, g, b] = color;
    return `#${r.toString(16).padStart(2, "0")}${g
      .toString(16)
      .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  // If it's already a string, return as is.
  return color;
}

// Convert RGB tuple to rgb() string.
// Input: RGB values in [0, 255].
export function rgbToString(rgb: RgbTuple): string {
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(
    rgb[2],
  )})`;
}

// Convert RGBA tuple to rgba() string.
// Input: RGB values in [0, 255], A in [0, 255].
// Output: CSS rgba() string with alpha in [0, 1].
export function rgbaToString(rgba: RgbaTuple): string {
  return `rgba(${Math.round(rgba[0])}, ${Math.round(rgba[1])}, ${Math.round(
    rgba[2],
  )}, ${(rgba[3] / 255).toFixed(4)})`;
}

// Parse any string to RGB tuple.
// Output: RGB values in [0, 255].
export function parseToRgb(value: string): RgbTuple | null {
  // Try to parse rgb(r, g, b) format.
  const rgbMatch = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1]),
      parseInt(rgbMatch[2]),
      parseInt(rgbMatch[3]),
    ];
  }

  // Try to parse hex format (#RGB or #RRGGBB).
  const hexMatch = value.match(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    let r, g, b;

    if (hex.length === 3) {
      // Convert #RGB to full RGB values.
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else {
      // Parse #RRGGBB format.
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
    }

    return [r, g, b];
  }

  return null;
}

// Parse any string to RGBA tuple.
// Output: RGB values in [0, 255], A in [0, 255].
export function parseToRgba(value: string): RgbaTuple | null {
  // Try to parse CSS `rgba(r, g, b, a)` format.
  const rgbaMatch = value.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (rgbaMatch) {
    return [
      parseInt(rgbaMatch[1]),
      parseInt(rgbaMatch[2]),
      parseInt(rgbaMatch[3]),
      Math.round(parseFloat(rgbaMatch[4]) * 255),
    ];
  }

  // Try to parse hex format (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA).
  const hexMatch = value.match(/^#([0-9A-Fa-f]{3,8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 4) {
      // Convert #RGBA to full RGBA values.
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        parseInt(hex[3] + hex[3], 16),
      ];
    } else if (hex.length === 8) {
      // Parse #RRGGBBAA format.
      return [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
        parseInt(hex.substring(6, 8), 16),
      ];
    }
  }

  // Try to parse RGB format and add default alpha.
  const rgbResult = parseToRgb(value);
  if (rgbResult) {
    return [...rgbResult, 255];
  }

  return null;
}

// Check if two RGB tuples are equal.
// Input: RGB values in [0, 255].
export function rgbEqual(a: RgbTuple, b: RgbTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Check if two RGBA tuples are equal.
// Input: RGB values in [0, 255], A in [0, 255].
export function rgbaEqual(a: RgbaTuple, b: RgbaTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
