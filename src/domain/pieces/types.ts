import type { LibraryOrigin, RoutePiece, TrackStyle, WorkshopProject } from '../project';
import type { MeshEnd } from './families/community';

/** One editable number in the selected piece's panel; `options` turns it into a choice. */
export interface ParamSpec {
  key: string; label: string; unit: 'mm' | 'deg' | 'studs' | 'count' | '%' | '';
  min: number; max: number; step: number; default: number;
  options?: { value: number; label: string }[];
  /** Stored and validated, but not shown in the selected piece's panel (e.g. a solved path). */
  hidden?: boolean;
  /** Shown in the card only while the parameter `key` has one of `values` (e.g. bracket settings once a bracket is chosen). */
  when?: { key: string; values: readonly number[] };
}
/** A junction or mechanism setting; paths list the states they are enabled in. */
export interface StateSpec { id: string; label: string }
/** `community`: pieces from the library index (src/domain/library.ts), each printed as uploaded. */
export type PieceGroup = 'track' | 'junction' | 'elevation' | 'mechanism' | 'scenic' | 'experimental' | 'community';
/** Dual gauge mates standard and narrow; every other gauge mates only itself. */
export type Gauge = 'standard' | 'narrow' | 'dual' | 'monorail';

/** Piece or world frame: millimetres, +x forward, +y left, +z up; angles in radians. `roll` is outer-rail cant. */
export interface ShapePoint { x: number; y: number; z: number; heading: number; pitch?: number; roll?: number }
/** `stop`: a buffer end that mates nothing (still a route end for chaining and traversal); `electrical`: 9V metal rails reach this end. */
export interface ShapePort extends ShapePoint { id: string; gauge: Gauge; stop?: boolean; electrical?: boolean }
/**
 * A path in the piece frame: `states` lists the piece states it is enabled in (absent = always); `gauge` overrides the piece's;
 * `stop` makes its `to` end a buffer stop, whose port mates nothing; `trailable` (sprung points) lets a train run it from
 * its `to` end while it is disabled — the wheels push the points over and they spring back.
 * `moving` (C4): one position of a moving deck (turntable bridge, transfer-table deck, elevator car). Its geometry is the deck in
 * that position (rotated, translated, raised); only the enabled position is physical — drawn as track, driven and printed —
 * the others are where the deck can go. A moving path whose far end faces no track in that position ends in a `stop` port.
 * `electrical`: the path's rails are metal (9V nickel-silver inserts) and carry track power end to end.
 * `rack`: a toothed rack between the rails (cog railway); grades above the adhesion limit need a cog train.
 * `cable`: a funicular: cars are hauled by a cable, so any grade climbs; both its ports are stops (it never joins the network).
 */
export interface PiecePath { id: string; from: string; to: string; points: ShapePoint[]; states?: readonly string[]; gauge?: Gauge; stop?: boolean; trailable?: boolean; moving?: boolean; electrical?: boolean; rack?: boolean; cable?: boolean }
/** A path in the world frame, resolved for the piece's current state. */
export interface ShapePath extends PiecePath { enabled: boolean; gauge: Gauge }
/** A printable part as the CAD service knows it; fit adds project-wide profile and connector parameters. */
export interface CadPart { family: string; parameters: Record<string, number> }

/** One plain-track segment: centreline length and signed curvature (1/mm, + turns left) at each end; linear between. */
export interface TrackSegment { len: number; k0: number; k1: number }
/** A plain track path as the `composite_track` CAD family builds it (C2). Heights are relative to the start; cant in degrees. */
export interface CompositeTrack {
  segments: TrackSegment[];
  z0: number; z1: number; grade0: number; grade1: number; cant0: number; cant1: number;
  /** Minimum vertical-curve radius the CAD enforces, mm; 0 = unchecked (flat track). */
  vcurve: number;
  /**
   * Piecewise-linear cant (degrees) at stations, first at 0 and last at the full length; overrides the linear cant0→cant1.
   * Its interior knots are cut (bed splitting), and a cut where the cant is not zero gets plain ends (banked curves).
   */
  cants?: readonly { s: number; cant: number }[];
  /**
   * Piecewise vertical profile: height (same datum as z0/z1) and grade at stations, first at 0 and last at the full length,
   * one cubic Hermite between neighbouring knots; overrides the single z0→z1 Hermite. Its interior knots are always cut
   * (bed splitting), so every printed part is one `composite_track` Hermite (a climb's easements and constant slope).
   */
  heights?: readonly { s: number; z: number; grade: number }[];
}

/** Legacy authored fields a family carries; listed `sweep`/`rise` are required, `bend` is optional. The values are placement defaults. */
export interface LegacyFields { sweep?: number; rise?: number; bend?: number }

