import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COMPOSITE_FAMILY, partUnderside } from '../domain/pieces';
import { gaugeLayout, type GaugeLayout } from '../domain/gauges';
import { BRICK_TRACK } from '../domain/track';
import connector from './brick-end-preview.json';
import narrowConnector from './narrow-end-preview.json';

/** `roll`: banked track, + raises the right rail; the preview rolls the section about the centreline datum. */
export type PreviewPose = { x: number; y: number; z: number; heading: number; pitch?: number; roll?: number };
type StationedPreviewPose = PreviewPose & { station: number };
export const connectorOutlines = [connector.outlines, connector.opposite.outlines] as const;
/** Narrow ends (cad/generate_gauge_preview.py): the accepted central clip on the 6-stud half tie. */
export const narrowConnectorOutlines = [narrowConnector.outlines, narrowConnector.opposite.outlines] as const;
const STANDARD = gaugeLayout('standard');

/** Local x follows the port, y is lateral, z is above the underside datum. */
export function portPoint(at: PreviewPose, x: number, y: number, z = 0): PreviewPose {
  if (at.roll) [y, z] = [y * Math.cos(at.roll) + z * Math.sin(at.roll), z * Math.cos(at.roll) - y * Math.sin(at.roll)];
  const pitch = at.pitch ?? 0, c = Math.cos(at.heading), s = Math.sin(at.heading);
  const forward = x * Math.cos(pitch) - z * Math.sin(pitch);
  return { ...at, x: at.x + c * forward - s * y, y: at.y + s * forward + c * y,
    z: at.z + x * Math.sin(pitch) + z * Math.cos(pitch) };
}

export function connectorPorts(points: readonly PreviewPose[]): [PreviewPose, PreviewPose] {
  const start = points[0], end = points[points.length - 1];
  return [start, { ...end, heading: end.heading + Math.PI, pitch: -(end.pitch ?? 0), ...(end.roll ? { roll: -end.roll } : {}) }];
}

/** Nominal planning blend only: rigid accepted contacts, approximate centre path. */
export function connectorCentre(points: readonly PreviewPose[], run: number): StationedPreviewPose[] {
  const [start, end] = connectorPorts(points), root = connector.endLength;
  const first = { ...portPoint(start, root, 0), station: root * Math.cos(start.pitch ?? 0) };
  const last = { ...portPoint(end, root, 0), station: run - root * Math.cos(end.pitch ?? 0) };
  last.heading -= Math.PI;
  last.pitch = -(last.pitch ?? 0);
  if (last.roll) last.roll = -last.roll;
  const knots = [first, ...points.map((point, index) => ({ ...point, station: run * index / (points.length - 1) }))
    .slice(1, -1).filter(point =>
    Math.hypot(point.x - start.x, point.y - start.y, point.z - start.z) > root * 2 &&
    Math.hypot(point.x - end.x, point.y - end.y, point.z - end.z) > root * 2), last];
  const result: StationedPreviewPose[] = [first];
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const tangent = (p: PreviewPose) => [Math.cos(p.heading) * Math.cos(p.pitch ?? 0),
      Math.sin(p.heading) * Math.cos(p.pitch ?? 0), Math.sin(p.pitch ?? 0)];
    const u = tangent(a), v = tangent(b);
    for (let step = 1; step <= 3; step++) {
      const t = step / 3, h0 = 2*t*t*t - 3*t*t + 1, h1 = t*t*t - 2*t*t + t;
      const h2 = -2*t*t*t + 3*t*t, h3 = t*t*t - t*t;
      const coordinate = (axis: 'x' | 'y' | 'z', index: number) =>
        h0*a[axis] + h1*length*u[index] + h2*b[axis] + h3*length*v[index];
      result.push({ x: coordinate('x', 0), y: coordinate('y', 1), z: coordinate('z', 2),
        station: a.station + (b.station - a.station) * t,
        heading: a.heading + Math.atan2(Math.sin(b.heading-a.heading), Math.cos(b.heading-a.heading))*t,
        pitch: (a.pitch ?? 0) + ((b.pitch ?? 0)-(a.pitch ?? 0))*t,
        ...(a.roll || b.roll ? { roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0))*t } : {}) });
    }
  }
  return result;
}

