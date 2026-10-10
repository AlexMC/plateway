import { useCallback, useEffect, useRef, useState } from 'react';

/** The top view's viewBox in millimetres. */
export type Viewport = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** Programmatic view changes (fit, framing, auto-widen, zoom buttons) ease over this long instead of jumping. */
export const VIEW_MOTION_MS = 320;
/**
 * The first placement frames no closer than this: an oval of 16 R40 curves and 8 straights (about 1150 × 700 mm)
 * stays in view with room around it, so the user keeps their bearings.
 */
export const FIRST_VIEW_MIN_WIDTH = 1600;
/** Auto-widen starts when a growing end comes within this share of the visible width/height of an edge… */
export const WIDEN_EDGE = 0.1;
/** …and moves the view until the end sits this far in. */
const WIDEN_COMFORT = 0.2;

export const easeInOut = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Part-way from one view to another: centres move linearly, sizes geometrically so a zoom feels even. */
export function mixViewport(from: Viewport, to: Viewport, t: number): Viewport {
  const width = from.width * (to.width / from.width) ** t, height = from.height * (to.height / from.height) ** t;
  const cx = from.x + from.width / 2 + (to.x + to.width / 2 - from.x - from.width / 2) * t;
  const cy = from.y + from.height / 2 + (to.y + to.height / 2 - from.y - from.height / 2) * t;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * The view during a two-finger gesture that began on `start` with the fingers at `from` and has them at `to` now: it zooms by
 * how far the fingers spread, round `anchor` (the world point that was between them), and pans with their midpoint, so the
 * plan stays under the fingers. `scale` is the start's screen pixels per millimetre (the screen matrix's `a` and `d`; `d` is
 * negative on the vertically flipped plan). `zoomed` is the editor's zoom, which keeps the view within its limits.
 */
export function pinchView(start: Viewport, scale: { a: number; d: number }, anchor: Point, from: [Point, Point], to: [Point, Point],
  zoomed: (before: Viewport, factor: number, anchor: Point) => Viewport): Viewport {
  const spread = ([a, b]: [Point, Point]) => Math.hypot(a.x - b.x, a.y - b.y);
  const view = zoomed(start, spread(from) / Math.max(1, spread(to)), anchor);
  const moved = { x: (to[0].x + to[1].x - from[0].x - from[1].x) / 2, y: (to[0].y + to[1].y - from[0].y - from[1].y) / 2 };
  return { ...view, x: view.x - moved.x * view.width / start.width / scale.a, y: view.y - moved.y * view.height / start.height / scale.d };
}

/** What a `meet` viewBox shows on a canvas of `aspect` (width / height): the viewBox grown, centred, to that aspect. */
export function visibleRect(view: Viewport, aspect: number): Viewport {
  if (!(aspect > 0)) return view;
  const width = Math.max(view.width, view.height * aspect), height = width / aspect;
  return { x: view.x + (view.width - width) / 2, y: view.y + (view.height - height) / 2, width, height };
}
/** The viewBox of `view`'s aspect that a `meet` canvas shows as exactly `visible`. */
function fromVisible(visible: Viewport, viewAspect: number): Viewport {
  const width = Math.min(visible.width, visible.height * viewAspect), height = width / viewAspect;
  return { x: visible.x + (visible.width - width) / 2, y: visible.y + (visible.height - height) / 2, width, height };
}

/**
 * The view after the first piece: around `keep` (the piece's ends and any furniture) with a 150 mm margin, never closer than an
 * owned oval's area (`FIRST_VIEW_MIN_WIDTH`) and never further out than `current`; kept inside the room (with the usual 100 mm
 * border) where it fits.
 */
export function firstPlacementView(current: Viewport, keep: readonly Point[], room: { width: number; height: number }): Viewport {
  const x0 = Math.min(...keep.map(point => point.x)), x1 = Math.max(...keep.map(point => point.x));
  const y0 = Math.min(...keep.map(point => point.y)), y1 = Math.max(...keep.map(point => point.y));
  const aspect = current.width / current.height;
  const width = Math.min(current.width, Math.max(FIRST_VIEW_MIN_WIDTH, x1 - x0 + 300, (y1 - y0 + 300) * aspect)), height = width / aspect;
  const place = (middle: number, size: number, extent: number) => {
    const low = -100, high = extent + 100 - size, ideal = middle - size / 2;
    return high >= low ? Math.min(high, Math.max(low, ideal)) : ideal;
  };
  return { x: place((x0 + x1) / 2, width, room.width), y: place((y0 + y1) / 2, height, room.height), width, height };
}

/**
 * Keeps a growing chain in view. `points`: the active open end (and the snapped ghost's ends). Returns null while every
 * point is more than `WIDEN_EDGE` from the visible edges. Otherwise it eases out (zooming out from the centre, then panning
 * the least) until they sit `WIDEN_COMFORT` inside and, where that still fits, the rest of the layout (`keep`) stays in view;
 * after a manual zoom it only pans, unless a point has already left the view or the points no longer fit at this zoom.
 * `aspect`: the canvas's width / height; `max`: the furthest-out view size.
 */
