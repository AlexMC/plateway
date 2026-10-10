import type { Gauge } from './pieces/types';
import type { RoutePiece } from './project';

/** World frame: millimetres, +x forward, +y left, +z up. Angles are radians; `roll` (banked track) + raises the right rail. */
export interface Pose3 { x: number; y: number; z: number; heading: number; pitch: number; roll?: number }
/** `profile` is part of the CAD service's port contract. */
export interface Port { pose: Pose3; profile: 'brick'; railGauge: number | null; interfaceWidth: number | null }
interface NamedPort extends Port { id: string }
export interface FitIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  routeId?: string;
  span?: [string, string];
  crossingId?: string;
  /** Owned pieces placed beyond the Setup inventory; `pieceIds` are the extras, in route order. */
  shortfall?: { family: RoutePiece['family']; used: number; owned: number; pieceIds: string[] };
  /** Where the problem is when `span` does not say: the pieces, fit supports and world points involved. */
  pieceIds?: string[];
  supportIds?: string[];
  points?: { x: number; y: number; z: number }[];
  /** A measured clearance and the clearance it needs, mm. */
  clearance?: { measured: number; needed: number };
  /**
   * A slope too close to a junction: the slope piece, its end facing the junction and the level track missing there, mm;
   * `set` is the slope's own level parameter at that end (a climb's lead or run-out) that gives it.
   */
  level?: { junctionId: string; slopeId: string; port: string; missing: number; set?: { key: string; value: number } };
}
/** The piece a route point (`<pieceId>:<port>`) belongs to. */
export const pointPiece = (pointId: string) => pointId.slice(0, pointId.lastIndexOf(':'));
/** The piece a fitted section belongs to (a ramp's modules and an assembly's paths share one). */
export const sectionPiece = (section: Pick<Section, 'pieceId' | 'fromPointId'>) => section.pieceId ?? pointPiece(section.fromPointId);
export interface Section {
  id: string;
  routeId: string;
  fromPointId: string;
  toPointId: string;
  family: string | null;
  kind: 'straight' | 'transition' | 'curve' | 'unresolved';
  start: Port;
  end: Port;
  /** Horizontal run in millimetres; arc length for curves. */
  run: number;
  parameters: Record<string, number>;
  /** An arc's centre and signed sweep, if it is a curved section. */
  arc?: { center: { x: number; y: number }; radius: number; sweep: number };
  /** Graph ownership keeps physical parts independent of their traversal paths. */
  pieceId?: string;
  pathId?: string;
  enabled?: boolean;
  /** A disabled path of sprung points that a train may still run from its end (`to`) towards its start. */
  trailable?: boolean;
  /** One position of a moving deck (C4); only the enabled one is physical, so drive views skip the others. */
  moving?: boolean;
  /** A moving piece's stop message on a disabled path: a train meeting it stops there (the deck is lined up elsewhere). */
  halt?: string;
  /** On an enabled path ending (or, driven backwards, starting) at a moving deck's free end: why a train stops there. */
  endHalt?: string;
  startHalt?: string;
  pathPoints?: Pose3[];
  /** The path's running gauge (absent = standard): narrow, dual (both) or monorail; Test drive runs only matching cars on it. */
  gauge?: Gauge;
  /** Rack between the rails (cog railway): its grade above 5 % needs a cog car. */
  rack?: true;
  /** A funicular: cars are hauled by a cable, whatever their drive. */
  cable?: true;
}
interface PartBase {
  id: string;
  routeId: string;
  sectionId: string;
  family: string;
  parameters: Record<string, number>;
  pose: Pose3;
  /** The CAD service requires this field; the app never marks a part tested. */
  status: 'unverified';
  source: 'owned' | 'printed';
  /** Generator input exists; this is not a generated mesh or physical fit result. */
  geometryAvailable: boolean;
}
export type PartInstance =
  | (PartBase & { interfaceKind: 'rail'; startPort: Port; endPort: Port })
  | (PartBase & { interfaceKind: 'track-assembly'; ports: NamedPort[]; paths: { id: string; from: string; to: string; enabled: boolean }[] })
  | (PartBase & { interfaceKind: 'connector' })
  | (PartBase & { interfaceKind: 'mounting'; mountingSeat: Pose3 })
  /** A loose printed part placed on or beside a track piece (colour marker insert, road tile); no ports. */
  | (PartBase & { interfaceKind: 'accessory' });
export function port(pose: Pose3, railGauge: number | null, interfaceWidth: number | null): Port {
  return { pose, profile: 'brick', railGauge, interfaceWidth };
}
export function portsMatch(a: Port, b: Port, tolerance = 0.01): boolean {
  const p = a.pose, q = b.pose;
  const heading = Math.atan2(Math.sin(p.heading - q.heading), Math.cos(p.heading - q.heading));
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) <= tolerance &&
    Math.abs(heading) <= tolerance && Math.abs(p.pitch - q.pitch) <= tolerance &&
    a.profile === b.profile && a.railGauge === b.railGauge && a.interfaceWidth === b.interfaceWidth;
}
