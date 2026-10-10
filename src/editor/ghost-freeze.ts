/**
 * The armed ghost follows the pointer over the canvas. Reaching for the placement bar drags the ghost along the way (off the
 * open end it had snapped to), so when the pointer arrives on the bar the ghost goes back to where the pointer last rested and
 * stays there: no pointer-follow and no re-snap until the pointer is back on the canvas.
 */
/** A pointer position over the canvas (client pixels) and its event time (ms, the `event.timeStamp` clock). */
export interface PointerSample { x: number; y: number; t: number }

/** The pointer rests where it stays within `REST_PX` for `REST_MS`; the trail keeps the last `TRAIL_SAMPLES` moves. */
export const REST_MS = 220, REST_PX = 5, TRAIL_SAMPLES = 240;

/** The trail with `samples` added (oldest first), keeping the last `TRAIL_SAMPLES` by count, not age: a long rest stays the latest one. */
export function recordSamples(trail: readonly PointerSample[], samples: readonly PointerSample[]): PointerSample[] {
  return [...trail, ...samples].slice(-TRAIL_SAMPLES);
}

/**
 * Where the ghost freezes when the pointer reaches the bar at `now`: the latest sample the pointer stayed near (within
 * `REST_PX`) for `REST_MS` before moving on, else the last sample; null for an empty trail.
 */
export function frozenPoint(trail: readonly PointerSample[], now: number): PointerSample | null {
  for (let index = trail.length - 1; index >= 0; index--) {
    const at = trail[index];
    const left = trail.slice(index + 1).find(later => Math.hypot(later.x - at.x, later.y - at.y) > REST_PX);
    if ((left ? left.t : now) - at.t >= REST_MS) return at;
  }
  return trail.at(-1) ?? null;
}