export function widenView(view: Viewport, points: readonly Point[], { aspect, manual, max, keep = [] }: {
  aspect: number; manual: boolean; max: { width: number; height: number }; keep?: readonly Point[];
}): Viewport | null {
  if (!points.length) return null;
  const visible = visibleRect(view, aspect), canvasAspect = visible.width / visible.height;
  const span = (list: readonly Point[]) => ({ x0: Math.min(...list.map(point => point.x)), x1: Math.max(...list.map(point => point.x)),
    y0: Math.min(...list.map(point => point.y)), y1: Math.max(...list.map(point => point.y)) });
  const ends = span(points), layout = keep.length ? span(keep) : null;
  const inside = (share: number) => ends.x0 >= visible.x + visible.width * share && ends.x1 <= visible.x + visible.width * (1 - share) &&
    ends.y0 >= visible.y + visible.height * share && ends.y1 <= visible.y + visible.height * (1 - share);
  if (inside(WIDEN_EDGE)) return null;
  /** The visible rect of this size nearest to `from` with the ends `WIDEN_COMFORT` inside (and `withLayout`, the layout just inside), or null. */
  const settle = (width: number, height: number, from: Viewport, withLayout: boolean): Viewport | null => {
    const axis = (low: number, high: number, keepLow: number, keepHigh: number, start: number, size: number) => {
      const min = Math.max(high + size * WIDEN_COMFORT, keepHigh + size * 0.02) - size, most = Math.min(low - size * WIDEN_COMFORT, keepLow - size * 0.02);
      return min <= most ? Math.min(most, Math.max(min, start)) : null;
    };
    const box = withLayout && layout ? layout : ends;
    const x = axis(ends.x0, ends.x1, box.x0, box.x1, from.x + (from.width - width) / 2, width);
    const y = axis(ends.y0, ends.y1, box.y0, box.y1, from.y + (from.height - height) / 2, height);
    return x === null || y === null ? null : { x, y, width, height };
  };
  const sizes: { width: number; height: number }[] = [];
  for (const factor of [1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
    let width = visible.width * factor, height = width / canvasAspect;
    if (width > max.width) { width = Math.max(visible.width, max.width); height = width / canvasAspect; }
    if (height > max.height) { height = Math.max(visible.height, max.height); width = height * canvasAspect; }
    sizes.push({ width, height });
    if (width <= visible.width && height <= visible.height) break;
  }
  const zoomOut = (withLayout: boolean) => sizes.reduce<Viewport | null>((found, size) => found ?? settle(size.width, size.height, visible, withLayout), null);
  // A pan alone first: after a manual zoom (while the ends are still on screen), or when the whole layout still fits.
  const pan = manual ? (inside(0) ? settle(visible.width, visible.height, visible, false) : null) : settle(visible.width, visible.height, visible, true);
  const furthest = Math.max(visible.width, Math.min(max.width, max.height * canvasAspect));
  const next = pan ?? zoomOut(!manual) ?? zoomOut(false) ??
    // At the furthest-out size and still no fit: centre on the ends.
    { x: (ends.x0 + ends.x1 - furthest) / 2, y: (ends.y0 + ends.y1 - furthest / canvasAspect) / 2, width: furthest, height: furthest / canvasAspect };
  const result = fromVisible(next, view.width / view.height);
  const same = Math.abs(result.x - view.x) < 0.5 && Math.abs(result.y - view.y) < 0.5 && Math.abs(result.width - view.width) < 0.5;
  return same ? null : result;
}

/**
 * The top view's viewBox. `setViewport` changes it at once (wheel, drag-pan); `animateTo` eases there over
 * `VIEW_MOTION_MS` (instantly when the user prefers reduced motion). `target()` is where the view is heading.
 */
export function useViewMotion(initial: () => Viewport) {
  const [viewport, setState] = useState(initial);
  const shown = useRef(viewport);
  shown.current = viewport;
  const motion = useRef<{ frame: number; to: Viewport } | null>(null);
  const stop = () => { if (motion.current) cancelAnimationFrame(motion.current.frame); motion.current = null; };
  useEffect(() => stop, []);
  const setViewport = useCallback((next: Viewport | ((prior: Viewport) => Viewport)) => { stop(); setState(next); }, []);
  const animateTo = useCallback((to: Viewport, duration = VIEW_MOTION_MS) => {
    stop();
    const from = shown.current;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) { setState(to); return; }
    // Time from the first frame: a rAF timestamp can predate this call.
    let start = -1;
    const step = (now: number) => {
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / duration);
      setState(t < 1 ? mixViewport(from, to, easeInOut(t)) : to);
      if (t < 1 && motion.current) motion.current.frame = requestAnimationFrame(step);
      else motion.current = null;
    };
    motion.current = { frame: requestAnimationFrame(step), to };
  }, []);
  const target = useCallback(() => motion.current?.to ?? shown.current, []);
  const moving = useCallback(() => motion.current !== null, []);
  return { viewport, setViewport, animateTo, target, moving };
}