/** Interior stations where fit cuts a composite piece into bed-sized parts (each part is its segments' length). */
export function partStations(parts: readonly { sectionId: string; family: string; parameters: Record<string, number> }[], pieceId: string): number[] {
  const own = parts.filter(part => part.sectionId === pieceId && part.family === COMPOSITE_FAMILY);
  const stations: number[] = [];
  let station = 0;
  for (const part of own.slice(0, -1)) {
    for (let i = 0; i < part.parameters.segments; i++) station += part.parameters[`s${i}_len`];
    stations.push(station);
  }
  return stations;
}

/** World height of each of the piece's printed parts' flat underside (graded parts print as wedges down to it), in part order. */
export function partUndersides(parts: readonly { sectionId: string; family: string; parameters: Record<string, number>; pose: { z: number } }[], pieceId: string): number[] {
  return parts.filter(part => part.sectionId === pieceId && part.family === COMPOSITE_FAMILY).map(part => partUnderside(part.parameters, part.pose.z));
}

/** `points` cut at plan-view distances along them; each cut pose (interpolated) ends one piece and starts the next. */
export function splitPath<T extends PreviewPose>(points: readonly T[], stations: readonly number[]): T[][] {
  if (!stations.length) return [[...points]];
  const pieces: T[][] = [];
  let current: T[] = [points[0]], travelled = 0, next = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    while (next < stations.length && stations[next] < travelled + length - 1e-6) {
      const t = Math.max(0, (stations[next] - travelled) / length);
      const cut = { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
        heading: a.heading + Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)) * t,
        pitch: (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * t,
        ...(a.roll || b.roll ? { roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * t } : {}) };
      if (t > 0) current.push(cut);
      pieces.push(current); current = [cut]; next++;
    }
    travelled += length;
    current.push(b);
  }
  pieces.push(current);
  return pieces.filter(piece => piece.length > 1);
}

/** LDraw 53400 places rigid straight-track ties at equal 5.625° steps; every other piece
 * keeps the 32 mm pitch from each end with any residual in the central gap(s). */
export type TieLayout = 'modular' | 'official-curve';

/** Only the profile's official R40 22.5° curve is equal-angle; printed wide/odd curves stay modular. */
export function curveTieLayout(radius: number, sweep: number): TieLayout {
  const { officialCurve } = BRICK_TRACK;
  return Math.abs(radius - officialCurve.radius) < 1e-6 &&
    Math.abs(Math.abs(sweep) * 180 / Math.PI - officialCurve.sweepDegrees) < 1e-6 ? 'official-curve' : 'modular';
}

/** Source-sized ties in nominal stations: end half ties first/last, full ties between. */
export function tieIntervals(run: number, layout: TieLayout = 'modular'): [number, number][] {
  const { tiePitch, tieWidth, endTieWidth, officialCurve } = BRICK_TRACK;
  const centers: number[] = [];
  if (layout === 'official-curve') {
    const steps = Math.round(officialCurve.sweepDegrees / officialCurve.tiePitchDegrees);
    for (let index = 1; index < steps; index++) centers.push(run * index / steps);
  } else {
    const count = Math.max(0, Math.floor((run - tiePitch + 1e-9) / tiePitch));
    for (let index = 1; index <= Math.floor(count / 2); index++) {
      centers.push(tiePitch * index, run - tiePitch * index);
    }
    if (count % 2) centers.push(run / 2);
    centers.sort((a, b) => a - b);
  }
  return [[0, endTieWidth], ...centers.map(center =>
    [center - tieWidth / 2, center + tieWidth / 2] as [number, number]), [run - endTieWidth, run]];
}

function atStation(points: readonly StationedPreviewPose[], station: number): PreviewPose {
  const index = points.findIndex(point => point.station >= station);
  if (index === 0) return points[0];
  if (index < 0) return points[points.length - 1];
  const a = points[index - 1], b = points[index];
  const t = (station - a.station) / (b.station - a.station);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    heading: a.heading + Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)) * t,
    pitch: (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * t,
    ...(a.roll || b.roll ? { roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * t } : {}) };
}