export interface PieceDefinition {
  /** Stored in `RoutePiece.family`. */
  family: string;
  label: string;
  /** Short size line for the palette tile and selected piece's panel. */
  description(piece: RoutePiece): string;
  group: PieceGroup;
  /** `owned`: the user's own brick piece, never printed. */
  source: 'owned' | 'printed';
  /** Official brick counterpart of a printed shape (or the owned piece itself on owned definitions). */
  owned?: { family: string; partNumbers: string[]; kit?: string };
  /** Printable styles; empty on owned pieces. */
  styles: readonly TrackStyle[];
  params: readonly ParamSpec[];
  states?: readonly StateSpec[];
  gauge: Gauge;
  /** Paths in the piece frame; `piecePaths` places them with the piece pose and resolves states. */
  paths(piece: RoutePiece, project: WorkshopProject): PiecePath[];
  /** Plain track built as `composite_track`: fit splits it to the printer bed at tie stations. */
  composite?(piece: RoutePiece, project: WorkshopProject): CompositeTrack;
  /** Piece-specific parameters of each part; owned definitions describe their nominal brick part. */
  cad(piece: RoutePiece, project: WorkshopProject): CadPart[];
  /** Where the next piece in the chain starts, in the piece frame. Absent: the `out` port. */
  end?(piece: RoutePiece, project: WorkshopProject): ShapePoint;
  /** Nominal centreline run in millimetres (arc length on curves). */
  run(piece: RoutePiece, project: WorkshopProject): number;
  /** Curve radius; only families whose pieces carry `sweep`. */
  radius?: number;
  /** `rail`: one analytic straight/curve/ramp run; `path`: one plain path from `paths`; `assembly`: multi-path junction or mechanism. */
  body: 'rail' | 'path' | 'assembly';
  legacy?: LegacyFields;
  /** Turnout-like pieces are entered from `in` only, so a route is never reversed through them. */
  handed?: boolean;
  /** Parameters of the same physical piece authored from its far end (e.g. a curve's sweep changes sign). */
  reverseParams?(params: Record<string, number>): Record<string, number>;
  /**
   * Its parameters are set from the open end it is laid on (a climb's rise reaches the height picked there), so at an open end
   * it is laid by its `in` end only: laid by its far end it would be the same piece reversed, going the wrong way.
   */
  fromJoint?: boolean;
  /**
   * Port id → the parameter holding level track (mm) between that end and the piece's slope (a climb's `lead` at `in`, `trail`
   * at `out`). Laid on an end that needs level before a slope (points within 128 mm), the `in` one is set to what is missing.
   */
  levelEnds?: Readonly<Record<string, string>>;
  /** Parameters of the mirror-image piece that Flip swaps to (handed parametric shapes). */
  flip?(params: Record<string, number>): Record<string, number>;
  /** The mirror-image family that Flip swaps to. */
  mirror?: string;
  /** Usable with the legacy custom-joiner track system. */
  customJoiner: boolean;
  /** Absent from the palette (still loads, renders and fits): a retired community piece, among others. */
  hidden?: boolean;
  /** A community piece: its library index entry and provenance (KTD9). It prints as uploaded (R20): no print styles, no fit adjustment. */
  community?: LibraryOrigin;
  /**
   * A community piece's uploaded mesh: its STL's URL in the library and its two marked ends in the STL's frame. Build and
   * Test drive draw it once downloaded (src/editor/community-mesh.ts).
   */
  libraryMesh?: { file: string; ends: readonly [MeshEnd, MeshEnd] };
  /** 3D builder body colour. */
  color: number;
  /** Uses flex-track end contacts. */
  flexEnds?: boolean;
  /** Draw a bridge deck under the rails. */
  deck?: boolean;
  /** Extra lines for the selected piece's panel. */
  notes?: readonly string[];
  /** One-line caution shown on the palette tile and selected piece's panel (Experimental pieces). */
  caution?: string;
  /** Piece-frame polygons swept by moving parts (points, selectors) through their full travel; absent: the static profile. */
  envelopes?(piece: RoutePiece, project: WorkshopProject): { x: number; y: number }[][];
  /**
   * The piece carries its own supports (helix column sockets, wall/shelf brackets): fit places those parts,
   * and the generic supports and risers stay out from under it.
   */
  ownSupports?(piece: RoutePiece): boolean;
  /**
   * The states this piece offers for its parameters (a turntable's lined-up stalls, an elevator's levels), in order;
   * each is one of `states`, which lists every state the family can have. Absent: all of `states`.
   */
  pieceStates?(piece: RoutePiece): readonly StateSpec[];
  /** Why this piece's parameters cannot be built (e.g. stall rails collide at the pit edge), or null; fit reports it. */
  problem?(piece: RoutePiece): string | null;
  /**
   * Moving pieces (C4): why a train stops at this piece in its current state — it meets a disabled path (the deck is lined
   * up elsewhere, the span is raised) or runs to the deck's free end. The route then ends there with this message instead of
   * failing as a switch set against it; absent: junction behaviour.
   */
  halt?(piece: RoutePiece, project: WorkshopProject): string;
  /**
   * Fixed track of a moving piece drawn in every state (piece frame): the stubs its deck lines up with. Moving paths run
   * over them too (traversal follows paths); this only keeps them visible while the deck is elsewhere.
   */
  fixedTrack?(piece: RoutePiece, project: WorkshopProject): ShapePoint[][];
  /** Fixed body outlines in the piece frame (turntable pit, transfer-table well), drawn under the moving deck in 2D and 3D. */
  outline?(piece: RoutePiece, project: WorkshopProject): { x: number; y: number }[][];
}
