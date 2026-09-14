/**
 * The Medusa rail's fixed numbers, in one plain module (no `'use client'`, no React) so the
 * server-side shell, the client rail and the unit tests all read the same values. Geometry is in
 * SVG user units of the rail's viewBox; timings are milliseconds unless the name says otherwise.
 * Behaviour reference: docs/design/medusa-rail-prototype.html.
 */

export const RAIL_VIEWBOX = { width: 400, height: 900 } as const;

/** Where the head artwork sits in the viewBox; the crown roots below are fractions of this box. */
export const HEAD_BOX = { x: -46, y: 118, width: 292, height: 478 } as const;

/** Static asset (`public/medusa-face.jpg`, ≤ 120 KB). */
export const HEAD_ASSET = '/medusa-face.jpg';

/**
 * Anchors along the coiled hair on the crown's right edge, high on the crown first and then down
 * the back of the head, so the procedural serpents read as continuing the drawn ones.
 */
export const CROWN_ROOTS: readonly (readonly [number, number])[] = [
  [0.6, 0.05],
  [0.78, 0.08],
  [0.92, 0.15],
  [0.97, 0.27],
  [0.95, 0.42],
  [0.93, 0.62],
  [0.9, 0.78],
];

/**
 * The column the serpent heads land in; labels sit just right of it. Heads are at most `maxGap`
 * apart and the block is centred, so two sections sit near the head rather than at the far ends.
 */
export const TIP_COLUMN = { x: 286, top: 120, bottom: 800, maxGap: 120 } as const;
export const LABEL_OFFSET = { x: 20, y: 4.5 } as const;
/** Average advance of the 13 px label face, for the focus ring — measured text is not available in jsdom. */
export const LABEL_CHAR_WIDTH = 7.4;

export const STROKE = { outer: 12, body: 7, scales: 2.5, liftExtra: 2 } as const;

export const MOTION = {
  /** Rest sway amplitudes (two sine terms, ≤ 9 px as the brief says). */
  swayPx: 9,
  sway2Px: 7,
  /** How fast a serpent lifts toward its target each frame (0..1). */
  liftEase: 0.12,
  /** Load sequence: the head surfaces, then serpents draw themselves out of the crown. */
  introHeadMs: 900,
  introStaggerMs: 160,
  introDrawMs: 1100,
  introTailMs: 1500,
  /** Gaze: how far the head and control points lean toward the pointer. */
  gazePx: 40,
} as const;

export const MOTES = { count: 70 } as const;

export const STORAGE = {
  /** localStorage: '1' list view, '0' serpents; unset means "decide from the device". */
  listView: 'medusa-list',
  /** sessionStorage: the load sequence plays once per session. */
  introSeen: 'medusa-intro',
} as const;

/** Under this width the rail becomes a band above the content (the brief's 860 px / 520 px). */
export const RAIL_BREAKPOINT_PX = 860;
export const RAIL_BAND_HEIGHT_PX = 520;