function stationBand(points: readonly StationedPreviewPose[], start: number, end: number): PreviewPose[] {
  return [atStation(points, start), ...points.filter(point => point.station > start && point.station < end),
    atStation(points, end)];
}

/** A full tie's centre band: nominal stations, or one rigid rectangle on the official curve. */
function fullTieBand(points: readonly StationedPreviewPose[], start: number, end: number, layout: TieLayout): PreviewPose[] {
  if (layout === 'modular') return stationBand(points, start, end);
  const center = atStation(points, (start + end) / 2), half = (end - start) / 2;
  return [portPoint(center, -half, 0), portPoint(center, half, 0)];
}

/** One tie-local stud row per column set at each end half tie; these carry the accepted brick grip. */
export function endStudPoses(samples: readonly PreviewPose[],
  halfTieColumns: readonly number[] = STANDARD.studs): PreviewPose[] {
  const attachment = BRICK_TRACK.brickAttachment, top = attachment.studBaseZ + attachment.studHeight;
  return connectorPorts(samples).flatMap(port => halfTieColumns.map(offset =>
    portPoint(portPoint(port, attachment.studRowOffset, 0), 0, offset, top)));
}

/** Rigid tie-local rows preserve the brick grid even on curved routes. Half ties may carry
 * fewer columns than full ties (LDraw 64022 flex: no ±12 studs); both default to the gauge's columns. */
export function studPoses(samples: readonly PreviewPose[], run: number, layout: TieLayout = 'modular',
  halfTieColumns?: readonly number[], across: GaugeLayout = STANDARD): PreviewPose[] {
  const attachment = BRICK_TRACK.brickAttachment, middle = connectorCentre(samples, run);
  const top = attachment.studBaseZ + attachment.studHeight;
  const studs = endStudPoses(samples, halfTieColumns ?? across.studs);
  for (const [start, end] of tieIntervals(run, layout).slice(1, -1)) {
    const center = atStation(middle, (start + end) / 2);
    for (const offset of [-attachment.studRowOffset, attachment.studRowOffset]) {
      studs.push(...across.studs.map(lateral => portPoint(portPoint(center, offset, 0), 0, lateral, top)));
    }
  }
  return studs;
}

/** Fast-print pieces: a lighter, yellower take on the printed orange (0xe7a871), in 3D and Test drive. */
export const FAST_PRINT_COLOR = 0xf3d77e;

/** Fast-print gauge braces: 2.8 mm along the track, spanning between the solid rail supports (GaugeLayout.braceSpan).
 * Ramps print on their side, so theirs are full-width sleepers at most `rampPitch` apart. */
export const LITE_BRACE = { width: 2.8, rampPitch: 16 } as const;

/** Brace stations (cad/models/lite.py brace_layout): the full-tie centres; ramps add evenly spaced
 * stations so neighbouring braces and the end-tie inner walls are at most `rampPitch` apart. */
export function braceStations(run: number, layout: TieLayout = 'modular', ramp = false): number[] {
  const centres = tieIntervals(run, layout).slice(1, -1).map(([start, end]) => (start + end) / 2);
  if (!ramp) return centres;
  const anchors = [BRICK_TRACK.endTieWidth, ...centres, run - BRICK_TRACK.endTieWidth];
  const between = anchors.slice(1).flatMap((high, index) => {
    const low = anchors[index], count = Math.ceil((high - low) / LITE_BRACE.rampPitch - 1e-9);
    return Array.from({ length: Math.max(0, count - 1) }, (_, k) => low + (high - low) * (k + 1) / count);
  });
  return [...centres, ...between].sort((a, b) => a - b);
}

/** Fast print keeps the end ties and rails; each brace is one rigid band at its station. */
export function braceBands(points: readonly StationedPreviewPose[], run: number, layout: TieLayout = 'modular', ramp = false): PreviewPose[][] {
  return braceStations(run, layout, ramp).map(station => {
    const center = atStation(points, station);
    return [portPoint(center, -LITE_BRACE.width / 2, 0), portPoint(center, LITE_BRACE.width / 2, 0)];
  });
}

