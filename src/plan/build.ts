import { HELIX_COLUMN_OFFSET } from '../domain/pieces/families/helix';
import { solveSBend } from '../domain/pieces/families/sbend';
import { CURVE_KIND, SBEND_KIND, STRAIGHT_KIND, curveSector, type KindShape } from '../domain/pieces/families/kinds';
import { counterpartFamily, findPieceDefinition, pieceDefinition, piecePaths, piecePorts, pieceStates, portsMate, primaryEnd, type ShapePort } from '../domain/pieces';
import { furnitureNames, furnitureType, placedEntries } from '../domain/furniture';
import type { Car, Furniture, RoutePiece, WorkshopProject } from '../domain/project';
import { pieceIsFast } from '../domain/printer';
import { portsMatch } from '../domain/route';
import { DEFAULT_MIN_RADIUS } from '../domain/solver/gap';
import { trainGauge, trainProblem } from '../drive/compat';
import { consistLength, finalLeadDistance, placeConsist, startingLeadDistance } from '../drive/train';
import { routePath } from '../drive/traversal';
import { layClimb, placeKitPieces } from '../editor/elevation-kits';
import { placeFurniture } from '../editor/furniture';
import { closeGap, openEnds, planGap, type OpenEnd } from '../editor/gap-closer';
import { layHelix, minimumRise, planHelix } from '../editor/helix';
import { placePiece, previewPiece, setPieceSource, setPieceState, type Placement } from '../editor/operations';
import { createStandardProject } from '../editor/setup-defaults';
import { levelLeadAt } from '../fitting/elevation';
import { fitProject, type FitResult } from '../fitting/fit';
import { outsideMessage, ROOM_CODES, roomClashes, shelfMessage } from '../fitting/room';
import { formatRadius, NAMED_FAMILIES, parsePlan, STUD, type Plan, type PlanError, type PlanSource, type PlanStart, type PlanStep, type Pose } from './types';

/** How a placed piece is sourced in the finished project. */
export type PieceOrigin = 'owned' | 'printed' | 'fast';
export interface PlacedPiece {
  id: string; family: string; source: PieceOrigin;
  /** The plan wanted the owned piece, but the stock had run out. */
  fallback?: true;
}
export interface StepReport { path: string; did: string; pieces: PlacedPiece[]; note?: string }
/** `count`: identical issues merged into this one (e.g. one per ramp piece of a step). */
export interface FitIssueReport { code: string; severity: 'error' | 'warning'; message: string; route?: string; steps: string[]; count: number }
export interface OpenEndReport {
  /** The plan reference that names this end (`A.branch`, `main.end`), if any. */
  label?: string;
  /** The step whose piece leaves it open. */
  step?: string;
  family: string; port: string;
  x: number; y: number; z: number; heading: number;
}
export interface TrainReport {
  /** `route`: the Test drive route that runs this track (its own route, else another that drives over all of it). */
  track: string; route: string; ok: boolean;
  /** The train's path comes back to where it started: a loop it can run round. */
  closed: boolean; length: number;
  /** Junctions set to let the train onto this track (labels or step paths). */
  switches: { piece: string; state: string }[];
  problem?: string;
}
export interface Bill {
  owned: { family: string; used: number; stock: number }[];
  printed: { family: string; count: number }[];
  /** Owned shapes the plan wanted but printed because the stock ran out, by owned family. */
  fallbacks: { family: string; count: number }[];
  detailed: number; fast: number;
}
export interface PlanReport {
  ok: boolean; name: string;
  steps: StepReport[];
  errors: PlanError[];
  warnings: PlanError[];
  fit: { issues: FitIssueReport[]; openEnds: OpenEndReport[] };
  trains: TrainReport[];
  /** Cars the train check used; `example` when the project has none of its own. */
  train: { cars: number; length: number; example: boolean };
  bill: Bill;
}

const DEG = Math.PI / 180;
const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
/** Ends closer than this (and facing the same way) are the same end. */
const SAME_DISTANCE = 0.5, SAME_ANGLE = 0.01;
const samePose = (a: Pose, b: Pose) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < SAME_DISTANCE && Math.abs(normalize(a.heading - b.heading)) < SAME_ANGLE;
const poseOf = (port: Pose): Pose => ({ x: port.x, y: port.y, z: port.z, heading: port.heading });
const where = (pose: Pose) => `(${Math.round(pose.x)}, ${Math.round(pose.y)}${Math.abs(pose.z) > 0.05 ? `, z ${Number(pose.z.toFixed(1))}` : ''}) heading ${Math.round(normalize(pose.heading) / DEG)}°`;
const turnWord = (sign: number) => sign > 0 ? 'left' : 'right';

/** A step that cannot be built: the message says what failed; the hint, what would fix it. */
class StepError extends Error {
  constructor(message: string, readonly hint?: string) { super(message); }
}
const failure = (error: unknown) => error instanceof StepError ? error : new StepError(error instanceof Error ? error.message : String(error));

/** Pose at the middle of a cubby's `side` entry edge, on its floor, heading into the cubby (the shelf's surface data). */
export function cubbyPose(item: Furniture, row: number, col: number, side: 'front' | 'back'): Pose {
  const placed = placedEntries([item])
    .find(({ surface, entry }) => surface.cell?.row === row && surface.cell.col === col && entry.id === side)!;
  return { x: (placed.a.x + placed.b.x) / 2, y: (placed.a.y + placed.b.y) / 2, z: placed.surface.height, heading: normalize(placed.heading) };
}

/**
 * The names a plan can use for what a base project already has: its KALLAX shelves as `K1`, `K2`… (project order) and
 * its open track ends as `existing.e1`, `existing.e2`… (outward heading, as `from` continues and `close` joins them).
 */
