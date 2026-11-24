/** "#rrggbb" to [r, g, b], or null if the text is not a valid color. */
export function hexToRgb(
  hex: string | null | undefined,
): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** True when light text reads better than dark text on this background. The cut-off is
 *  where both text colors used by the notes have the same contrast. */
export function needsLightText(rgb: [number, number, number]): boolean {
  return luminance(rgb) < 0.2;
}