/** `across`: the gauge's brace span (full-width sleepers on ramps). */
export function braceGeometry(points: readonly StationedPreviewPose[], run: number, layout: TieLayout = 'modular', ramp = false,
  across: GaugeLayout = STANDARD): THREE.BufferGeometry | null {
  const parts = braceBands(points, run, layout, ramp).map(([a, b]) => {
    const center = { ...a, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const box = new THREE.BoxGeometry(LITE_BRACE.width, ramp ? across.bodyWidth : across.braceSpan, BRICK_TRACK.baseThickness).toNonIndexed();
    box.translate(0, 0, BRICK_TRACK.baseThickness / 2);
    box.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(center.x, center.y, center.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-(center.roll ?? 0), -(center.pitch ?? 0), center.heading, 'ZYX')),
      new THREE.Vector3(1, 1, 1)));
    return box;
  });
  if (!parts.length) return null;
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

/** Clip bands in nominal horizontal/arc stations, not stretched 3D path distance. */
export function tieBands(points: readonly StationedPreviewPose[], run: number, layout: TieLayout = 'modular'): PreviewPose[][] {
  const intervals = tieIntervals(run, layout), bands: PreviewPose[][] = [];
  for (const [index, [start, end]] of intervals.entries()) {
    if (index > 0 && index < intervals.length - 1) {
      bands.push(fullTieBand(points, start, end, layout));
      continue;
    }
    const low = Math.max(start, points[0].station), high = Math.min(end, points[points.length - 1].station);
    if (high > low) bands.push(stationBand(points, low, high));
  }
  return bands;
}

