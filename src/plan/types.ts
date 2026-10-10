import { findPieceDefinition } from '../domain/pieces';

/**
 * Track plan language v1: a JSON description of a layout that `buildPlan` lays with the editor's own operations.
 * docs/track-plan-language.md is the reference; `parsePlan` turns untrusted JSON into these normalized types.
 */

/** Where pieces come from: the user's own track while stock lasts, printed full detail, or printed fast print. */
export type PlanSource = 'owned' | 'printed' | 'fast';
export type Turn = 'left' | 'right';
/** A position and heading in the room frame: millimetres, heading in radians (0 = +x, π/2 = +y), z above the table. */
export interface Pose { x: number; y: number; z: number; heading: number }

/** One plan problem: where (`tracks[1].steps[3]`), what failed, and what would fix it.
 * `space`: the track or a shelf does not fit the room (`room`), or track runs into a shelf's panels (`shelf`). */
export interface PlanError { path: string; message: string; hint?: string; space?: 'room' | 'shelf' }

export interface PlanKallax { id: string; x: number; y: number; quarterTurns: 0 | 1 | 2 | 3 }

export type PlanStart =
  | { kind: 'pose'; pose: Pose }
  | { kind: 'from'; ref: string }
  /** `row`/`col` count 1..5 from the bottom-left as seen from the front. */
  | { kind: 'kallax'; furniture: string; row: number; col: number; side: 'front' | 'back' };

/** How a junction or other multi-port piece is entered and left; `enter`/`follow` are port ids of the family. */
interface PortChoice { enter?: string; follow?: string; as?: string }

export type PlanAction =
  | { kind: 'straight'; length: number; count: number }
  /** `radius` mm; `turn` +1 left, −1 right; `angle` degrees, positive. */
  | { kind: 'curve'; radius: number; turn: 1 | -1; angle: number }
  /** Millimetres (the plan states them in studs); `offset` is signed, + shifts left. `radius` set means `length` is solved from it. */
  | { kind: 'sbend'; offset: number; length: number | null; middle: number; radius: number | null }
  | ({ kind: 'turnout'; type: 'left' | 'right' | 'wye' | 'three-way' | null; family: string | null; params: Record<string, number>; set?: string } & PortChoice)
  | ({ kind: 'crossing'; type: '90' | null; family: string | null; params: Record<string, number>; set?: string } & PortChoice)
  | { kind: 'ramp'; rise: number; grade: number }
  | { kind: 'raise'; to: number; grade: number }
  /** `radius` mm; `hand` +1 left, −1 right; `direction` +1 climbs; `rise` mm per turn (null: the least that clears trains). */
  | { kind: 'helix'; turns: number; radius: number; hand: 1 | -1; direction: 1 | -1; rise: number | null; columns: number }
  | ({ kind: 'piece'; family: string; params: Record<string, number>; state?: string; sweep?: number; rise?: number; bend?: number } & PortChoice)
  | { kind: 'buffer'; length: 32 | 64 }
  | { kind: 'close'; target: string; minRadius: number | null };

export type PlanStep = PlanAction & { source?: PlanSource };
export interface PlanTrack {
  id: string; start: PlanStart;
  /** One entry per authored step; null where the step did not validate (its errors are reported). */
  steps: (PlanStep | null)[];
}
export interface Plan {
  version: 1; name: string; prefer: PlanSource;
  /** One plain line about the layout (Build's example gallery shows it). */
  description?: string;
  furniture: PlanKallax[];
  tracks: PlanTrack[];
}

/** One stud, mm: radii are written R<studs> and S-bend sizes in studs, as the palette chips show them. */
export const STUD = 8;
const SOURCES: readonly PlanSource[] = ['owned', 'printed', 'fast'];
const ACTIONS = ['straight', 'curve', 'sbend', 'turnout', 'crossing', 'ramp', 'raise', 'helix', 'piece', 'buffer', 'close'] as const;
/** Keys each action allows beside its own and `source`. */
const EXTRA_KEYS: Record<typeof ACTIONS[number], readonly string[]> = {
  straight: ['count'], curve: ['turn', 'angle'], sbend: [], turnout: ['as', 'set', 'enter', 'follow'],
  crossing: ['as', 'set', 'enter', 'follow'], ramp: [], raise: [], helix: [],
  piece: ['params', 'state', 'as', 'enter', 'follow', 'sweep', 'rise', 'bend'], buffer: [], close: ['minRadius']
};
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** The printed family each named turnout or crossing lays (its owned counterpart replaces it while in stock). */
export const NAMED_FAMILIES: Record<string, string> = {
  left: 'printed_switch_left', right: 'printed_switch_right', wye: 'turnout_wye', 'three-way': 'turnout_three_way', '90': 'printed_crossing90'
};
/** Grade Go up or down (`ramp`, `raise`) uses unless the plan says otherwise, percent (the editor's default). */
export const DEFAULT_GRADE = 4;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const list = (values: readonly string[]) => values.map(value => `"${value}"`).join(', ');

