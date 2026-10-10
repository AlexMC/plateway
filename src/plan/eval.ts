import { furnitureType } from '../domain/furniture';
import type { WorkshopProject } from '../domain/project';
import { physicalPaths, piecePaths, piecePorts, portsFromPaths, portsMate } from '../domain/pieces';
import { placeFurniture } from '../editor/furniture';
import { createStandardProject, setSetupInventory, setSetupMeasurement } from '../editor/setup-defaults';
import { fitProject } from '../fitting/fit';
import type { AssistResult } from './assist';
import type { BuiltPlan } from './build';

/**
 * The describe-the-track eval (docs/plans/eval/cases.json, scripts/plan-eval.ts): realistic requests, each with
 * machine checks on what the loop produced. Every check is measured on the built project and report, never on the
 * plan's text, so a plan cannot pass by naming the right things.
 */

export interface EvalSetup {
  room: [number, number];
  /** Owned counts by family; families not listed keep the Setup default. */
  inventory: Record<string, number>;
  /** A KALLAX 5×5 already in the room, or null. */
  kallax: { x: number; y: number; quarterTurns: 0 | 1 | 2 | 3 } | null;
}

/** Minimums are "at least"; booleans must hold when given. */
export interface EvalChecks {
  reportOk?: boolean;
  /** Test drive runs the train on every track of the plan. */
  trainsRun?: boolean;
  withinRoom?: boolean;
  /** Nothing printed: only the owned pieces. */
  ownedOnly?: boolean;
  /** Every printed piece in the fast-print style. */
  fastOnly?: boolean;
  /** Tracks the train runs round as a loop. */
  loopsClosed?: number;
  turnouts?: number;
  buffers?: number;
  /** Track standing inside a KALLAX's footprint (through a cubby). */
  entersKallax?: boolean;
  /** Highest track end above the table, mm. */
  maxZ?: number;
  /** Grade-separated crossings (one route over another). */
  crossings?: number;
  /** At-grade crossing pieces (90° crossings, diamonds, slips). */
  levelCrossings?: number;
  /** Helix sections laid. */
  helix?: number;
  /** Cycles that bring the track back on itself the other way round (balloon/reversing loops, wyes). */
  reversingLoops?: number;
  /** Extent of the track, mm. */
  spanX?: number;
  spanY?: number;
  /** A regular expression (case-insensitive) the model's notes must match. */
  notesMention?: string;
  /** A regular expression (case-insensitive) the model's notes must not match. */
  notesAvoid?: string;
}
export interface EvalCase { id: string; description: string; setup?: Partial<EvalSetup>; checks: EvalChecks }
export interface EvalCases { about?: string; setup: EvalSetup; cases: EvalCase[] }

/** The project a case starts from: Setup's standard project in the case's room, inventory and shelf. */
export function evalProject(name: string, defaults: EvalSetup, override: Partial<EvalSetup> = {}): WorkshopProject {
  const setup = { ...defaults, ...override, inventory: { ...defaults.inventory, ...override.inventory } };
  let project = setSetupMeasurement(setSetupMeasurement(createStandardProject(name), 'roomWidth', setup.room[0]), 'roomDepth', setup.room[1]);
  for (const [family, count] of Object.entries(setup.inventory)) project = setSetupInventory(project, family, count);
  if (setup.kallax) project = placeFurniture(project, setup.kallax, setup.kallax.quarterTurns)[0];
  return project;
}

export interface EvalMetrics {
  pieces: number; loopsClosed: number; turnouts: number; buffers: number; helix: number; levelCrossings: number;
  crossings: number; reversingLoops: number; maxZ: number; spanX: number; spanY: number; entersKallax: boolean;
  withinRoom: boolean; ownedOnly: boolean; fastOnly: boolean; trainsRun: boolean; reportOk: boolean;
}

/** Odd cycles of the rail two-colouring: each is a place where the track meets itself turned round. */
function reversingLoops(project: WorkshopProject): number {
  const pieces = project.routes.flatMap(route => route.pieces);
  const parent = new Map<string, string>(), parity = new Map<string, number>();
  const find = (node: string): [string, number] => {
    if (!parent.has(node)) { parent.set(node, node); parity.set(node, 0); }
    let root = node, flips = 0;
    while (parent.get(root) !== root) { flips ^= parity.get(root)!; root = parent.get(root)!; }
    return [root, flips];
  };
  const odd = new Set<string>();
  const join = (a: string, b: string, swap: number) => {
    const [ra, pa] = find(a), [rb, pb] = find(b);
    if (ra !== rb) { parent.set(rb, ra); parity.set(rb, pa ^ pb ^ swap); }
    else if ((pa ^ pb) !== swap) odd.add(`${a}|${b}`);
  };
  const ports = pieces.map(piece => {
    const paths = physicalPaths(piecePaths(piece, project));
    for (const path of paths) join(`${piece.id}:${path.from}`, `${piece.id}:${path.to}`, 1);
    return portsFromPaths(paths);
  });
  pieces.forEach((piece, index) => {
    for (const port of ports[index]) for (let other = index + 1; other < pieces.length; other++) {
      const found = ports[other].find(candidate => portsMate(port, candidate, 0.5, 0.01));
      if (found) join(`${piece.id}:${port.id}`, `${pieces[other].id}:${found.id}`, 1);
    }
  });
  return odd.size;
}