/** Accepted end contacts; flex half ties omit the columns absent from LDraw 64022; `narrow`: the narrow-gauge end. */
export function connectorGeometry(end: 0 | 1, flex = false, narrow = false): THREE.BufferGeometry {
  const variant = narrow ? narrowConnector : flex ? connector.flex : connector;
  const source = end === 0 ? variant : variant.opposite;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
  geometry.setIndex(source.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Sweep the source cross section; all heights are relative to the underside. */
export function sectionGeometry(points: readonly PreviewPose[], section: readonly number[][], offset = 0): THREE.BufferGeometry {
  const count = section.length, vertices = new Float32Array(points.length * count * 3);
  const indices: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < count; j++) {
      const point = portPoint(points[i], 0, offset + section[j][0], section[j][1]);
      const index = (i * count + j) * 3;
      vertices[index] = point.x; vertices[index+1] = point.y; vertices[index+2] = point.z;
      if (i) {
        const a = (i-1)*count+j, b = (i-1)*count+(j+1)%count, c = i*count+j, d = i*count+(j+1)%count;
        indices.push(a,d,b,a,c,d);
      }
    }
  }
  const caps = THREE.ShapeUtils.triangulateShape(section.map(([y,z]) => new THREE.Vector2(y,z)), []);
  const end = (points.length-1)*count;
  for (const [a,b,c] of caps) indices.push(c,b,a,end+a,end+b,end+c);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The solid base of a graded part printed as a wedge (cad/models/composite.py): vertical sides `halfWidth` either side of the
 * path from its underside down to the part's one flat underside at height `base`, closed at both ends.
 */
export function wedgeGeometry(points: readonly PreviewPose[], base: number, halfWidth: number): THREE.BufferGeometry {
  const vertices = new Float32Array(points.length * 12), indices: number[] = [];
  points.forEach((point, i) => {
    const cos = Math.cos(point.heading), sin = Math.sin(point.heading);
    [[halfWidth, point.z], [-halfWidth, point.z], [-halfWidth, base], [halfWidth, base]].forEach(([y, z], j) =>
      vertices.set([point.x - sin * y, point.y + cos * y, z], (i * 4 + j) * 3));
    if (i) for (let j = 0; j < 4; j++) {
      const a = (i-1)*4+j, b = (i-1)*4+(j+1)%4, c = i*4+j, d = i*4+(j+1)%4;
      indices.push(a,d,b,a,c,d);
    }
  });
  const end = (points.length-1)*4;
  indices.push(2,1,0,3,2,0,end,end+1,end+2,end,end+2,end+3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Real open bays, not a solid bed: only the short tie's vertical bend is planarized. Ribs line each bay's
 * inner edges and pins sit under the outer stud columns, as in both track profiles. */
export function tieGeometry(points: readonly StationedPreviewPose[], run: number, layout: TieLayout = 'modular',
  across: GaugeLayout = STANDARD): THREE.BufferGeometry | null {
  const attachment = BRICK_TRACK.brickAttachment, halfWidth = across.bodyWidth / 2, ribWidth = attachment.ribWidth;
  const ribs = across.cavities.flatMap(([low, high]) =>
    [...(high > 0 ? [[low, low + ribWidth]] : []), ...(low < 0 ? [[high - ribWidth, high]] : [])]);
  const pin = Math.max(...across.studs.map(Math.abs)), pins = [-pin, pin];
  const parts: THREE.BufferGeometry[] = [];
  for (const [start, end] of tieIntervals(run, layout).slice(1, -1)) {
    const pose = atStation(points, (start + end) / 2);
    const frame = new THREE.Matrix4().compose(new THREE.Vector3(pose.x, pose.y, pose.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-(pose.roll ?? 0), -(pose.pitch ?? 0), pose.heading, 'ZYX')),
      new THREE.Vector3(1, 1, 1));
    const inverse = frame.clone().invert(), band = fullTieBand(points, start, end, layout);
    const edge = (offset: number) => band.map(point => {
      const world = portPoint(point, 0, offset);
      const local = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(inverse);
      return new THREE.Vector2(local.x, local.y);
    });
    const outline = [...edge(-halfWidth), ...edge(halfWidth).reverse()];
    const add = (geometry: THREE.BufferGeometry) => {
      geometry.applyMatrix4(frame);
      if (geometry.index) {
        parts.push(geometry.toNonIndexed());
        geometry.dispose();
      } else parts.push(geometry);
    };
    const extrude = (shape: THREE.Shape, depth: number, bottom = 0) => {
      const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
      geometry.translate(0, 0, bottom);
      add(geometry);
    };
    extrude(new THREE.Shape(outline), BRICK_TRACK.baseThickness - attachment.cavityDepth, attachment.cavityDepth);
    const underside = new THREE.Shape(outline);
    for (const [left, right] of across.cavities) {
      const half = attachment.cavityHalfLength;
      underside.holes.push(new THREE.Path([
        new THREE.Vector2(-half, left), new THREE.Vector2(-half, right),
        new THREE.Vector2(half, right), new THREE.Vector2(half, left)
      ]));
    }
    extrude(underside, attachment.cavityDepth);
    const cylinder = (x: number, y: number, bottom: number, diameter: number, height: number) => {
      const geometry = new THREE.CylinderGeometry(diameter / 2, diameter / 2, height, 32);
      geometry.rotateX(Math.PI / 2);
      geometry.translate(x, y, bottom + height / 2);
      add(geometry);
    };
    for (const x of [-attachment.studRowOffset, attachment.studRowOffset]) {
      for (const [left, right] of ribs) {
        const rib = new THREE.BoxGeometry(attachment.ribWidth, right - left, attachment.cavityDepth);
        rib.translate(x, (left + right) / 2, attachment.cavityDepth / 2);
        add(rib);
      }
      for (const y of across.studs) {
        cylinder(x, y, attachment.studBaseZ, attachment.studDiameter, attachment.studHeight);
      }
    }
    for (const y of pins) {
      cylinder(0, y, 0, attachment.pinDiameter, attachment.cavityDepth);
    }
  }
  if (!parts.length) return null;
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

/** A rail-support stringer across [low, high] (piece frame laterals), the full base height. */
export function stringerSection([low, high]: readonly [number, number]): number[][] {
  return [[low,0],[low,BRICK_TRACK.baseThickness],[high,BRICK_TRACK.baseThickness],[high,0]];
}
