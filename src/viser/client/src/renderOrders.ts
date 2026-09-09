/**
 * Draw-order tiers for the late-drawn transparents that have to composite in
 * a fixed order regardless of depth (issue #767).
 *
 * Gaussian splats render after everything else in the scene. Labels are
 * annotations, so the whole label composites over a splat cloud: background
 * quad first, glyphs on top. Keeping the tiers in one place is what enforces
 * the ordering; the e2e suite in tests/e2e/test_label_render_order.py pins
 * the visible result.
 */
export const SPLAT_RENDER_ORDER = 10_000;
export const LABEL_BACKGROUND_RENDER_ORDER = SPLAT_RENDER_ORDER + 1;
export const LABEL_TEXT_RENDER_ORDER = SPLAT_RENDER_ORDER + 2;
