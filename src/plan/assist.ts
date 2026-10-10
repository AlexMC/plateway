import { changeProject, type WorkshopProject } from '../domain/project';
import { piecePorts } from '../domain/pieces';
import { createStandardProject, MEASUREMENT_DEFAULTS } from '../editor/setup-defaults';
import { consistLength } from '../drive/train';
import { baseReferences, buildPlan, describeReport, type BuiltPlan, type PlanReport } from './build';

/**
 * "Describe the track": a model writes a track plan from the user's words, the builder lays and checks it here, and the
 * report goes back to the model until the plan builds cleanly or the repair rounds run out. The Build panel and
 * scripts/plan-eval.ts both run this loop; the model is called from here on the user's own key (`anthropic.ts`).
 */

/** `fresh` replaces the layout's track (setup, room, shelves, inventory and cars stay); `add` builds onto it. */
export type AssistMode = 'fresh' | 'add';

/** What the model knows about the user's layout: everything a plan may refer to, in the plan's own names. */
export interface PlanContext {
  mode: AssistMode;
  room: { width: number; depth: number; measured: boolean };
  trackSystem: WorkshopProject['trackSystem'];
  printer: WorkshopProject['printer'];
  /** Owned pieces by family (only families the user has). */
  inventory: Record<string, number>;
  train: { cars: number; length: number; example: boolean };
  /** Shelves already in the room; a plan starts at their cubbies by these ids and must not add them again. */
  shelves: { id: string; x: number; y: number; quarterTurns: number }[];
  /** `add` only: the track the plan builds onto, its open ends by reference and the area it covers. */
  existingTrack: { pieces: number; openEnds: { ref: string; x: number; y: number; z: number; heading: number }[];
    area: { minX: number; minY: number; maxX: number; maxY: number } | null } | null;
}

export interface PlanRequest {
  description: string;
  context: PlanContext;
  /** The current plan: with `report` it is repaired, without it is changed as `description` asks. */
  plan?: unknown;
  /** describeReport text of building `plan`. */
  report?: string;
  /** Earlier requests, oldest first (the first description, then each refinement). */
  history?: string[];
}
export interface PlanUsage {
  model: string; input_tokens: number; output_tokens: number;
  cache_read_input_tokens: number; cache_creation_input_tokens: number;
}
export interface PlanReply { plan: unknown; notes: string; usage?: PlanUsage }
export type PlanClient = (request: PlanRequest, signal?: AbortSignal) => Promise<PlanReply>;

/** A refused or failed model call, with its user-facing message and HTTP status (0: no answer; 401: the key was rejected). */
export class AssistError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The user's Anthropic key stays in this browser (KTD4): in `sessionStorage`, or in `localStorage` when they ask to be
 * remembered on this device. Signing out forgets it. */
export const KEY_ITEM = 'train-layout-workshop:anthropic-key';
export type StoredKey = { key: string; remembered: boolean };
const keyListeners = new Set<() => void>();

export function storedKey(): StoredKey | null {
  try {
    const session = sessionStorage.getItem(KEY_ITEM);
    if (session) return { key: session, remembered: false };
    const kept = localStorage.getItem(KEY_ITEM);
    return kept ? { key: kept, remembered: true } : null;
  } catch { return null; }
}

/** Throws when the browser blocks storage. */
export function storeKey(key: string, remember: boolean): void {
  try {
    (remember ? localStorage : sessionStorage).setItem(KEY_ITEM, key);
    (remember ? sessionStorage : localStorage).removeItem(KEY_ITEM);
  } finally { keyListeners.forEach(listener => listener()); }
}

export function forgetKey(): void {
  try {
    sessionStorage.removeItem(KEY_ITEM);
    localStorage.removeItem(KEY_ITEM);
  } catch { /* storage is blocked: nothing was kept */ }
  keyListeners.forEach(listener => listener());
}