export interface BaseReferences {
  shelves: { id: string; furnitureId: string; x: number; y: number; quarterTurns: 0 | 1 | 2 | 3 }[];
  ends: { ref: string; pose: Pose }[];
}
export function baseReferences(project: WorkshopProject): BaseReferences {
  return {
    shelves: project.furniture.filter(item => item.family === 'kallax_5x5')
      .map((item, index) => ({ id: `K${index + 1}`, furnitureId: item.id, x: item.x, y: item.y, quarterTurns: item.quarterTurns })),
    ends: openEnds(project).map((end, index) => ({ ref: `existing.e${index + 1}`, pose: poseOf(end.port) }))
  };
}

interface Shape { family: string; sweep?: number; rise?: number; bend?: number; params?: Record<string, number> }

class Builder {
  project: WorkshopProject;
  readonly errors: PlanError[] = [];
  readonly warnings: PlanError[] = [];
  /** Steps that laid something (or tried to), with the ids they placed; the report reads the pieces' final form. */
  readonly steps: (Omit<StepReport, 'pieces'> & { ids: string[] })[] = [];
  /** Owned pieces still in stock, by owned family. */
  private readonly stock = new Map<string, number>();
  /** Plan references (`A.branch`, `main.start`) → the port's pose as laid (outward heading) and the step that made it. */
  readonly labels = new Map<string, { pose: Pose; path: string }>();
  readonly pieceStep = new Map<string, string>();
  readonly trackPieces = new Map<string, string[]>();
  readonly fallbacks = new Set<string>();
  /** Piece id → its plan label (`as`). */
  readonly pieceLabel = new Map<string, string>();
  private readonly shelves = new Map<string, string>();

  constructor(readonly plan: Plan, base: WorkshopProject) {
    this.project = base;
    const owned = base.routes.flatMap(route => route.pieces).filter(piece => pieceDefinition(piece.family).source === 'owned');
    for (const [family, count] of Object.entries(base.inventory))
      this.stock.set(family, Math.max(0, count - owned.filter(piece => piece.family === family).length));
    // What the base project already has, under the names `baseReferences` gives the plan's author.
    const known = baseReferences(base);
    for (const shelf of known.shelves) this.shelves.set(shelf.id, shelf.furnitureId);
    for (const end of known.ends) this.labels.set(end.ref, { pose: end.pose, path: 'base project' });
  }

  build(): void {
    this.plan.furniture.forEach((item, index) => {
      if (this.shelves.has(item.id)) {
        this.errors.push({ path: `furniture[${index}].id`, message: `"${item.id}" is a shelf the layout already has.`,
          hint: `Use ${item.id} without adding it to "furniture", or give a new shelf another id.` });
        return;
      }
      try {
        const [next, id] = placeFurniture(this.project, item, item.quarterTurns);
        const placed = next.furniture.find(shelf => shelf.id === id)!;
        if (Math.hypot(placed.x - item.x, placed.y - item.y) > 0.5) this.warnings.push({ path: `furniture[${index}]`,
          message: `${item.id} was moved to (${Math.round(placed.x)}, ${Math.round(placed.y)}) to keep the whole shelf inside the room.`,
          hint: 'Give its centre so the footprint (1820 × 390 mm, turned with quarterTurns) fits the room, or set the room size in Setup.' });
        this.project = next;
        this.shelves.set(item.id, id);
      } catch (error) {
        this.errors.push({ path: `furniture[${index}]`, message: failure(error).message, hint: 'Make the room larger in Setup or turn the shelf.', space: 'room' });
      }
    });
    this.plan.tracks.forEach((track, index) => this.buildTrack(index));
  }

  private buildTrack(index: number): void {
    const track = this.plan.tracks[index], path = `tracks[${index}]`;
    this.trackPieces.set(track.id, []);
    let cursor: Pose | null;
    try {
      cursor = this.startPose(track.start);
    } catch (error) {
      const { message, hint } = failure(error);
      this.errors.push({ path: `${path}.start`, message, ...(hint ? { hint } : {}) });
      if (track.steps.length) this.warnings.push({ path, message: `Track "${track.id}" was not built because its start failed.` });
      return;
    }
    this.labels.set(`${track.id}.start`, { pose: { ...cursor, heading: normalize(cursor.heading + Math.PI) }, path: `${path}.start` });
    let ended: string | null = null, last = `${path}.start`;
    for (const [number, step] of track.steps.entries()) {
      const stepPath = `${path}.steps[${number}]`;
      if (ended) {
        this.errors.push({ path: stepPath, message: `Track "${track.id}" already ended at ${ended}.`, hint: 'Remove this step, or start a new track from a labelled port.' });
        continue;
      }
      const placed: string[] = [];
      try {
        if (!step) break;
        const result = this.buildStep(step, cursor!, stepPath, placed);
        cursor = result.cursor;
        last = stepPath;
        if (result.ended) ended = stepPath;
      } catch (error) {
        const { message, hint } = failure(error);
        this.errors.push({ path: stepPath, message, ...(hint ? { hint } : {}) });
        if (placed.length) this.steps.push({ path: stepPath, did: 'failed part-way', ids: placed });
        break;
      } finally {
        this.trackPieces.get(track.id)!.push(...placed);
        this.checkRoom(stepPath, placed);
        if (last !== stepPath && number < track.steps.length - 1)
          this.warnings.push({ path, message: `Stopped at steps[${number}]; steps[${number + 1}] to steps[${track.steps.length - 1}] were not built.` });
      }
    }
    // A stopped track still names its last good end, so a repair can build on it (references check it is still open).
    if (cursor && !ended) this.labels.set(`${track.id}.end`, { pose: cursor, path: last });
  }