/** "R40" → 320 mm; a bare number is already millimetres. */
export function parseRadius(value: unknown): number | null {
  if (finite(value)) return value;
  const match = typeof value === 'string' ? /^R(\d+(?:\.\d+)?)$/i.exec(value.trim()) : null;
  return match ? Number(match[1]) * STUD : null;
}
/** "R40" for 320 mm, else "<mm> mm". */
export function formatRadius(mm: number): string {
  return Number.isInteger(mm / STUD) ? `R${mm / STUD}` : `${Number(mm.toFixed(1))} mm`;
}

/** Collects errors while validating one plan; every check reports and carries on, so one pass lists every problem. */
class Checker {
  errors: PlanError[] = [];
  fail(path: string, message: string, hint?: string): null {
    this.errors.push({ path, message, ...(hint ? { hint } : {}) });
    return null;
  }
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): boolean {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    for (const key of unknown) this.fail(`${path}.${key}`, `Unknown key "${key}".`, `Allowed here: ${list(allowed)}.`);
    return unknown.length === 0;
  }
  number(value: unknown, path: string, what: string, min: number, max: number): number | null {
    if (!finite(value)) return this.fail(path, `${what} must be a number.`, `Use a number from ${min} to ${max}.`);
    if (value < min || value > max) return this.fail(path, `${what} ${value} is out of range.`, `Use ${min} to ${max}.`);
    return value;
  }
  choice<T extends string>(value: unknown, path: string, what: string, options: readonly T[]): T | null {
    return options.includes(value as T) ? value as T : this.fail(path, `${what} must be one of ${list(options)}; got ${JSON.stringify(value)}.`);
  }
  label(value: unknown, path: string): string | null {
    return typeof value === 'string' && ID.test(value) ? value :
      this.fail(path, `Label ${JSON.stringify(value)} is not a valid name.`, 'Start with a letter; use letters, digits, "-" or "_" (no dots).');
  }
  params(value: unknown, path: string, family: string | null): Record<string, number> | null {
    if (value === undefined) return {};
    if (!isObject(value) || !Object.values(value).every(finite)) return this.fail(path, 'params must be an object of numbers.', 'For example {"radius": 56, "hand": -1}.');
    const definition = family ? findPieceDefinition(family) : undefined;
    let ok = true;
    if (definition) for (const [key, number] of Object.entries(value as Record<string, number>)) {
      const spec = definition.params.find(item => item.key === key);
      if (!spec) ok = !!this.fail(`${path}.${key}`, `${definition.label} (${family}) has no "${key}" parameter.`,
        definition.params.length ? `Its parameters: ${list(definition.params.filter(item => !item.hidden).map(item => item.key))}.` : 'It takes no parameters.');
      else if (number < spec.min || number > spec.max) ok = !!this.fail(`${path}.${key}`, `${spec.label} ${number} is out of range.`, `Use ${spec.min} to ${spec.max}${spec.unit ? ` ${spec.unit}` : ''}.`);
    }
    return ok ? value as Record<string, number> : null;
  }
  family(value: unknown, path: string): string | null {
    if (typeof value !== 'string') return this.fail(path, 'family must be a string.');
    return findPieceDefinition(value) ? value : this.fail(path, `Unknown piece family "${value}".`,
      'Use a registered family id such as "track_straight", "track_curve", "turnout_radius", "buffer_stop" or "track_diamond"; see the family list in docs/track-plan-language.md.');
  }
  state(value: unknown, path: string, family: string | null): string | undefined | null {
    if (value === undefined) return undefined;
    const states = family ? findPieceDefinition(family)?.states : undefined;
    if (typeof value !== 'string') return this.fail(path, 'The state must be a string.');
    if (family && !states) return this.fail(path, `${family} has no settings to set.`, 'Remove "set"/"state".');
    if (states && !states.some(state => state.id === value)) return this.fail(path, `${family} has no state "${value}".`, `Its states: ${list(states.map(state => state.id))}.`);
    return value;
  }
  ports(raw: Record<string, unknown>, path: string): PortChoice | null {
    const result: PortChoice = {};
    for (const key of ['enter', 'follow'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'string') return this.fail(`${path}.${key}`, `${key} must be a port id string such as "in", "out" or "branch".`);
      result[key] = raw[key] as string;
    }
    if (raw.as !== undefined) {
      const label = this.label(raw.as, `${path}.as`);
      if (label === null) return null;
      result.as = label;
    }
    return result;
  }
}

