import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RACK } from '../domain/pieces/rack-teeth';
import { BRICK_TRACK } from '../domain/track';
import { portPoint, sectionGeometry, type PreviewPose } from './track-preview';

const RACK_COLOR = 0x8f6aa8, MODULE = RACK.pitch / Math.PI;
// cad/models/rack.py: tips 0.4 mm under the rail top, module-1 tooth depth (addendum m, dedendum 1.25 m), bar |y| <= 4.
const TIP = BRICK_TRACK.railTop - 0.4, ROOT = TIP - 2.25 * MODULE, BAR = 4, TOOTH = 6;

/** The rack bar and its teeth along a rack piece's world path, from its `composite_track` rack options. */
export function rackDecor(points: readonly PreviewPose[], parameters: Record<string, number>): { geometry: THREE.BufferGeometry; color: number }[] {
  const bar = sectionGeometry(points, [[-BAR, BRICK_TRACK.baseThickness], [BAR, BRICK_TRACK.baseThickness], [BAR, ROOT], [-BAR, ROOT]]);
  const distance = [0];
  for (let i = 1; i < points.length; i++)
    distance.push(distance[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z));
  const run = distance.at(-1)!, teeth: THREE.BufferGeometry[] = [];
  for (let d = parameters.rack_phase; d <= run + 1e-9; d += parameters.rack_pitch) {
    const index = Math.min(points.length - 2, Math.max(0, distance.findIndex(value => value >= d) - 1));
    const t = (d - distance[index]) / Math.max(1e-9, distance[index + 1] - distance[index]), a = points[index], b = points[index + 1];
    const at: PreviewPose = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
      heading: a.heading + (b.heading - a.heading) * t, pitch: (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * t };
    const taperIn = parameters.rack_in ? (d - (parameters.rack_in - RACK.taper)) / RACK.taper : 1;
    const taperOut = parameters.rack_out ? (run - d - (parameters.rack_out - RACK.taper)) / RACK.taper : 1;
    const height = (TIP - ROOT) * Math.min(1, Math.max(0.3, Math.min(taperIn, taperOut)));
    const tooth = new THREE.BoxGeometry(RACK.pitch / 2, TOOTH, height);
    tooth.translate(0, 0, ROOT + height / 2);
    tooth.rotateY(-(at.pitch ?? 0));
    tooth.rotateZ(at.heading);
    const base = portPoint(at, 0, 0, 0);
    tooth.translate(base.x, base.y, base.z);
    teeth.push(tooth);
  }
  return [{ geometry: bar, color: RACK_COLOR }, ...(teeth.length ? [{ geometry: mergeGeometries(teeth), color: RACK_COLOR }] : [])];
}
