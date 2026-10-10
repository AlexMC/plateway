import * as THREE from 'three';
import type { RoutePiece } from '../domain/project';
import { FUNICULAR, FUNICULAR_MOTOR_BOX, funicularShape, funicularSlope } from '../domain/pieces/families/funicular';
import { BRICK_TRACK } from '../domain/track';
import type { Decor } from './scenic-preview';

const HALF = BRICK_TRACK.bodyWidth / 2, BASE = BRICK_TRACK.baseThickness, TOP = BRICK_TRACK.railTop;
// buffer.py stop block; funicular.py drum (flange radius, half width) and winch deck.
const BLOCK = { lip: 2, top: 6, beam: [19.2, 32] as const }, DRUM = { radius: 14, half: 9 }, DECK = 4;
const WOOD = 0xb98a56, PRINTED = 0xe7a871, BUFFER = 0xb8433a, MOTOR = 0x3c4247, DRUM_COLOR = 0xd9b44a;

/** An (a, b) profile extruded across y0..y1: a → x, b → z. */
function profile(points: readonly (readonly [number, number])[], y0: number, y1: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([a, b]) => new THREE.Vector2(a, b))),
    { depth: y1 - y0, bevelEnabled: false, steps: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y1, 0);
  return geometry;
}
function box(u0: number, u1: number, y0: number, y1: number, w0: number, w1: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(u1 - u0, y1 - y0, w1 - w0);
  geometry.translate((u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2);
  return geometry;
}

/**
 * The funicular's plank, wedge feet, stop blocks, winch drum and motor (cad/models/funicular.py) in world coordinates;
 * the track itself is drawn from the piece's steep path. Slope-frame parts: u along the plank top, w up from it.
 */
export function funicularDecor(piece: RoutePiece): Decor[] {
  const s = funicularShape(piece), c = Math.cos(s.theta), n = Math.sin(s.theta);
  const { plankT: t, seat, lip, lipH, footHalf, plankW, buffer: run, face } = FUNICULAR;
  const world = new THREE.Matrix4().makeRotationZ(piece.heading).setPosition(piece.x, piece.y, piece.z);
  const slope = new THREE.Matrix4().set(c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, s.zIn, 0, 0, 0, 1).premultiply(world);
  const at = (u: number, w: number): [number, number] => { const p = funicularSlope(s, u, w); return [p.x, p.z]; };
  // Stop block from a connector at u0, its face towards -d.
  const block = (u0: number, d: number) => {
    const [low, high] = BLOCK.beam;
    const local = [[face, BASE], [run, BASE], [run, TOP], [face - BLOCK.lip + BLOCK.top, high], [face - BLOCK.lip, high],
      [face - BLOCK.lip, low], [face, low - BLOCK.lip]] as const;
    return profile(local.map(([u, w]) => [u0 + d * u, w] as const), -HALF, HALF).applyMatrix4(slope);
  };
  // The top foot stands on its support: its profile is drawn from the support height up.
  const base = (s.plank - seat) * n, station = run + s.climb;
  const motor = FUNICULAR_MOTOR_BOX[s.motor], drumU = station + FUNICULAR.drumU, axle = FUNICULAR.axleW;
  const near = -s.side * FUNICULAR.plateBack, far = -s.side * (FUNICULAR.plateBack + motor.length);
  const drum = new THREE.CylinderGeometry(DRUM.radius, DRUM.radius, 2 * DRUM.half, 32);
  drum.translate(drumU, 0, axle);
  return [
    { geometry: box(0, s.plank, -plankW / 2, plankW / 2, -t, 0).applyMatrix4(slope), color: WOOD },
    { geometry: profile([[at(-lip, -t + lipH)[0], 0], [at(seat, -t)[0], 0], at(seat, -t), at(0, -t), at(0, -t + lipH),
      at(-lip, -t + lipH)], -footHalf, footHalf).applyMatrix4(world), color: PRINTED },
    { geometry: profile([[at(s.plank - seat, -t)[0], base], [at(s.plank, -t)[0], base], at(s.plank, -t), at(s.plank - seat, -t)],
      -footHalf, footHalf).applyMatrix4(world), color: PRINTED },
    { geometry: block(run, -1), color: BUFFER },
    { geometry: block(station, 1), color: BUFFER },
    { geometry: box(station + run, s.plank, -HALF, HALF, 0, DECK).applyMatrix4(slope), color: PRINTED },
    { geometry: drum.applyMatrix4(slope), color: DRUM_COLOR },
    { geometry: box(drumU - motor.width / 2, drumU + motor.width / 2, Math.min(near, far), Math.max(near, far),
      axle - motor.height / 2, axle + motor.height / 2).applyMatrix4(slope), color: MOTOR }
  ];
}