  private startPose(start: PlanStart): Pose {
    if (start.kind === 'pose') return start.pose;
    if (start.kind === 'from') return this.openEnd(start.ref).pose;
    const id = this.shelves.get(start.furniture), shelf = this.project.furniture.find(item => item.id === id);
    if (!shelf) throw new StepError(`No furniture "${start.furniture}" in this plan.`,
      this.shelves.size ? `Known shelves: ${[...this.shelves.keys()].join(', ')}.` : 'Add {"id": "K1", "kallax": {"x": …, "y": …, "quarterTurns": 0}} to "furniture".');
    return cubbyPose(shelf, start.row, start.col, start.side);
  }

  /** The pose a reference names, as it was laid (outward heading). */
  private label(ref: string): Pose {
    const entry = this.labels.get(ref);
    if (entry) return entry.pose;
    const name = ref.slice(0, ref.lastIndexOf('.')), ports = [...this.labels.keys()].filter(key => key.startsWith(`${name}.`));
    const later = this.plan.tracks.findIndex(track => track.id === name);
    if (ports.length) throw new StepError(`"${name}" has no port "${ref.slice(name.length + 1)}".`, `Its ports: ${ports.join(', ')}.`);
    if (later >= 0) throw new StepError(`Reference "${ref}" is not built yet: tracks are built in order and tracks[${later}] ("${name}") comes later or stopped early.`,
      'Move the referenced track before this one, or fix the errors that stopped it.');
    throw new StepError(`Unknown reference "${ref}".`, `Open ends you can use: ${this.openLabels().join(', ') || 'none'}.`);
  }
  /** The open port a reference names, as it is now in the project. */
  private openEnd(ref: string): { pose: Pose; end: OpenEnd } {
    const pose = this.label(ref);
    const end = openEnds(this.project).find(candidate => samePose(candidate.port, pose));
    if (end) return { pose: poseOf(end.port), end };
    const joined = this.project.routes.some(route => route.pieces.some(piece => piecePorts(piece, this.project).some(port => samePose(port, pose))));
    throw new StepError(joined ? `"${ref}" is already joined to other track.` : `"${ref}" no longer exists.`,
      `Open ends you can use: ${this.openLabels().join(', ') || 'none'}.`);
  }
  private openLabels(): string[] {
    const ends = openEnds(this.project);
    return [...this.labels].filter(([, entry]) => ends.some(end => samePose(end.port, entry.pose))).map(([label]) => label);
  }

  private take(family: string): boolean {
    const left = this.stock.get(family) ?? 0;
    if (left > 0) this.stock.set(family, left - 1);
    return left > 0;
  }
  /** The owned shape while it is wanted and in stock; else the printed shape (a fallback when owned was wanted). */
  private choose(printed: Shape, owned: Shape | null, source: PlanSource): { shape: Shape; fallback: boolean } {
    if (source !== 'owned' || !owned) return { shape: printed, fallback: false };
    return this.take(owned.family) ? { shape: owned, fallback: false } : { shape: printed, fallback: true };
  }

  /** Lay one piece with port `enter` on `cursor` through placePiece (snapping off: the pose is exact), then set its state. */
  private lay(shape: Shape, cursor: Pose, path: string, enter = 'in', state?: string): { id: string; ports: ShapePort[] } {
    const base: Partial<Placement> = { ...(shape.params && Object.keys(shape.params).length ? { params: shape.params } : {}),
      ...(shape.sweep === undefined ? {} : { sweep: shape.sweep }), ...(shape.rise === undefined ? {} : { rise: shape.rise }), ...(shape.bend === undefined ? {} : { bend: shape.bend }) };
    const definition = pieceDefinition(shape.family);
    const local = { ...previewPiece(this.project, shape.family, { x: 0, y: 0, z: 0, heading: 0, ...base }, -1).piece, ...(state ? { state } : {}) };
    const port = piecePorts(local, this.project).find(item => item.id === enter);
    if (!port) throw new StepError(`${definition.label} (${shape.family}) has no port "${enter}".`, `Its ports: ${piecePorts(local, this.project).map(item => item.id).join(', ')}.`);
    const heading = normalize(cursor.heading + Math.PI - port.heading), c = Math.cos(heading), s = Math.sin(heading);
    const placement: Placement = { x: cursor.x - (c * port.x - s * port.y), y: cursor.y - (s * port.x + c * port.y), z: cursor.z - port.z, heading, ...base };
    const preview = { ...previewPiece(this.project, shape.family, placement, -1).piece, ...(state ? { state } : {}) };
    const ports = piecePorts(preview, this.project);
    this.checkOverlap(ports, definition.label, path);
    const [next, id] = placePiece(this.project, shape.family, placement, -1);
    this.project = state ? setPieceState(next, id, state) : next;
    this.pieceStep.set(id, path);
    return { id, ports };
  }

  /**
   * One step's pieces against the room (Setup's size) and the furniture: footprints past a wall, or into a panel. A
   * track resting on a cubby floor stays clear of the panels, so entering a cubby at its floor height passes.
   */
  private checkRoom(path: string, ids: readonly string[]): void {
    const named = furnitureNames(this.project.furniture);
    const { room, outside, reach, shelves } = roomClashes(this.project, ids, shelf => [...this.shelves].find(([, furniture]) => furniture === shelf.id)?.[0] ?? named(shelf));
    if (outside.length) this.errors.push({ path, message: outsideMessage(outside.map(item => item.family), reach, room),
      hint: `Keep every piece within x 0–${room.width} and y 0–${room.depth}: start the track elsewhere, turn sooner or shorten it; if the room is bigger, set its size in Setup.`, space: 'room' });
    const kallax = furnitureType('kallax_5x5'), cubby = (row: number) => kallax.surfaces.find(surface => surface.cell?.row === row && surface.cell.col === 1)!.height;
    for (const [name, hit] of shelves) {
      const type = furnitureType(this.project.furniture.find(item => item.id === hit.furnitureId)!.family);
      const surfaces = [...new Set(type.surfaces.map(surface => `${surface.name} at ${surface.height} mm`))].join(', ');
      this.errors.push({ path, message: shelfMessage(name, hit), hint: type === kallax
        ? `Track may enter a KALLAX only through a cubby opening, resting on that cubby's floor (row 1 at ${cubby(1)} mm, each row ${cubby(2) - cubby(1)} mm higher): start or close at a {"kallax": …} cubby start and keep clear of the shell and dividers.`
        : `Keep track clear of the ${type.label}'s panels${surfaces ? `, or rest it on a surface (${surfaces})` : ''}.`, space: 'shelf' });
    }
  }

