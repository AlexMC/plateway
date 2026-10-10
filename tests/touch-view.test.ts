import { describe, expect, it } from 'vitest';
import { pinchView, type Viewport } from '../src/editor/view-motion';

/** The app's zoom rule: `factor` times wider round `anchor`, no narrower than 300 mm. */
const zoomed = (before: Viewport, factor: number, anchor: { x: number; y: number }): Viewport => {
  const width = Math.max(300, before.width * factor), height = Math.max(300, before.height * factor);
  return { x: anchor.x - (anchor.x - before.x) * width / before.width, y: anchor.y - (anchor.y - before.y) * height / before.height, width, height };
};
/** A top view 1000 × 800 mm shown at 0.5 px/mm on a plan flipped vertically (screen y runs against world y), placed at (100, 600). */
const start: Viewport = { x: 0, y: 0, width: 1000, height: 800 };
const scale = { a: 0.5, d: -0.5 };
const toScreen = (view: Viewport, world: { x: number; y: number }) => {
  // The screen origin of the view's corner stays put while the view zooms (a `meet` viewBox keeps its letterbox).
  const sx = scale.a * start.width / view.width, sy = scale.d * start.height / view.height;
  return { x: 100 + (world.x - view.x) * sx, y: 600 + (world.y - view.y) * sy };
};
const toWorld = (screen: { x: number; y: number }) => ({ x: start.x + (screen.x - 100) / scale.a, y: start.y + (screen.y - 600) / scale.d });

describe('two-finger gestures on the top view', () => {
  it('spreading the fingers zooms in round the point between them, which stays under them', () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 200, y: 400 }, { x: 300, y: 400 }];
    const to: typeof from = [{ x: 150, y: 400 }, { x: 350, y: 400 }];
    const anchor = toWorld({ x: 250, y: 400 });
    const view = pinchView(start, scale, anchor, from, to, zoomed);
    expect(view.width).toBeCloseTo(500);
    expect(view.height).toBeCloseTo(400);
    const under = toScreen(view, anchor);
    expect(under.x).toBeCloseTo(250);
    expect(under.y).toBeCloseTo(400);
  });

  it('moving both fingers together drags the plan with them, up and down included on the flipped plan', () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 200, y: 400 }, { x: 300, y: 400 }];
    const to: typeof from = [{ x: 260, y: 440 }, { x: 360, y: 440 }];
    const anchor = toWorld({ x: 250, y: 400 });
    const view = pinchView(start, scale, anchor, from, to, zoomed);
    expect(view.width).toBeCloseTo(1000);
    const under = toScreen(view, anchor);
    expect(under.x).toBeCloseTo(310);
    expect(under.y).toBeCloseTo(440);
  });

  it('past the closest zoom the plan stops growing but still follows the fingers', () => {
    const from: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 240, y: 400 }, { x: 260, y: 400 }];
    const to: typeof from = [{ x: 0, y: 380 }, { x: 600, y: 380 }];
    const anchor = toWorld({ x: 250, y: 400 });
    const view = pinchView(start, scale, anchor, from, to, zoomed);
    expect(view.width).toBe(300);
    expect(view.height).toBe(300);
    const under = toScreen({ ...view, height: view.width * start.height / start.width }, anchor);
    expect(under.x).toBeCloseTo(300);
  });
});