export function measurePlan(built: BuiltPlan): EvalMetrics {
  const { project, report } = built;
  const pieces = project.routes.flatMap(route => route.pieces);
  const ports = pieces.flatMap(piece => piecePorts(piece, project));
  const xs = ports.map(port => port.x), ys = ports.map(port => port.y);
  const inside = (shelf: WorkshopProject['furniture'][number]) => ports.some(port => {
    const angle = shelf.quarterTurns * Math.PI / 2, dx = port.x - shelf.x, dy = port.y - shelf.y, { width, depth } = furnitureType(shelf.family);
    const along = dx * Math.cos(angle) + dy * Math.sin(angle), across = -dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.abs(along) < width / 2 && Math.abs(across) < depth / 2 - 1;
  });
  const count = (pattern: RegExp) => pieces.filter(piece => pattern.test(piece.family)).length;
  return {
    pieces: pieces.length,
    loopsClosed: report.trains.filter(train => train.ok && train.closed).length,
    turnouts: count(/switch|turnout|crossover|slip/),
    buffers: count(/^buffer_stop$/),
    helix: count(/^helix_curve$/),
    levelCrossings: count(/crossing90|diamond|slip/),
    crossings: pieces.length ? fitProject(project).crossings.length : 0,
    reversingLoops: reversingLoops(project),
    maxZ: ports.length ? Math.round(Math.max(...ports.map(port => port.z))) : 0,
    spanX: xs.length ? Math.round(Math.max(...xs) - Math.min(...xs)) : 0,
    spanY: ys.length ? Math.round(Math.max(...ys) - Math.min(...ys)) : 0,
    entersKallax: project.furniture.some(item => item.family === 'kallax_5x5' && inside(item)),
    withinRoom: !report.errors.some(error => /leaves the .* room/.test(error.message)),
    ownedOnly: pieces.length > 0 && report.bill.printed.length === 0,
    fastOnly: report.bill.fast > 0 && report.bill.detailed === 0,
    trainsRun: report.trains.length > 0 && report.trains.every(train => train.ok),
    reportOk: report.ok
  };
}

export interface CheckResult { check: string; pass: boolean; expected: string; actual: string }

export function scoreCase(checks: EvalChecks, metrics: EvalMetrics, notes: string): CheckResult[] {
  return Object.entries(checks).map(([check, expected]): CheckResult => {
    if (check === 'notesMention' || check === 'notesAvoid') {
      const matched = new RegExp(String(expected), 'i').test(notes);
      const pass = check === 'notesMention' ? matched : !matched;
      return { check, pass, expected: `${check === 'notesAvoid' ? 'not ' : ''}/${expected}/i`, actual: matched ? 'matched' : 'no match' };
    }
    const actual = metrics[check as keyof EvalMetrics];
    if (actual === undefined) throw new Error(`Unknown check "${check}".`);
    const pass = typeof expected === 'number' ? Number(actual) >= expected : actual === expected;
    return { check, pass, expected: typeof expected === 'number' ? `≥ ${expected}` : String(expected), actual: String(actual) };
  });
}

/** One case's outcome, as written to the eval's JSON file. */
export interface EvalOutcome {
  id: string; description: string; seconds: number;
  ok: boolean; repairs: number;
  /** All tokens the model processed: input, output and prompt-cache reads and writes. */
  tokens: number;
  checks: CheckResult[]; metrics: EvalMetrics | null;
  notes: string; plan: unknown; report: unknown; reportText: string;
  attempts: { plan: unknown; notes: string; reportText: string }[];
  usage: AssistResult['usage'] | null;
  /** The loop failed outright (no plan at all). */
  error?: string;
  /** A repair call failed; the best plan so far was scored. */
  stopped?: string;
}

export function evalOutcome(test: EvalCase, result: AssistResult, seconds: number): EvalOutcome {
  const metrics = measurePlan(result.built);
  return {
    id: test.id, description: test.description, seconds, ok: result.ok, repairs: result.repairs,
    tokens: result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite, checks: scoreCase(test.checks, metrics, result.notes), metrics,
    notes: result.notes, plan: result.plan, report: result.built.report,
    reportText: result.attempts.find(attempt => attempt.plan === result.plan)?.text ?? '',
    attempts: result.attempts.map(attempt => ({ plan: attempt.plan, notes: attempt.notes, reportText: attempt.text })), usage: result.usage,
    ...(result.stopped ? { stopped: result.stopped } : {})
  };
}