  /** A new port sitting on an existing one without mating it is track laid over track. */
  private checkOverlap(ports: readonly ShapePort[], label: string, path: string): void {
    for (const route of this.project.routes) for (const piece of route.pieces) for (const other of piecePorts(piece, this.project)) {
      const own = ports.find(port => Math.hypot(port.x - other.x, port.y - other.y, port.z - other.z) < 1);
      if (!own || portsMate(own, other, SAME_DISTANCE, SAME_ANGLE)) continue;
      throw new StepError(`The ${label}'s ${own.id} end at ${where(own)} lands on existing track (${this.pieceStep.get(piece.id) ?? 'base project'}, ${piece.family} port ${other.id}) without joining it.`,
        'Ends that meet must face each other: check the lengths and angles before this step, or end the track with "close".');
    }
  }

  /** Build one step from `cursor`; every piece laid is pushed onto `pieces` as it lands, so a failure still accounts for it. */
  private buildStep(step: PlanStep, cursor: Pose, path: string, pieces: string[]): { cursor: Pose | null; ended?: boolean } {
    const source = step.source ?? this.plan.prefer;
    const record = (id: string, fell: boolean) => { pieces.push(id); if (fell) this.fallbacks.add(id); };
    const kindShape = (shape: KindShape | null): Shape | null => shape && { family: shape.family, ...(shape.sweep === undefined ? {} : { sweep: shape.sweep }), ...(shape.params ? { params: shape.params } : {}) };
    let next: Pose | null = cursor, ended = false, did = '', note: string | undefined;
    switch (step.kind) {
      case 'straight': {
        const values = { length: step.length };
        const problem = STRAIGHT_KIND.problem(values);
        if (problem) throw new StepError(problem);
        for (let index = 0; index < step.count; index++) {
          const { shape, fallback: fell } = this.choose(kindShape(STRAIGHT_KIND.shape(values, 'printed'))!, kindShape(STRAIGHT_KIND.shape(values, 'owned')), source);
          const laid = this.lay(shape, next!, path);
          record(laid.id, fell);
          next = poseOf(laid.ports.find(port => port.id === 'out')!);
        }
        did = `straight ${step.length} mm ×${step.count}`;
        break;
      }
      case 'curve': {
        const sector = curveSector(step.radius), whole = Math.floor(step.angle / sector + 1e-9), rest = step.angle - whole * sector;
        if (rest > 1e-6 && rest < 0.5) throw new StepError(`${step.angle}° leaves a ${Number(rest.toFixed(3))}° piece after ${whole} × ${sector}° pieces; curve pieces are at least 0.5°.`,
          `Use a multiple of ${sector}° or leave at least 0.5° over (e.g. ${whole * sector}° or ${Number((whole * sector + 0.5).toFixed(3))}°).`);
        const sweeps = [...Array(whole).fill(sector), ...(rest > 1e-6 ? [rest] : [])];
        for (const sweep of sweeps) {
          const values = { radius: step.radius, sweep: step.turn * sweep };
          const problem = CURVE_KIND.problem(values);
          if (problem) throw new StepError(problem);
          const { shape, fallback: fell } = this.choose(kindShape(CURVE_KIND.shape(values, 'printed'))!, kindShape(CURVE_KIND.shape(values, 'owned')), source);
          const laid = this.lay(shape, next!, path);
          record(laid.id, fell);
          next = poseOf(laid.ports.find(port => port.id === 'out')!);
        }
        did = `curve ${formatRadius(step.radius)} ${turnWord(step.turn)} ${step.angle}° (${sweeps.length} × ${sweeps.length > 1 && rest > 1e-6 ? `${sector}° + ${Number(rest.toFixed(3))}°` : `${Number(sweeps[0].toFixed(3))}°`})`;
        break;
      }
      case 'sbend': {
        const length = step.length ?? sbendLength(step.radius!, Math.abs(step.offset), step.middle);
        if (length === null) throw new StepError(`No S-bend of radius ${formatRadius(step.radius!)} shifts ${Math.abs(step.offset) / STUD} studs.`, 'Use a wider radius or a smaller offset.');
        const values = { offset: step.offset, length, middle: step.middle };
        const problem = SBEND_KIND.problem(values);
        if (problem) throw new StepError(`S-bend ${Math.abs(step.offset) / STUD} studs over ${Number((length / STUD).toFixed(2))} studs: ${problem}`, 'Make it longer or the offset smaller.');
        const solved = solveSBend(length, step.offset, step.middle)!.radius;
        if (step.length !== null && step.radius !== null && Math.abs(solved - step.radius) > 0.5)
          throw new StepError(`An S-bend shifting ${Math.abs(step.offset) / STUD} studs over ${step.length / STUD} studs has radius ${formatRadius(Math.round(solved * 10) / 10)}, not ${formatRadius(step.radius)}.`,
            'Give only length or only radius; the other follows.');
        const laid = this.lay(kindShape(SBEND_KIND.shape(values, 'printed'))!, next!, path);
        record(laid.id, false);
        next = poseOf(laid.ports.find(port => port.id === 'out')!);
        did = `S-bend ${turnWord(step.offset)} ${Math.abs(step.offset) / STUD} studs over ${Number((length / STUD).toFixed(2))} studs (${formatRadius(Math.round(solved))})`;
        break;
      }
      case 'turnout':
      case 'crossing':
      case 'piece': {
        let printed: Shape, owned: Shape | null, wanted = source;
        if (step.kind === 'piece') {
          const definition = pieceDefinition(step.family);
          const extras = { ...(step.sweep === undefined ? {} : { sweep: step.sweep }), ...(step.rise === undefined ? {} : { rise: step.rise }), ...(step.bend === undefined ? {} : { bend: step.bend }), params: step.params };
          if (definition.source === 'owned') {
            printed = { family: counterpartFamily(step.family, 'printed') ?? step.family, ...extras };
            owned = { family: step.family, ...extras };
            wanted = step.source ?? 'owned';
          } else {
            printed = { family: step.family, ...extras };
            owned = definition.owned && counterpartFamily(step.family, 'owned') ? { family: counterpartFamily(step.family, 'owned')!, ...extras } : null;
            wanted = step.source ?? (this.plan.prefer === 'fast' ? 'fast' : 'printed');
          }
        } else {
          const family = step.family ?? NAMED_FAMILIES[step.type!];
          printed = { family, params: step.params };
          const counterpart = pieceDefinition(family).owned ? counterpartFamily(family, 'owned') : undefined;
          owned = counterpart && counterpart !== family ? { family: counterpart, params: step.params } : null;
        }
        const { shape, fallback: fell } = this.choose(printed, owned, wanted);
        const enter = step.enter ?? 'in', state = step.kind === 'piece' ? step.state : step.set;
        const laid = this.lay(shape, next!, path, enter, state);
        record(laid.id, fell);
        const exits = laid.ports.filter(port => port.id !== enter);
        const follow = step.follow ?? (enter === 'in' ? (exits.find(port => port.id === 'out') ?? exits[0])?.id : 'in');
        const exit = exits.find(port => port.id === follow);
        if (step.follow && !exit) throw new StepError(`${pieceDefinition(shape.family).label} has no exit "${step.follow}" when entered at "${enter}".`, `Its exits: ${exits.map(port => port.id).join(', ')}.`);
        if (step.as) {
          for (const port of laid.ports) this.labels.set(`${step.as}.${port.id}`, { pose: poseOf(port), path });
          this.pieceLabel.set(laid.id, step.as);
        }
        next = exit && !exit.stop ? poseOf(exit) : null;
        ended = !next;
        const others = exits.filter(port => port.id !== follow).map(port => step.as ? `${step.as}.${port.id}` : port.id);
        did = `${step.kind === 'piece' ? 'piece' : step.kind} ${shape.family}${state ? ` set ${state}` : ''}${enter !== 'in' ? ` entered at ${enter}` : ''}${follow ? `, continues from ${follow}` : ', ends here'}`;
        if (others.length) note = `other exits: ${others.join(', ')}`;
        break;
      }
      case 'ramp':
      case 'raise': {
        const target = step.kind === 'ramp' ? cursor.z + step.rise : step.to;
        // Right after points (or within 128 mm of level of them) the climb starts with the level they still need.
        const lead = levelLeadAt(this.project, cursor);
        const laid = layClimb(cursor, { target, grade: step.grade, lead });
        if (laid.problem || !laid.pieces.length) throw new StepError(`Go up or down refused: ${laid.problem || 'nothing to lay.'}`, 'Change the target height.');
        next = this.placeKit(laid.pieces, path, pieces);
        did = `${step.kind} ${Math.round(cursor.z)} → ${Number(target.toFixed(1))} mm at ≤${step.grade}% (one climb piece, ${Math.round(laid.plan!.run + lead)} mm run${lead ? `, ${lead} mm level first after the junction` : ''})`;
        break;
      }
      case 'helix': {
        const options = { radius: step.radius, turns: step.turns, rise: step.rise ?? minimumRise(step.radius), hand: step.hand, direction: step.direction,
          columns: step.columns, side: 1 as const, offset: HELIX_COLUMN_OFFSET };
        const route = this.project.routes.find(item => item.pieces.some(piece => piecePorts(piece, this.project).some(port => samePose(port, { ...cursor, heading: cursor.heading + Math.PI }))));
        const base = route?.base ?? 0, helix = planHelix(options, cursor.z - base);
        if (helix.problem) throw new StepError(`The helix kit refused: ${helix.problem}`, 'Change turns, radius or rise per turn.');
        if (helix.caution) this.warnings.push({ path, message: `Helix: ${helix.caution}` });
        next = this.placeKit(layHelix(this.project, cursor, options, base), path, pieces);
        did = `helix ${formatRadius(step.radius)} ${step.turns} turns ${turnWord(step.hand)} ${step.direction > 0 ? 'up' : 'down'} ${Number(helix.height.toFixed(1))} mm (${options.rise} mm per turn, ${helix.sections.length} sections)`;
        break;
      }
      case 'buffer': {
        const laid = this.lay({ family: 'buffer_stop', params: { length: step.length } }, cursor, path);
        record(laid.id, false);
        next = null; ended = true;
        did = `buffer stop ${step.length} mm`;
        break;
      }
      case 'close': {
        const target = this.label(step.target);
        ended = true; next = null;
        if (samePose(cursor, { ...target, heading: target.heading + Math.PI })) {
          did = `close to ${step.target}: already joined, no piece needed`;
          break;
        }
        const from = openEnds(this.project).find(end => samePose(end.port, cursor));
        if (!from) throw new StepError(`The current end at ${where(cursor)} is not an open end, so there is nothing to close from.`, 'Remove the step before this one that covered it.');
        const gap = planGap(this.project, from, this.openEnd(step.target).end, step.minRadius ?? DEFAULT_MIN_RADIUS);
        if (!gap.solution.ok) throw new StepError(`close to ${step.target} failed: ${gap.solution.reason}`, closeHint(gap.solution.reason, cursor, target));
        const [project, id] = closeGap(this.project, gap);
        this.project = project;
        this.pieceStep.set(id, path);
        record(id, false);
        did = `close to ${step.target}: gap closer ${Math.round(gap.solution.length)} mm, ${Number.isFinite(gap.solution.minRadius) ? `tightest radius ${formatRadius(Math.round(gap.solution.minRadius))}` : 'straight'}`;
        break;
      }
    }
    if (source === 'fast') {
      if (this.project.trackSystem !== 'brick-v1') throw new StepError('Fast print needs standard brick track.', 'Use "source": "printed".');
      const printed = pieces.filter(id => pieceDefinition(this.piece(id).family).source === 'printed');
      if (printed.length) this.project = setPieceSource(this.project, printed, 'fast');
    }
    this.steps.push({ path, did, ids: [...pieces], ...(note ? { note } : {}) });
    return { cursor: next, ended };
  }

