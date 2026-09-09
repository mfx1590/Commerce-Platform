import { describe, expect, it } from 'vitest';
import { HEAD_BOX, TIP_COLUMN } from '@/components/rail/rail.config';
import {
  REST_POSE,
  approximateLength,
  bezierPoint,
  controlPoints,
  crownAnchor,
  eyePoint,
  focusRing,
  headAngle,
  serpentPath,
  serpentShape,
  tipPoint,
  tonguePath,
  type Pose,
} from '@/components/rail/serpent-geometry';

const moving: Pose = { timeMs: 1234, lift: 0, gaze: 0, motion: true };

describe('serpent geometry: where the serpents go', () => {
  it('roots every serpent inside the head box, on the crown', () => {
    for (const count of [1, 2, 5, 7]) {
      for (let index = 0; index < count; index += 1) {
        const anchor = crownAnchor(index, count);
        expect(anchor.x).toBeGreaterThanOrEqual(HEAD_BOX.x);
        expect(anchor.x).toBeLessThanOrEqual(HEAD_BOX.x + HEAD_BOX.width);
        expect(anchor.y).toBeGreaterThanOrEqual(HEAD_BOX.y);
        expect(anchor.y).toBeLessThanOrEqual(HEAD_BOX.y + HEAD_BOX.height);
      }
    }
  });

  it('spreads the heads evenly down the label column, centred, never further apart than maxGap', () => {
    const tips = [0, 1, 2, 3].map((index) => tipPoint(index, 4));
    expect(tips.map((tip) => tip.x)).toEqual([286, 286, 286, 286]);
    const gaps = tips.slice(1).map((tip, index) => tip.y - (tips[index]?.y ?? 0));
    expect(new Set(gaps.map((gap) => gap.toFixed(3))).size).toBe(1);
    expect(gaps[0]).toBe(TIP_COLUMN.maxGap);
    // Centred: as much column above the first head as below the last.
    expect((tips[0]?.y ?? 0) - TIP_COLUMN.top).toBeCloseTo(
      TIP_COLUMN.bottom - (tips[3]?.y ?? 0),
      6,
    );
  });

  it('fills the column when there are enough sections (seven, the store view)', () => {
    const tips = Array.from({ length: 7 }, (_, index) => tipPoint(index, 7));
    expect(tips[0]?.y).toBe(TIP_COLUMN.top);
    expect(tips[6]?.y).toBe(TIP_COLUMN.bottom);
  });

  it('keeps two sections a hand apart near the head instead of at the far ends', () => {
    const [first, second] = [tipPoint(0, 2), tipPoint(1, 2)];
    expect((second?.y ?? 0) - (first?.y ?? 0)).toBe(TIP_COLUMN.maxGap);
    expect(first?.y).toBeGreaterThan(TIP_COLUMN.top);
    expect(second?.y).toBeLessThan(TIP_COLUMN.bottom);
  });

  it('puts a lone serpent in the middle rather than at the top', () => {
    expect(tipPoint(0, 1).y).toBe((TIP_COLUMN.top + TIP_COLUMN.bottom) / 2);
  });

  it('draws one cubic from the crown to the tip', () => {
    const shape = serpentShape(0, 3);
    const path = serpentPath(shape, REST_POSE);
    expect(path).toMatch(/^M [-\d.]+ [-\d.]+ C [-\d.]+ [-\d.]+, [-\d.]+ [-\d.]+, [-\d.]+ [-\d.]+$/);
    expect(path.endsWith(`, ${shape.tip.x.toFixed(1)} ${shape.tip.y.toFixed(1)}`)).toBe(true);
    expect(path.startsWith(`M ${shape.anchor.x.toFixed(1)} ${shape.anchor.y.toFixed(1)}`)).toBe(
      true,
    );
  });
});