function parseStart(check: Checker, raw: unknown, path: string): PlanStart | null {
  if (!isObject(raw)) return check.fail(path, 'start must be an object.',
    'Use {"x": 600, "y": 500, "heading": 0}, {"from": "A.branch"} or {"kallax": "K1", "cubby": [1, 3], "side": "front"}.');
  if ('from' in raw) {
    if (!check.keys(raw, path, ['from'])) return null;
    return typeof raw.from === 'string' && /^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(raw.from) ? { kind: 'from', ref: raw.from } :
      check.fail(`${path}.from`, `Reference ${JSON.stringify(raw.from)} is not "<label>.<port>".`, 'For example "A.branch", "main.end" or "main.start".');
  }
  if ('kallax' in raw) {
    if (!check.keys(raw, path, ['kallax', 'cubby', 'side'])) return null;
    const id = check.label(raw.kallax, `${path}.kallax`);
    const cubby = Array.isArray(raw.cubby) && raw.cubby.length === 2 && raw.cubby.every(n => Number.isInteger(n) && n >= 1 && n <= 5) ? raw.cubby as [number, number] :
      check.fail(`${path}.cubby`, `cubby must be [row, col] with each 1 to 5; got ${JSON.stringify(raw.cubby)}.`, 'Rows count from the bottom, columns from the left as seen from the front: [1, 1] is the bottom-left cubby.');
    const side = raw.side === undefined ? 'front' : check.choice(raw.side, `${path}.side`, 'side', ['front', 'back'] as const);
    return id && cubby && side ? { kind: 'kallax', furniture: id, row: cubby[0], col: cubby[1], side } : null;
  }
  if (!check.keys(raw, path, ['x', 'y', 'heading', 'z'])) return null;
  const x = check.number(raw.x, `${path}.x`, 'x', -100000, 100000), y = check.number(raw.y, `${path}.y`, 'y', -100000, 100000);
  const heading = raw.heading === undefined ? 0 : check.number(raw.heading, `${path}.heading`, 'heading', -360, 360);
  const z = raw.z === undefined ? 0 : check.number(raw.z, `${path}.z`, 'z', -400, 2000);
  return x === null || y === null || heading === null || z === null ? null : { kind: 'pose', pose: { x, y, z, heading: heading * Math.PI / 180 } };
}

function parseStep(check: Checker, raw: unknown, path: string): PlanStep | null {
  if (!isObject(raw)) return check.fail(path, 'A step must be an object.', `Give exactly one of ${list(ACTIONS)}.`);
  const actions = ACTIONS.filter(action => action in raw);
  if (actions.length !== 1) return check.fail(path, actions.length ? `A step has one action; this one has ${list(actions)}.` : 'This step has no action.',
    `Give exactly one of ${list(ACTIONS)} (plus its options).`);
  const action = actions[0];
  if (!check.keys(raw, path, [action, 'source', ...EXTRA_KEYS[action]])) return null;
  const source = raw.source === undefined ? undefined : check.choice(raw.source, `${path}.source`, 'source', SOURCES);
  if (source === null) return null;
  const step = parseAction(check, raw, path, action);
  return step && (source ? { ...step, source } : step);
}