  /** Lay a kit's pieces with the editor's placeKitPieces; the track continues from the last piece's end. */
  private placeKit(laid: readonly RoutePiece[], path: string, pieces: string[]): Pose {
    for (const piece of laid) this.checkOverlap(piecePorts(piece, this.project), pieceDefinition(piece.family).label, path);
    const [project, ids] = placeKitPieces(this.project, laid);
    this.project = project;
    for (const id of ids) this.pieceStep.set(id, path);
    pieces.push(...ids);
    return poseOf(primaryEnd(laid.at(-1)!, project));
  }

  piece(id: string): RoutePiece {
    return this.project.routes.flatMap(route => route.pieces).find(piece => piece.id === id)!;
  }
}

/** S-bend length (mm) for two arcs of `radius` shifting `offset` with `middle` straight between; null if it cannot. */
function sbendLength(radius: number, offset: number, middle: number): number | null {
  // Per half: R(1 − cos θ) + (middle/2) sin θ = offset/2, increasing in θ on (0, π/2].
  const lateral = (angle: number) => radius * (1 - Math.cos(angle)) + middle / 2 * Math.sin(angle) - offset / 2;
  if (lateral(Math.PI / 2) < 0) return null;
  let low = 0, high = Math.PI / 2;
  for (let i = 0; i < 100; i++) { const mid = (low + high) / 2; if (lateral(mid) < 0) low = mid; else high = mid; }
  const angle = (low + high) / 2;
  return 2 * (radius * Math.sin(angle) + middle / 2 * Math.cos(angle));
}

