import { useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { ELEVATION, RAMP_GRADES, planRamp, type RampPlan } from '../domain/elevation';
import { CLIMB_LEVEL_MAX, CLIMB_RISE, climbLevel, paramValue, pieceDefinition, piecePaths } from '../domain/pieces';
import { ROUTE_BASE_RANGE, routeBase, type Route, type RoutePiece, type WorkshopProject } from '../domain/project';
import { levelLeadAt } from '../fitting/elevation';
import { RISER_MAX } from '../fitting/mounting';
import { climbFit, climbWords, describePlan, flyoverDeck, surfaceAhead, type ClimbFit, type ClimbOptions, type FlyoverOptions, type SurfaceAhead } from './elevation-kits';
import { heightText } from './heights';
import { liftPieceRoute, setPieceParam, setRouteBase } from './operations';

/** Palette key of the flyover kit (not a piece family). */
export const FLYOVER_KEY = 'kit:flyover';
/** 'Go up or down' before the user picks: risers level (64 mm) at 4 %. */
export const CLIMB_INITIAL: ClimbOptions = { target: CLIMB_RISE, grade: 4 };
export const FLYOVER_INITIAL: FlyoverOptions = { clearance: ELEVATION.clearance, grade: 4, decks: 2, under: 0 };

/** What a typed entry sets: the number, or why it was not taken (the field keeps `kept`). */
export function readTyped(text: string, { min, max, unit, kept }: { min: number; max: number; unit: string; kept: number }): { value: number } | { problem: string } {
  const entry = text.trim(), number = Number(entry), signed = (value: number) => value < 0 ? `−${-value}` : `${value}`;
  const range = `${signed(min)} to ${signed(max)}${unit ? ` ${unit}` : ''}`;
  if (!entry || !Number.isFinite(number)) return { problem: `Type a number from ${range}; kept ${signed(kept)}.` };
  if (number < min || number > max) return { problem: `${entry} is outside ${range}; kept ${signed(kept)}.` };
  return { value: number };
}

/**
 * A typed number field's input behaviour: focusing selects the whole entry (so typing replaces it), and Enter, Tab or
 * leaving the field applies it. An entry out of range keeps the old value and says why in `problem`.
 */
export function useTypedNumber({ value, min, max, unit, onSet }: { value: number; min: number; max: number; unit: string; onSet: (value: number) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const enter = () => {
    if (typed === null) return;
    const read = readTyped(typed, { min, max, unit, kept: value });
    setTyped(null);
    if ('problem' in read) { setProblem(read.problem); return; }
    setProblem('');
    if (read.value !== value) onSet(read.value);
  };
  const clickedIn = useRef(false);
  const input: InputHTMLAttributes<HTMLInputElement> = { type: 'number', min, max, value: typed ?? value, 'aria-invalid': problem ? true : undefined,
    onFocus: event => event.currentTarget.select(),
    // The click that focuses the field would drop the selection focusing made; keep it so typing replaces the entry.
    onMouseDown: event => { clickedIn.current = document.activeElement !== event.currentTarget; },
    onMouseUp: event => { if (clickedIn.current) event.preventDefault(); clickedIn.current = false; },
    onChange: event => { setTyped(event.target.value); setProblem(''); }, onBlur: enter,
    onKeyDown: event => { if (event.key === 'Enter') enter(); } };
  return { input, problem };
}

/** A number the user types (see `useTypedNumber`). */
export function NumberField({ id, label, unit, value, min, max, step, onSet }: { id: string; label: string; unit: string; value: number;
  min: number; max: number; step: number; onSet: (value: number) => void }) {
  const { input, problem } = useTypedNumber({ value, min, max, unit, onSet });
  return <label className="builder-param builder-kind-field" htmlFor={id}>{label} ({unit})
    <input id={id} step={step} {...input} aria-describedby={problem ? `${id}-problem` : undefined}/>
    {problem && <small id={`${id}-problem`} className="builder-kind-problem" role="alert">{problem}</small>}</label>;
}
export function Chips({ label, options, value, onPick }: { label: string; options: readonly { value: number; label: string; title?: string; disabled?: boolean }[]; value: number; onPick: (value: number) => void }) {
  return <div className="builder-chips" role="group" aria-label={label}>{options.map(option =>
    <button key={option.label} type="button" title={option.title} disabled={option.disabled} aria-pressed={Math.abs(option.value - value) < 1e-9} onClick={() => onPick(option.value)}>{option.label}</button>)}</div>;
}
const GRADE_CHIPS = RAMP_GRADES.map(grade => ({ value: grade, label: `${grade}%` }));

/** 'Go up or down' summary for its palette tile; laid on an open end it climbs (or drops) from there to the height. */
export function climbSummary(values: ClimbOptions): string {
  const plan = planRamp(values.target, values.grade / 100);
  return `to ${heightText(values.target)} · ≤${values.grade}% · ${plan ? `${(plan.run / 1000).toFixed(2)} m from the table` : 'level'}`;
}

const TARGET_CHIPS = [{ value: 0, label: 'Table = 0', title: 'Back down to the table' }, { value: 64, label: '64 mm', title: 'Risers level: 20 plates' },
  { value: 128, label: '128 mm', title: `Clears a table-level track (${ELEVATION.clearance} mm over its rails)` }];
/**
 * The climb's settings, armed or placed: the height to reach (typed, signed, or Table / 64 / 128), the one surface ahead
 * of it when there is one, the steepest grade, its length and whether it stays in the room.
 */
function ClimbFields({ idPrefix, target, grade, from, plan, fit, ahead, problem, level, onTarget, onGrade }: { idPrefix: string; target: number; grade: number;
  /** Where the climb starts, for its length line ('From this end', 'From the table'). */
  from: string; plan: RampPlan | null; fit: ClimbFit | null; ahead: SurfaceAhead | null; problem: string;
  /** The level track before (and after) the slope: its fields or what the ghost will lay. */
  level?: ReactNode;
  onTarget: (target: number) => void; onGrade: (grade: number) => void }) {
  return <div className="builder-kind-editor">
    <div className="builder-kind-row">
      <Chips label="Height to reach" value={target} options={TARGET_CHIPS} onPick={onTarget}/>
      <NumberField id={`${idPrefix}-target`} label="Height to reach" unit="mm" value={Math.round(target * 100) / 100} min={-400} max={1000} step={ELEVATION.plate} onSet={onTarget}/>
    </div>
    {ahead && <div className="builder-kind-row"><Chips label="Surface ahead" value={target} onPick={onTarget} options={[{ value: ahead.height,
      label: `${ahead.name} ahead · ${heightText(ahead.height)}`, title: `Its entry is ${(ahead.distance / 1000).toFixed(2)} m ahead along the track; the climb ends before it.` }]}/></div>}
    <div className="builder-kind-row"><Chips label="Steepest grade" value={grade} options={GRADE_CHIPS} onPick={onGrade}/></div>
    {level}
    {plan && <small>{from}: {describePlan(plan)}</small>}
    {problem ? <small className="builder-kind-problem" role="status">{problem}</small> :
      fit ? <small className={`builder-climb-fit ${fit.fits ? 'is-fits' : 'is-short'}`} role="status">{climbWords(fit)}</small> :
      <small>Point at an open end to see whether the climb fits the room.</small>}
  </div>;
}

/** What the armed climb's ghost shows: where it starts, its plan, its fit in the room, the surface ahead and its level lead-in (mm). */
export interface ClimbHover { start: { z: number }; plan: RampPlan | null; fit: ClimbFit | null; ahead: SurfaceAhead | null; problem: string; lead: number }
/** 'Go up or down' palette settings; `hover` is the ghost on the table or at the open end under the pointer. */
export function ClimbSettings({ values, hover, onChange }: { values: ClimbOptions; hover: ClimbHover | null; onChange: (values: ClimbOptions) => void }) {
  return <ClimbFields idPrefix="climb" target={values.target} grade={values.grade} ahead={hover?.ahead ?? null} problem={hover?.problem ?? ''}
    from={!hover || Math.abs(hover.start.z) < 0.05 ? 'From the table' : `From this end (${heightText(hover.start.z)})`}
    plan={hover ? hover.plan : planRamp(values.target, values.grade / 100)} fit={hover?.fit ?? null}
    level={hover?.lead ? <small className="builder-climb-lead">Level first: {hover.lead} mm (needed after points)</small> : null}
    onTarget={target => onChange({ ...values, target })} onGrade={grade => onChange({ ...values, grade })}/>;
}

/** A placed climb's settings: changing the height, grade or level track rebuilds it and the track after it follows its new end. */
export function ClimbPieceOptions({ project, piece, onChange }: { project: WorkshopProject; piece: RoutePiece; onChange: (next: WorkshopProject) => void }) {
  const definition = pieceDefinition(piece.family), value = (key: string) => paramValue(definition, piece, key);
  const rise = value('rise'), grade = value('grade'), plan = planRamp(rise, grade / 100, value('ease'));
  const set = (key: string, next: number) => onChange(setPieceParam(project, piece.id, key, next));
  // Points (or a crossing) behind its start within 128 mm of level: the level it needs before the slope.
  const needed = levelLeadAt(project, piece), lead = climbLevel(value('lead'));
  return <ClimbFields idPrefix="climb-piece" target={piece.z + rise} grade={grade} plan={plan} problem={definition.problem?.(piece) ?? ''}
    from={`From its start (${heightText(piece.z)})`} fit={plan ? climbFit(project, piece, [piece], definition.run(piece, project)) : null}
    ahead={surfaceAhead(project, piece, grade, lead)}
    level={<>
      <div className="builder-kind-row">
        <NumberField id="climb-piece-lead" label="Level first" unit="mm" value={value('lead')} min={0} max={CLIMB_LEVEL_MAX} step={8} onSet={next => set('lead', next)}/>
        <NumberField id="climb-piece-trail" label="Level after" unit="mm" value={value('trail')} min={0} max={CLIMB_LEVEL_MAX} step={8} onSet={next => set('trail', next)}/>
      </div>
      {needed ? <small className={lead >= needed ? 'builder-climb-lead' : 'builder-kind-problem'}>
        {lead >= needed ? `Level first: ${lead} mm (needed after points)` : `Points behind it need ${needed} mm of level first.`}</small> : null}
    </>}
    onTarget={target => set('rise', Math.max(-1000, Math.min(1000, Math.round((target - piece.z) * 100) / 100)))} onGrade={next => set('grade', next)}/>;
}

/** Flyover kit summary for its palette tile; the click marks the middle of the decks over the track to cross. */
export function flyoverSummary(values: FlyoverOptions): string {
  const deck = flyoverDeck(values), up = planRamp(deck, values.grade / 100);
  return `${values.clearance} mm clear · deck at ${deck.toFixed(1)} mm${up ? ` · ${(2 * up.run / 1000 + values.decks * 0.16).toFixed(1)} m long` : ''}`;
}

/** Flyover kit settings: clearance, grade and deck count. */
export function FlyoverSettings({ values, onChange }: { values: FlyoverOptions; onChange: (values: FlyoverOptions) => void }) {
  const up = planRamp(flyoverDeck(values), values.grade / 100);
  return <div className="builder-kind-editor">
    <div className="builder-kind-row"><NumberField id="flyover-clearance" label="Clearance over rails" unit="mm" value={values.clearance} min={ELEVATION.clearance} max={400} step={1}
      onSet={clearance => onChange({ ...values, clearance })}/>
      <NumberField id="flyover-under" label="Track below at" unit="mm" value={values.under} min={-400} max={600} step={ELEVATION.plate}
        onSet={under => onChange({ ...values, under })}/></div>
    <div className="builder-kind-row"><Chips label="Flyover grade" value={values.grade} options={GRADE_CHIPS} onPick={grade => onChange({ ...values, grade })}/></div>
    <div className="builder-kind-row"><Chips label="Bridge decks" value={values.decks} onPick={decks => onChange({ ...values, decks })}
      options={[1, 2, 3, 4].map(count => ({ value: count, label: `${count} deck${count === 1 ? '' : 's'}`, title: `${count * 160} mm span` }))}/></div>
    {up && <small>Each side: {describePlan(up)}. Click over the track to cross, or on an open end.</small>}
  </div>;
}

/** Route height in the selected piece's panel: the ground under its route and lifting the whole connected track (risers appear under level track). */
export function RouteGround({ project, piece, route, onChange }: { project: WorkshopProject; piece: RoutePiece; route: Route; onChange: (next: WorkshopProject) => void }) {
  const ground = routeBase(route), height = piece.z - ground;
  const level = piecePaths(piece, project).every(path => path.points.every(point => !point.pitch && Math.abs(point.z - piece.z) < 1e-6));
  const lift = (dz: number) => onChange(liftPieceRoute(project, piece.id, dz));
  return <div className="builder-route-ground">
    <small>{route.name}: track {Math.round(piece.z * 10) / 10} mm, {Math.round(height * 10) / 10} mm above its ground{
      level && height > 0 && height <= RISER_MAX && Math.abs(height / ELEVATION.plate - Math.round(height / ELEVATION.plate)) < 1e-3 ? ' · stands on riser stacks' : ''}</small>
    <div className="builder-chips" role="group" aria-label="Lift the connected track">
      {[[-9.6, '−1 brick'], [-3.2, '−1 plate'], [3.2, '+1 plate'], [9.6, '+1 brick'], [64, '+64 mm risers']].map(([dz, label]) =>
        <button key={label} type="button" onClick={() => lift(dz as number)}>{label}</button>)}
    </div>
    <NumberField id="route-ground" label="Ground under route" unit="mm" value={ground} min={ROUTE_BASE_RANGE[0]} max={ROUTE_BASE_RANGE[1]} step={ELEVATION.plate}
      onSet={base => onChange(setRouteBase(project, route.id, base))}/>
    <small>Table = 0. Below 0 the line dips under the table top (a lowered board); supports stand on this ground.</small>
  </div>;
}
