/**
 * Where each serpent goes, as pure arithmetic.
 *
 * Everything the rail draws — the bezier from the crown to the label column, the head's angle,
 * the eye, the tongue, the focus ring and the arc length the load sequence needs — is computed
 * here from numbers, never read back from the DOM. The prototype used `getTotalLength` and
 * `getPointAtLength`, which jsdom does not implement; deriving the same values from the curve
 * itself makes the rail testable and keeps the animation loop off the layout engine.
 */

import {
  CROWN_ROOTS,
  HEAD_BOX,
  LABEL_CHAR_WIDTH,
  LABEL_OFFSET,
  MOTION,
  TIP_COLUMN,
} from './rail.config';

export interface Point {
  x: number;
  y: number;
}

export interface SerpentShape {
  index: number;
  /** Where the serpent leaves the crown. */
  anchor: Point;
  /** Where its head lands; the label sits to the right. */
  tip: Point;
  /** Per-serpent phase so the rest sway is independent. */
  phase: number;
}

export interface Pose {
  /** Animation clock, ms. Ignored when `motion` is false. */
  timeMs: number;
  /** 0 = at rest, 1 = fully lifted (hover or active). */
  lift: number;
  /** Pointer's vertical position relative to the rail, −0.5..0.5; 0 when unknown. */
  gaze: number;
  /** False under `prefers-reduced-motion`: no sway, no gaze. */
  motion: boolean;
}

export const REST_POSE: Pose = { timeMs: 0, lift: 0, gaze: 0, motion: false };

/** The crown root for serpent `index` of `count`, spread over the roots from brow to nape. */
export function crownAnchor(index: number, count: number): Point {
  const last = CROWN_ROOTS.length - 1;
  const root = count <= 1 ? CROWN_ROOTS[2] : CROWN_ROOTS[Math.round((index * last) / (count - 1))];
  const [u, v] = root ?? CROWN_ROOTS[0] ?? [0.6, 0.05];
  return { x: HEAD_BOX.x + HEAD_BOX.width * u, y: HEAD_BOX.y + HEAD_BOX.height * v };
}

/**
 * Heads land evenly down the label column, never more than `maxGap` apart, the block centred: a
 * single serpent lands in the middle, seven fill the column, two sit a hand apart near the head.
 */
export function tipPoint(index: number, count: number): Point {
  const span = TIP_COLUMN.bottom - TIP_COLUMN.top;
  const gap = count <= 1 ? 0 : Math.min(TIP_COLUMN.maxGap, span / (count - 1));
  const blockTop = TIP_COLUMN.top + (span - gap * Math.max(0, count - 1)) / 2;
  return { x: TIP_COLUMN.x, y: blockTop + gap * index };
}

export function serpentShape(index: number, count: number): SerpentShape {
  return {
    index,
    anchor: crownAnchor(index, count),
    tip: tipPoint(index, count),
    phase: index * 1.3,
  };
}

export function controlPoints(shape: SerpentShape, pose: Pose): { c1: Point; c2: Point } {
  const { anchor: a, tip: p, phase } = shape;
  const sway = pose.motion ? Math.sin(pose.timeMs * 0.0012 + phase) * MOTION.swayPx : 0;
  const sway2 = pose.motion ? Math.cos(pose.timeMs * 0.0009 + phase * 1.7) * MOTION.sway2Px : 0;
  const gaze = pose.motion ? pose.gaze * MOTION.gazePx : 0;
  const c1 = { x: a.x + 90 + sway, y: a.y - 40 - pose.lift * 22 + sway2 + gaze };
  const c2 = {
    x: p.x - 90 - sway2,
    y: p.y + 30 * (shape.index % 2 === 1 ? 1 : -1) - pose.lift * 18 + sway,
  };
  return { c1, c2 };
}

const fixed = (n: number): string => n.toFixed(1);

/** The SVG path: one cubic from the crown to the tip. */
export function serpentPath(shape: SerpentShape, pose: Pose): string {
  const { c1, c2 } = controlPoints(shape, pose);
  const { anchor: a, tip: p } = shape;
  return `M ${fixed(a.x)} ${fixed(a.y)} C ${fixed(c1.x)} ${fixed(c1.y)}, ${fixed(c2.x)} ${fixed(c2.y)}, ${fixed(p.x)} ${fixed(p.y)}`;
}

export function bezierPoint(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/**
 * The head's rotation in degrees: the curve's tangent at its end, which for a cubic is the
 * direction from the last control point to the tip.
 */
export function headAngle(shape: SerpentShape, pose: Pose): number {
  const { c2 } = controlPoints(shape, pose);
  const dx = shape.tip.x - c2.x;
  const dy = shape.tip.y - c2.y;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The gold eye sits just off the head's centre line, on the upper side. */
export function eyePoint(tip: Point, angleDeg: number): Point {
  return {
    x: tip.x + 4 * Math.cos(rad(angleDeg - 55)),
    y: tip.y + 4 * Math.sin(rad(angleDeg - 55)),
  };
}

/** A forked line ahead of the snout; shown on hover only. */
export function tonguePath(tip: Point, angleDeg: number): string {
  const from = { x: tip.x + 10 * Math.cos(rad(angleDeg)), y: tip.y + 10 * Math.sin(rad(angleDeg)) };
  const to = { x: tip.x + 12 * Math.cos(rad(angleDeg)), y: tip.y + 12 * Math.sin(rad(angleDeg)) };
  return `M ${fixed(from.x)} ${fixed(from.y)} L ${fixed(to.x)} ${fixed(to.y)} l 3 -2 m -3 2 l 3 2`;
}

/** Arc length by sampling — accurate to well under a unit at 32 samples for these gentle curves. */
export function approximateLength(shape: SerpentShape, pose: Pose, samples = 32): number {
  const { c1, c2 } = controlPoints(shape, pose);
  let length = 0;
  let previous = shape.anchor;
  for (let i = 1; i <= samples; i += 1) {
    const point = bezierPoint(shape.anchor, c1, c2, shape.tip, i / samples);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return length;
}

export function labelPosition(tip: Point): Point {
  return { x: tip.x + LABEL_OFFSET.x, y: tip.y + LABEL_OFFSET.y };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visible focus ring around head + label (the brief: "visible focus ring at the label"). */
export function focusRing(tip: Point, label: string): Box {
  const textWidth = label.length * LABEL_CHAR_WIDTH;
  return { x: tip.x - 16, y: tip.y - 14, width: 22 + 16 + textWidth + 8, height: 28 };
}