/** What would fix a failed close, from the solver's reason and where the two ends are. */
function closeHint(reason: string, from: Pose, to: Pose): string {
  const ahead = { x: Math.cos(from.heading) * (to.x - from.x) + Math.sin(from.heading) * (to.y - from.y),
    y: -Math.sin(from.heading) * (to.x - from.x) + Math.cos(from.heading) * (to.y - from.y) };
  const turn = Math.round(normalize(to.heading + Math.PI - from.heading) / DEG);
  const geometry = `The target is ${Math.round(Math.abs(ahead.x))} mm ${ahead.x >= 0 ? 'ahead' : 'behind'} and ${Math.round(Math.abs(ahead.y))} mm to the ${ahead.y >= 0 ? 'left' : 'right'} of the current end, and the track must turn ${Math.abs(turn)}° ${turn >= 0 ? 'left' : 'right'} to meet it.`;
  if (reason.includes('different heights')) return `${geometry} Add a "raise" step to match its height (${Number(to.z.toFixed(1))} mm) first.`;
  if (reason.includes('only')) return `${geometry} Remove a piece before the close so the gap is at least 24 mm, or end exactly on the port.`;
  if (reason.includes('face away')) return `${geometry} Turn the track towards the target first so it lies ahead of the current end.`;
  if (reason.includes('radius')) return `${geometry} Approach straighter (fewer degrees left to turn), move the ends further apart, or set "minRadius" lower (not below R24).`;
  if (reason.includes('at most')) return `${geometry} Lay track nearer to the target first; a gap closer spans at most 2000 mm.`;
  return geometry;
}