function parseAction(check: Checker, raw: Record<string, unknown>, path: string, action: typeof ACTIONS[number]): PlanAction | null {
  const at = `${path}.${action}`, value = raw[action];
  const object = (keys: readonly string[]): Record<string, unknown> | null => {
    if (!isObject(value)) return check.fail(at, `${action} takes an object.`, `Keys: ${list(keys)}.`);
    return check.keys(value, at, keys) ? value : null;
  };
  switch (action) {
    case 'straight': {
      const length = check.number(value, at, 'Straight length (mm)', 24, 2000);
      const count = raw.count === undefined ? 1 : Number.isInteger(raw.count) && (raw.count as number) >= 1 && (raw.count as number) <= 100 ? raw.count as number :
        check.fail(`${path}.count`, `count must be a whole number from 1 to 100; got ${JSON.stringify(raw.count)}.`);
      return length === null || count === null ? null : { kind: 'straight', length, count };
    }
    case 'curve': {
      const radius = parseRadius(value);
      if (radius === null) check.fail(at, `Curve radius ${JSON.stringify(value)} is not R<studs> or millimetres.`, 'For example "R40" (320 mm) or 576.');
      else if (radius < 192 || radius > 1472) check.fail(at, `Curve radius ${formatRadius(radius)} is out of range.`, 'Use R24 to R184 (192 to 1472 mm).');
      const turn = check.choice(raw.turn, `${path}.turn`, 'turn', ['left', 'right'] as const);
      const angle = check.number(raw.angle, `${path}.angle`, 'Curve angle (degrees)', 0.5, 1440);
      return radius === null || radius < 192 || radius > 1472 || turn === null || angle === null ? null :
        { kind: 'curve', radius, turn: turn === 'left' ? 1 : -1, angle };
    }
    case 'sbend': {
      const body = object(['offset', 'length', 'middle', 'radius', 'turn']);
      if (!body) return null;
      const offset = check.number(body.offset, `${at}.offset`, 'S-bend offset (studs)', 1, 64);
      const length = body.length === undefined ? null : check.number(body.length, `${at}.length`, 'S-bend length (studs)', 8, 250);
      const middle = body.middle === undefined ? 0 : check.number(body.middle, `${at}.middle`, 'Straight between (studs)', 0, 125);
      const radius = body.radius === undefined ? null : parseRadius(body.radius);
      if (body.radius !== undefined && radius === null) check.fail(`${at}.radius`, `S-bend radius ${JSON.stringify(body.radius)} is not R<studs> or millimetres.`);
      if (body.length === undefined && body.radius === undefined) check.fail(at, 'An S-bend needs its length (studs) or its radius.', 'For example {"offset": 16, "length": 48, "turn": "left"}.');
      const turn = check.choice(body.turn, `${at}.turn`, 'turn', ['left', 'right'] as const);
      if (offset === null || middle === null || turn === null || (body.length !== undefined && length === null) || (body.radius !== undefined && radius === null) ||
        (body.length === undefined && body.radius === undefined)) return null;
      return { kind: 'sbend', offset: (turn === 'left' ? 1 : -1) * offset * STUD, length: length === null ? null : length * STUD, middle: middle * STUD, radius };
    }
    case 'turnout':
    case 'crossing': {
      const types = action === 'turnout' ? ['left', 'right', 'wye', 'three-way'] as const : ['90'] as const;
      let type: string | null = null, family: string | null = null, params: Record<string, number> | null = {};
      if (isObject(value)) {
        if (!check.keys(value, at, ['family', 'params'])) return null;
        family = check.family(value.family, `${at}.family`);
        params = check.params(value.params, `${at}.params`, family);
      } else if ((types as readonly string[]).includes(value as string)) type = value as string;
      else return check.fail(at, `Unknown ${action} ${JSON.stringify(value)}.`, `Use ${list(types)} or {"family": "...", "params": {...}}.`);
      const ports = check.ports(raw, path);
      const set = check.state(raw.set, `${path}.set`, family ?? (type ? NAMED_FAMILIES[type] : null));
      if (params === null || ports === null || set === null || (isObject(value) && family === null)) return null;
      return { kind: action, type: type as never, family, params, ...(set === undefined ? {} : { set }), ...ports };
    }
    case 'ramp': {
      const body = object(['rise', 'grade']);
      if (!body) return null;
      const rise = check.number(body.rise, `${at}.rise`, 'Ramp rise (mm, negative descends)', -1000, 1000);
      const grade = body.grade === undefined ? DEFAULT_GRADE : check.number(body.grade, `${at}.grade`, 'Grade (%)', 0.5, 5);
      if (rise !== null && Math.abs(rise) < 0.5) return check.fail(`${at}.rise`, 'A ramp must change height by at least 0.5 mm.');
      return rise === null || grade === null ? null : { kind: 'ramp', rise, grade };
    }
    case 'raise': {
      const body = object(['to', 'grade']);
      if (!body) return null;
      const to = check.number(body.to, `${at}.to`, 'Target height (mm above the table)', -400, 2000);
      const grade = body.grade === undefined ? DEFAULT_GRADE : check.number(body.grade, `${at}.grade`, 'Grade (%)', 0.5, 5);
      return to === null || grade === null ? null : { kind: 'raise', to, grade };
    }
    case 'helix': {
      const body = object(['turns', 'radius', 'dir', 'climb', 'rise', 'columns']);
      if (!body) return null;
      const turns = check.number(body.turns, `${at}.turns`, 'Helix turns', 1, 10);
      if (turns !== null && !Number.isInteger(turns * 4)) check.fail(`${at}.turns`, `Helix turns ${turns} is not a whole or quarter turn.`, 'Use 1, 1.25, 1.5, 2…');
      const radius = body.radius === undefined ? 576 : parseRadius(body.radius);
      if (radius === null) check.fail(`${at}.radius`, `Helix radius ${JSON.stringify(body.radius)} is not R<studs> or millimetres.`, 'The helix kit offers R56, R72, R88 and R104.');
      const dir = body.dir === undefined ? 'left' : check.choice(body.dir, `${at}.dir`, 'dir', ['left', 'right'] as const);
      const climb = body.climb === undefined ? 'up' : check.choice(body.climb, `${at}.climb`, 'climb', ['up', 'down'] as const);
      const rise = body.rise === undefined ? null : check.number(body.rise, `${at}.rise`, 'Rise per turn (mm)', 50, 400);
      const columns = body.columns === undefined ? 8 : check.choice(body.columns, `${at}.columns`, 'columns', [0, 4, 8, 16] as never[]) as number | null;
      if (turns === null || !Number.isInteger(turns * 4) || radius === null || dir === null || climb === null || columns === null ||
        (body.rise !== undefined && rise === null)) return null;
      return { kind: 'helix', turns, radius, hand: dir === 'left' ? 1 : -1, direction: climb === 'up' ? 1 : -1, rise, columns };
    }
    case 'piece': {
      const family = check.family(value, at);
      const params = check.params(raw.params, `${path}.params`, family);
      const state = check.state(raw.state, `${path}.state`, family);
      const ports = check.ports(raw, path);
      const legacy = family ? findPieceDefinition(family)?.legacy ?? {} : {};
      const extras: { sweep?: number; rise?: number; bend?: number } = {};
      let ok = true;
      for (const key of ['sweep', 'rise', 'bend'] as const) {
        if (raw[key] === undefined) continue;
        if (family && legacy[key] === undefined) { ok = !!check.fail(`${path}.${key}`, `${family} has no ${key}.`, 'Remove it.'); continue; }
        const number = check.number(raw[key], `${path}.${key}`, key, key === 'rise' ? -1000 : -90, key === 'rise' ? 1000 : 90);
        if (number === null) ok = false;
        else extras[key] = key === 'rise' ? number : number * Math.PI / 180;
      }
      if (family && legacy.sweep !== undefined && extras.sweep === undefined)
        ok = !!check.fail(path, `${family} needs "sweep" (degrees, + turns left).`, 'Or use a "curve" step, which picks the curve family for you.');
      if (!family || params === null || state === null || ports === null || !ok) return null;
      return { kind: 'piece', family, params, ...(state === undefined ? {} : { state }), ...extras, ...ports };
    }
    case 'buffer': {
      if (value === true) return { kind: 'buffer', length: 32 };
      return value === 32 || value === 64 ? { kind: 'buffer', length: value } :
        check.fail(at, `buffer must be true, 32 or 64; got ${JSON.stringify(value)}.`, 'true lays a 32 mm buffer stop.');
    }
    case 'close': {
      const target = typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(value) ? value :
        check.fail(at, `close needs an open end "<label>.<port>"; got ${JSON.stringify(value)}.`, 'For example "main.start" or "A.branch".');
      const minRadius = raw.minRadius === undefined ? null : parseRadius(raw.minRadius);
      if (raw.minRadius !== undefined && (minRadius === null || minRadius < 192))
        return check.fail(`${path}.minRadius`, `minRadius ${JSON.stringify(raw.minRadius)} must be R24 (192 mm) or wider.`);
      return target === null ? null : { kind: 'close', target, minRadius };
    }
  }
}