describe('serpent geometry: motion', () => {
  it('is perfectly still at rest — the reduced-motion contract', () => {
    const shape = serpentShape(1, 3);
    const a = controlPoints(shape, { ...REST_POSE, timeMs: 0 });
    const b = controlPoints(shape, { ...REST_POSE, timeMs: 99_999 });
    expect(a).toEqual(b);
    // Gaze is ignored too when motion is off.
    expect(controlPoints(shape, { ...REST_POSE, gaze: 0.5 })).toEqual(a);
  });

  it('sways with time when motion is on, and never more than the brief allows', () => {
    const shape = serpentShape(1, 3);
    const still = controlPoints(shape, REST_POSE);
    let maxDelta = 0;
    for (let t = 0; t < 20_000; t += 97) {
      const { c1, c2 } = controlPoints(shape, { ...moving, timeMs: t });
      maxDelta = Math.max(
        maxDelta,
        Math.abs(c1.x - still.c1.x),
        Math.abs(c1.y - still.c1.y),
        Math.abs(c2.x - still.c2.x),
        Math.abs(c2.y - still.c2.y),
      );
    }
    expect(maxDelta).toBeGreaterThan(0);
    // Two sine terms of 9 and 7 px can add up to 16 on one axis; nothing beyond that.
    expect(maxDelta).toBeLessThanOrEqual(16);
  });

  it('lifts the curve upward toward the pointer', () => {
    const shape = serpentShape(2, 4);
    const rest = controlPoints(shape, REST_POSE);
    const lifted = controlPoints(shape, { ...REST_POSE, lift: 1 });
    expect(lifted.c1.y).toBeLessThan(rest.c1.y);
    expect(lifted.c2.y).toBeLessThan(rest.c2.y);
  });

  it('leans with the gaze only when motion is on', () => {
    const shape = serpentShape(0, 2);
    const down = controlPoints(shape, { ...moving, timeMs: 0, gaze: 0.5 });
    const up = controlPoints(shape, { ...moving, timeMs: 0, gaze: -0.5 });
    expect(down.c1.y).toBeGreaterThan(up.c1.y);
  });
});

describe('serpent geometry: the head, eye, tongue and focus ring', () => {
  it('points the head along the curve tangent at the tip', () => {
    const shape = serpentShape(0, 3);
    const { c2 } = controlPoints(shape, REST_POSE);
    const expected = (Math.atan2(shape.tip.y - c2.y, shape.tip.x - c2.x) * 180) / Math.PI;
    expect(headAngle(shape, REST_POSE)).toBeCloseTo(expected, 6);
  });

  it('keeps the eye within a few units of the tip and the tongue ahead of it', () => {
    const tip = { x: 286, y: 400 };
    const eye = eyePoint(tip, 0);
    expect(Math.hypot(eye.x - tip.x, eye.y - tip.y)).toBeCloseTo(4, 6);
    expect(tonguePath(tip, 0)).toBe('M 296.0 400.0 L 298.0 400.0 l 3 -2 m -3 2 l 3 2');
  });

  it('sizes the focus ring to the label so longer names get longer rings', () => {
    const short = focusRing({ x: 286, y: 120 }, 'BI');
    const long = focusRing({ x: 286, y: 120 }, 'Onboarding');
    expect(long.width).toBeGreaterThan(short.width);
    expect(short.x).toBe(270);
    expect(short.height).toBe(28);
  });
});

describe('serpent geometry: arc length', () => {
  it('samples the cubic to a length longer than the chord and stable across sample counts', () => {
    const shape = serpentShape(3, 5);
    const chord = Math.hypot(shape.tip.x - shape.anchor.x, shape.tip.y - shape.anchor.y);
    const coarse = approximateLength(shape, REST_POSE, 8);
    const fine = approximateLength(shape, REST_POSE, 256);
    expect(fine).toBeGreaterThan(chord);
    expect(Math.abs(fine - coarse) / fine).toBeLessThan(0.02);
  });

  it('evaluates the bezier at its ends exactly', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 5 };
    expect(bezierPoint(a, { x: 3, y: 9 }, { x: 7, y: -4 }, b, 0)).toEqual(a);
    expect(bezierPoint(a, { x: 3, y: 9 }, { x: 7, y: -4 }, b, 1)).toEqual(b);
  });
});