function report(builder: Builder, fit: FitResult): Omit<PlanReport, 'ok' | 'name' | 'errors' | 'warnings'> {
  const project = builder.project;
  const pieces = project.routes.flatMap(route => route.pieces);
  const byId = new Map(pieces.map(piece => [piece.id, piece]));
  const origin = (piece: RoutePiece): PieceOrigin => pieceDefinition(piece.family).source === 'owned' ? 'owned' : pieceIsFast(project, piece) ? 'fast' : 'printed';
  const steps: StepReport[] = builder.steps.map(({ ids, ...step }) => ({ ...step, pieces: ids.map(id => {
    const piece = byId.get(id)!;
    return { id, family: piece.family, source: origin(piece), ...(builder.fallbacks.has(id) ? { fallback: true as const } : {}) };
  }) }));
  const routeName = (id: string | undefined) => project.routes.find(route => route.id === id)?.name;
  const stepsOf = (ids: readonly string[]) => [...new Set(ids.map(id => builder.pieceStep.get(id.split(':')[0])).filter((path): path is string => !!path))];
  const issues = new Map<string, FitIssueReport>();
  for (const issue of fit.issues) {
    const crossing = issue.crossingId ? project.crossings.find(item => item.id === issue.crossingId) : undefined;
    const route = routeName(issue.routeId) ?? (crossing ? `${routeName(crossing.upperRouteId)} over ${routeName(crossing.lowerRouteId)}` : undefined);
    const ids = [...(issue.span ?? []), ...(issue.shortfall?.pieceIds ?? []), ...(issue.message.match(UUID) ?? [])];
    // Piece ids mean nothing to the plan's author: name the step instead.
    const message = issue.message.replace(UUID, id => builder.pieceStep.get(id) ?? 'a base-project piece');
    const steps = stepsOf(ids), key = JSON.stringify([issue.code, issue.severity, message, route, steps]);
    const seen = issues.get(key);
    if (seen) seen.count++;
    else issues.set(key, { code: issue.code, severity: issue.severity, message, ...(route ? { route } : {}), steps, count: 1 });
  }
  const ends = new Map<string, OpenEndReport>();
  for (const end of openEnds(project)) {
    const label = [...builder.labels].find(([, entry]) => samePose(entry.pose, end.port))?.[0];
    const step = builder.pieceStep.get(end.pieceId);
    const report: OpenEndReport = { ...(label ? { label } : {}), ...(step ? { step } : {}), family: byId.get(end.pieceId)!.family, port: end.portId,
      x: round(end.port.x), y: round(end.port.y), z: round(end.port.z), heading: Math.round(normalize(end.port.heading) / DEG) };
    ends.set(JSON.stringify(report), report);
  }
  const owned = new Map<string, number>(), printed = new Map<string, number>(), fell = new Map<string, number>();
  let fast = 0, detailed = 0;
  for (const piece of pieces) {
    const kind = origin(piece);
    if (kind === 'owned') owned.set(piece.family, (owned.get(piece.family) ?? 0) + 1);
    else {
      printed.set(piece.family, (printed.get(piece.family) ?? 0) + 1);
      if (kind === 'fast') fast++; else detailed++;
    }
    if (builder.fallbacks.has(piece.id)) {
      const family = counterpartFamily(piece.family, 'owned') ?? piece.family;
      fell.set(family, (fell.get(family) ?? 0) + 1);
    }
  }
  const families = [...new Set([...owned.keys(), ...Object.entries(project.inventory).filter(([, count]) => count > 0).map(([family]) => family)])];
  const bill: Bill = {
    owned: families.filter(family => findPieceDefinition(family)?.source === 'owned').map(family => ({ family, used: owned.get(family) ?? 0, stock: project.inventory[family] ?? 0 })),
    printed: [...printed].map(([family, count]) => ({ family, count })),
    fallbacks: [...fell].map(([family, count]) => ({ family, count })),
    detailed, fast
  };
  const cars = project.cars.length ? project.cars : createStandardProject('').cars;
  return { steps, fit: { issues: [...issues.values()], openEnds: [...ends.values()] }, trains: trains(builder, fit, cars),
    train: { cars: cars.length, length: Math.round(consistLength(cars)), example: !project.cars.length || project.cars.every(car => car.example) }, bill };
}
const round = (value: number) => Math.round(value * 10) / 10;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Test drive on each built track: its route, with the junctions it joins set to let the train onto it. */
function trains(builder: Builder, fit: FitResult, cars: readonly Car[]): TrainReport[] {
  const result: TrainReport[] = [];
  for (const track of builder.plan.tracks) {
    const own = builder.trackPieces.get(track.id) ?? [];
    if (!own.length) continue;
    let project = builder.project;
    const route = project.routes.find(item => item.pieces.some(piece => piece.id === own[0]));
    if (!route) continue;
    const ports = own.flatMap(id => piecePorts(builder.piece(id), project));
    const switches: { id: string; state: string }[] = [];
    for (const piece of project.routes.flatMap(item => item.pieces)) {
      if (own.includes(piece.id) || !pieceStates(piece)?.length || pieceDefinition(piece.family).halt) continue;
      for (const port of piecePorts(piece, project)) {
        if (!ports.some(other => portsMate(port, other, SAME_DISTANCE, SAME_ANGLE))) continue;
        const touches = (state: string | undefined) => piecePaths(state ? { ...piece, state } : piece, project).some(path => path.enabled && (path.from === port.id || path.to === port.id));
        // Already set for it, or sprung points the train trails through from this end.
        if (touches(undefined) || piecePaths(piece, project).some(path => path.trailable && path.to === port.id)) continue;
        const state = pieceStates(piece)!.find(item => touches(item.id));
        if (state) switches.push({ id: piece.id, state: state.id });
      }
    }
    for (const change of switches) project = setPieceState(project, change.id, change.state);
    const fitted = switches.length ? fitProject(project) : fit;
    const drive = (routeId: string) => {
      const path = routePath(fitted.sections, routeId, trainGauge(cars));
      const start = placeConsist(path, cars, startingLeadDistance(cars));
      const end = placeConsist(path, cars, Math.max(startingLeadDistance(cars), finalLeadDistance(cars, path.length)));
      const reached = new Set(path.sections.map(section => section.pieceId ?? section.id.split(':')[0]));
      const missing = own.filter(id => !reached.has(id));
      const problem = trainProblem(cars, path.sections) ?? path.gap ?? start.warning ?? end.warning ??
        (missing.length ? `The train's path does not reach ${missing.length} of this track's pieces (first at ${builder.pieceStep.get(missing[0])}); a junction or a break keeps it off.` : null);
      return { routeId, path, problem };
    };
    // Test drive walks a route from its first piece and stops at a switch set against it, so a track that joins a loop
    // through a turnout fails from its own end (it laps the loop back into that turnout's other side) while another
    // route runs the same track the other way. Use the track's own route if it drives, else any route that drives over it.
    const ownRun = drive(route.id);
    const { routeId, path, problem } = ownRun.problem === null ? ownRun :
      project.routes.filter(item => item !== route).map(item => drive(item.id)).find(run => run.problem === null) ?? ownRun;
    const first = path.sections[0], last = path.sections.at(-1);
    result.push({ track: track.id, route: project.routes.find(item => item.id === routeId)!.name, ok: !problem, closed: !!first && !!last && path.sections.length > 1 && portsMatch(last.end, first.start),
      length: Math.round(path.length), switches: switches.map(change => ({ piece: builder.pieceLabel.get(change.id) ?? builder.pieceStep.get(change.id) ?? 'a base-project junction', state: change.state })), ...(problem ? { problem } : {}) });
  }
  return result;
}