/**
 * Validate untrusted plan JSON. Structural problems are errors with paths; a step that fails validation becomes null
 * (the builder stops that track there). `plan` is null only when the plan cannot be read at all.
 */
export function parsePlan(raw: unknown): { plan: Plan | null; errors: PlanError[] } {
  const check = new Checker();
  if (!isObject(raw)) {
    check.fail('plan', 'The plan must be a JSON object.', 'Start from {"version": 1, "name": "...", "tracks": [...]}.');
    return { plan: null, errors: check.errors };
  }
  check.keys(raw, 'plan', ['version', 'name', 'description', 'prefer', 'furniture', 'tracks']);
  if (raw.version !== 1) check.fail('version', `version must be 1; got ${JSON.stringify(raw.version)}.`, 'Add "version": 1.');
  const name = raw.name === undefined ? 'Track plan' : typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : check.fail('name', 'name must be a non-empty string.');
  if (raw.description !== undefined && typeof raw.description !== 'string') check.fail('description', 'description must be a string.');
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined;
  const prefer = raw.prefer === undefined ? 'owned' : check.choice(raw.prefer, 'prefer', 'prefer', SOURCES);
  const furniture: PlanKallax[] = [];
  if (raw.furniture !== undefined && !Array.isArray(raw.furniture)) check.fail('furniture', 'furniture must be an array.');
  for (const [index, item] of (Array.isArray(raw.furniture) ? raw.furniture : []).entries()) {
    const path = `furniture[${index}]`;
    if (!isObject(item) || !check.keys(item, path, ['id', 'kallax'])) { if (!isObject(item)) check.fail(path, 'A furniture entry must be an object.'); continue; }
    const id = check.label(item.id, `${path}.id`);
    if (!isObject(item.kallax)) { check.fail(`${path}.kallax`, 'kallax must be {"x": mm, "y": mm, "quarterTurns": 0..3}.', 'x/y are the shelf centre on the floor plan.'); continue; }
    if (!check.keys(item.kallax, `${path}.kallax`, ['x', 'y', 'quarterTurns'])) continue;
    const x = check.number(item.kallax.x, `${path}.kallax.x`, 'x', -100000, 100000), y = check.number(item.kallax.y, `${path}.kallax.y`, 'y', -100000, 100000);
    const turns = item.kallax.quarterTurns === undefined ? 0 : check.choice(item.kallax.quarterTurns, `${path}.kallax.quarterTurns`, 'quarterTurns', [0, 1, 2, 3] as never[]) as 0 | 1 | 2 | 3 | null;
    if (id && furniture.some(other => other.id === id)) check.fail(`${path}.id`, `Furniture id "${id}" is used twice.`, 'Give each shelf its own id.');
    else if (id && x !== null && y !== null && turns !== null) furniture.push({ id, x, y, quarterTurns: turns });
  }
  const tracks: PlanTrack[] = [];
  if (!Array.isArray(raw.tracks) || !raw.tracks.length) check.fail('tracks', 'tracks must be a non-empty array.', 'Add {"id": "main", "start": {...}, "steps": [...]}.');
  for (const [index, item] of (Array.isArray(raw.tracks) ? raw.tracks : []).entries()) {
    const path = `tracks[${index}]`;
    if (!isObject(item)) { check.fail(path, 'A track must be an object.'); continue; }
    check.keys(item, path, ['id', 'start', 'steps']);
    const id = check.label(item.id, `${path}.id`);
    if (id && tracks.some(track => track.id === id)) check.fail(`${path}.id`, `Track id "${id}" is used twice.`, 'Track ids and labels share one namespace; make each unique.');
    if (id && furniture.some(shelf => shelf.id === id)) check.fail(`${path}.id`, `Track id "${id}" is also a furniture id.`, 'Make ids unique.');
    const start = parseStart(check, item.start, `${path}.start`);
    if (!Array.isArray(item.steps)) check.fail(`${path}.steps`, 'steps must be an array (it may be empty).');
    const steps = (Array.isArray(item.steps) ? item.steps : []).map((step, number) => parseStep(check, step, `${path}.steps[${number}]`));
    if (id && start) tracks.push({ id, start, steps });
  }
  // Labels are global: a piece label must not repeat or shadow a track or shelf id.
  const seen = new Map<string, string>(tracks.map((track, index) => [track.id, `tracks[${index}]`]));
  tracks.forEach((track, index) => track.steps.forEach((step, number) => {
    const label = step && 'as' in step ? step.as : undefined;
    if (!label) return;
    const path = `tracks[${index}].steps[${number}].as`;
    if (seen.has(label) || furniture.some(shelf => shelf.id === label)) check.fail(path, `Label "${label}" is already used by ${seen.get(label) ?? 'a furniture id'}.`, 'Labels are global; pick a new name.');
    else seen.set(label, path);
  }));
  if (name === null || prefer === null || !Array.isArray(raw.tracks)) return { plan: null, errors: check.errors };
  return { plan: { version: 1, name, ...(description ? { description } : {}), prefer, furniture, tracks }, errors: check.errors };
}