/** Calls `listener` whenever the key is stored or forgotten, here or (a remembered key) in another tab. */
export function watchKey(listener: () => void): () => void {
  keyListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => { keyListeners.delete(listener); window.removeEventListener('storage', listener); };
}

/** The project a plan is built onto: as it is (`add`), or without its track (`fresh`). */
export function assistBase(project: WorkshopProject, mode: AssistMode): WorkshopProject {
  if (mode === 'add' || (!project.routes.length && !project.crossings.length)) return project;
  return changeProject(project, draft => { draft.routes = []; draft.crossings = []; });
}

/** The context the model sees for building onto `base` (already `assistBase`d). */
export function planContext(base: WorkshopProject, mode: AssistMode): PlanContext {
  const width = base.measurements.roomWidth.value ?? MEASUREMENT_DEFAULTS.roomWidth!;
  const depth = base.measurements.roomDepth.value ?? MEASUREMENT_DEFAULTS.roomDepth!;
  const measured = [base.measurements.roomWidth, base.measurements.roomDepth].every(item => item.value !== null && item.status !== 'estimate');
  const known = baseReferences(base);
  const pieces = base.routes.flatMap(route => route.pieces);
  // The train check runs the example train when the project has no cars of its own.
  const cars = base.cars.length ? base.cars : createStandardProject('').cars;
  const ports = pieces.flatMap(piece => piecePorts(piece, base));
  const area = ports.length ? { minX: Math.round(Math.min(...ports.map(port => port.x))), minY: Math.round(Math.min(...ports.map(port => port.y))),
    maxX: Math.round(Math.max(...ports.map(port => port.x))), maxY: Math.round(Math.max(...ports.map(port => port.y))) } : null;
  return {
    mode, room: { width, depth, measured }, trackSystem: base.trackSystem, printer: base.printer,
    inventory: Object.fromEntries(Object.entries(base.inventory).filter(([, count]) => count > 0)),
    train: { cars: cars.length, length: Math.round(consistLength(cars)), example: cars.every(car => car.example) },
    shelves: known.shelves.map(({ id, x, y, quarterTurns }) => ({ id, x: Math.round(x), y: Math.round(y), quarterTurns })),
    existingTrack: mode === 'add' && pieces.length ? { pieces: pieces.length, area,
      openEnds: known.ends.map(({ ref, pose }) => ({ ref, x: Math.round(pose.x), y: Math.round(pose.y), z: Math.round(pose.z), heading: Math.round(pose.heading * 180 / Math.PI) })) } : null
  };
}

export type AssistProgress =
  | { stage: 'drafting' | 'refining' | 'checking' }
  | { stage: 'repairing'; round: number; of: number; problem: string };

export function progressText(progress: AssistProgress): string {
  switch (progress.stage) {
    case 'drafting': return 'Drafting…';
    case 'refining': return 'Changing the plan…';
    case 'checking': return 'Laying and checking the plan…';
    case 'repairing': return `Fixing: ${progress.problem} (round ${progress.round}/${progress.of})`;
  }
}

/** The first problem of a report, in a few words for the progress line. */
export function problemHeadline(report: PlanReport): string {
  const message = report.errors[0]?.message ?? report.fit.issues.find(issue => issue.severity === 'error')?.message ??
    report.trains.find(train => !train.ok)?.problem ?? 'problems remain';
  const known: [RegExp, string][] = [
    [/^close to .* failed/i, 'a loop doesn’t close'], [/leaves the .* room/i, 'track leaves the room'],
    [/runs into .* panels/i, 'track runs into a shelf'], [/lands on existing track/i, 'track overlaps other track'],
    [/^Unknown key|^Unknown piece family|is not a valid|must be|out of range/i, 'the plan has invalid entries'],
    [/^Unknown reference|is not built yet|already joined|no longer exists/i, 'a reference points nowhere']
  ];
  const match = known.find(([pattern]) => pattern.test(message));
  if (match) return match[1];
  const sentence = message.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return sentence.length > 70 ? `${sentence.slice(0, 67)}…` : sentence;
}