/** Each problem once, in first-seen order. */
function unique(problems: readonly PlanError[]): PlanError[] {
  return [...new Map(problems.map(problem => [JSON.stringify(problem), problem])).values()];
}

export interface BuiltPlan { project: WorkshopProject; report: PlanReport }

/** Build `plan` (untrusted JSON or parsed) into a project — a new standard project unless `base` is given — and check it. */
export function buildPlan(input: unknown, base?: WorkshopProject): BuiltPlan {
  const parsed = parsePlan(input);
  const start = base ?? createStandardProject(parsed.plan?.name ?? 'Track plan');
  const empty: Bill = { owned: [], printed: [], fallbacks: [], detailed: 0, fast: 0 };
  if (!parsed.plan) return { project: start, report: { ok: false, name: 'Track plan', steps: [], errors: parsed.errors, warnings: [],
    fit: { issues: [], openEnds: [] }, trains: [], train: { cars: 0, length: 0, example: true }, bill: empty } };
  const builder = new Builder(parsed.plan, start);
  builder.build();
  // The builder reports the room check per step, with the step's path; its fit issues would say it again.
  const fitted = fitProject(builder.project), fit = { ...fitted, issues: fitted.issues.filter(issue => !ROOM_CODES.includes(issue.code)) };
  const errors = unique([...parsed.errors, ...builder.errors]);
  const rest = report(builder, fit);
  return { project: builder.project, report: { ok: !errors.length && !fit.issues.some(issue => issue.severity === 'error'), name: parsed.plan.name,
    errors, warnings: unique(builder.warnings), ...rest } };
}

/** Compact plain text of a report, for people and for a model repairing the plan. */
export function describeReport(report: PlanReport): string {
  const lines: string[] = [];
  const fitErrors = report.fit.issues.filter(issue => issue.severity === 'error');
  lines.push(`Plan "${report.name}": ${report.ok ? 'OK' : `NOT OK (${report.errors.length} plan error${report.errors.length === 1 ? '' : 's'}, ${fitErrors.length} fit error${fitErrors.length === 1 ? '' : 's'})`}`);
  if (report.steps.length) {
    lines.push('Steps:');
    for (const step of report.steps) {
      const counts = new Map<string, number>();
      for (const piece of step.pieces) {
        const key = `${piece.source} ${piece.family}${piece.fallback ? ' (no owned one left)' : ''}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const placed = [...counts].map(([key, count]) => `${count} ${key}`).join(', ');
      lines.push(`  ${step.path} ${step.did}${placed ? ` → ${placed}` : ''}${step.note ? `; ${step.note}` : ''}`);
    }
  }
  const problem = (error: PlanError) => `  ${error.path}: ${error.message}${error.hint ? ` Fix: ${error.hint}` : ''}`;
  if (report.errors.length) lines.push('Errors:', ...report.errors.map(problem));
  if (report.warnings.length) lines.push('Warnings:', ...report.warnings.map(problem));
  lines.push(report.fit.issues.length ? 'Fit:' : 'Fit: no issues.');
  for (const issue of report.fit.issues)
    lines.push(`  ${issue.severity} ${issue.code}${issue.route ? ` (${issue.route})` : ''}${issue.steps.length ? ` at ${issue.steps.join(', ')}` : ''}: ${issue.message}${issue.count > 1 ? ` (on ${issue.count} pieces)` : ''}`);
  lines.push(report.fit.openEnds.length ? 'Open ends:' : 'Open ends: none.');
  for (const end of report.fit.openEnds)
    lines.push(`  ${end.label ?? `${end.family} port ${end.port}`}${end.step ? ` (${end.step})` : ''} at (${Math.round(end.x)}, ${Math.round(end.y)}${end.z ? `, z ${end.z}` : ''}) heading ${end.heading}°`);
  if (report.trains.length) {
    lines.push(`Trains (${report.train.example ? 'example train' : 'your train'}: ${report.train.cars} cars, ${report.train.length} mm):`);
    for (const train of report.trains) {
      const switches = train.switches.length ? ` with ${train.switches.map(item => `${item.piece}=${item.state}`).join(', ')}` : '';
      lines.push(`  ${train.track} (${train.route})${switches}: ${train.ok ? `runs ${train.closed ? 'round a loop' : 'end to end'}, ${(train.length / 1000).toFixed(2)} m` : `cannot run: ${train.problem}`}`);
    }
  }
  const { bill } = report;
  const owned = bill.owned.map(item => `${item.family} ${item.used}/${item.stock}`).join(', ');
  const printed = bill.printed.map(item => `${item.family} ×${item.count}`).join(', ');
  lines.push(`Bill: owned used/stock: ${owned || 'none'}; printed: ${printed || 'none'} (${bill.detailed} full detail, ${bill.fast} fast)` +
    `${bill.fallbacks.length ? `; printed because no owned one was left: ${bill.fallbacks.map(item => `${item.family} ×${item.count}`).join(', ')}` : ''}.`);
  return lines.join('\n');
}