/** Plan errors plus fit errors: what keeps a report from `ok`. */
export const problemCount = (report: PlanReport) => report.errors.length + report.fit.issues.filter(issue => issue.severity === 'error').length;

export interface AssistAttempt { plan: unknown; notes: string; built: BuiltPlan; text: string }
export interface AssistResult {
  /** The attempt to show: the first that builds cleanly, else the one with the fewest problems (latest on a tie). */
  plan: unknown; notes: string; built: BuiltPlan; ok: boolean;
  /** Repair rounds used (0: the first plan was clean). */
  repairs: number;
  attempts: AssistAttempt[];
  usage: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; model?: string };
  /** Requests so far, oldest first; pass it back with a refinement. */
  history: string[];
  /** Why repairing stopped early: a repair call failed, so the best plan so far is kept. */
  stopped?: string;
}

export interface AssistOptions {
  client: PlanClient;
  /** The project as the user has it now. */
  project: WorkshopProject;
  mode: AssistMode;
  /** What the user asked for; for a refinement, the change. */
  description: string;
  /** Refine this plan (with the requests that led to it) instead of drafting a new one. */
  previous?: { plan: unknown; history: string[] };
  maxRepairs?: number;
  onProgress?: (progress: AssistProgress) => void;
  signal?: AbortSignal;
}

export const MAX_REPAIRS = 3;

/** Draft (or refine) a plan, build it, and send the report back for repair until it is clean or `maxRepairs` run out. */
export async function assistPlan({ client, project, mode, description, previous, maxRepairs = MAX_REPAIRS, onProgress, signal }: AssistOptions): Promise<AssistResult> {
  const base = assistBase(project, mode), context = planContext(base, mode);
  const history = previous?.history ?? [];
  const usage: AssistResult['usage'] = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const attempts: AssistAttempt[] = [];
  const ask = async (request: PlanRequest): Promise<PlanReply> => {
    signal?.throwIfAborted();
    const reply = await client(request, signal);
    usage.calls++;
    if (reply.usage) {
      usage.input += reply.usage.input_tokens; usage.output += reply.usage.output_tokens;
      usage.cacheRead += reply.usage.cache_read_input_tokens; usage.cacheWrite += reply.usage.cache_creation_input_tokens;
      usage.model = reply.usage.model;
    }
    signal?.throwIfAborted();
    return reply;
  };
  const check = (reply: PlanReply): AssistAttempt => {
    onProgress?.({ stage: 'checking' });
    const built = buildPlan(reply.plan, base);
    const attempt = { plan: reply.plan, notes: reply.notes, built, text: describeReport(built.report) };
    attempts.push(attempt);
    return attempt;
  };
  onProgress?.({ stage: previous ? 'refining' : 'drafting' });
  let attempt = check(await ask({ description, context, ...(previous ? { plan: previous.plan } : {}), ...(history.length ? { history } : {}) }));
  let repairs = 0, stopped: string | undefined;
  while (!attempt.built.report.ok && repairs < maxRepairs) {
    repairs++;
    onProgress?.({ stage: 'repairing', round: repairs, of: maxRepairs, problem: problemHeadline(attempt.built.report) });
    try {
      attempt = check(await ask({ description, context, plan: attempt.plan, report: attempt.text, ...(history.length ? { history } : {}) }));
    } catch (error) {
      // A failed repair call keeps what was drafted; only a cancel throws away the run.
      if (signal?.aborted) throw error;
      stopped = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const best = attempt.built.report.ok ? attempt :
    attempts.reduce((choice, item) => problemCount(item.built.report) <= problemCount(choice.built.report) ? item : choice);
  return { plan: best.plan, notes: best.notes, built: best.built, ok: best.built.report.ok, repairs, attempts, usage, history: [...history, description],
    ...(stopped ? { stopped } : {}) };
}
