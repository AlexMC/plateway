import { useState, type ReactNode, type RefObject } from 'react';
import { furnitureType } from '../domain/furniture';
import { applyChoice, choiceChosen, kindOfFamily, paramValue, pieceDefinition, pieceState, pieceStates, type KindField, type ParamSpec, type PieceDefinition, type TrackKind } from '../domain/pieces';
import { trackOptions } from '../domain/pieces/families/track-options';
import { pieceIsFast } from '../domain/printer';
import type { Account } from '../account/account';
import type { Community, Furniture, RoutePiece, WorkshopProject } from '../domain/project';
import { hardwareRequest } from '../export/hardware';
import { AlsoNeeds } from '../export/shopping-list';
import type { FitResult } from '../fitting/fit';
import { ClimbPieceOptions, RouteGround, useTypedNumber } from './elevation-ui';
import { setFlexBend, setPieceParam, setPieceShape, setPieceSource, setPieceState, setRampRise, type PieceSource } from './operations';
import { CommunityMark } from './community-mark';
import { choiceStock, ownedMark, type OwnedStock, type PaletteEntry } from './palette';
import { BarButton, type BarAction } from './placement-bar';
import { shortcutFor } from './shortcuts';

/** The settings that say how a mechanism or point is worked (by hand, a motor, a servo, a lead screw): they get their own Drive section. */
const DRIVE_KEYS = ['drive', 'servo', 'motor'];
/** A piece's drive setting, if it has one. */
export function driveSpec(definition: Pick<PieceDefinition, 'params'>): ParamSpec | undefined {
  return definition.params.find(spec => DRIVE_KEYS.includes(spec.key) && spec.options);
}
/** The project's train includes a 60052 (infrared: its remote and receiver can't run Bluetooth motors). */
const has60052 = (project: WorkshopProject) => project.cars.some(car => car.model?.set.startsWith('60052'));
/** One line on what a drive option takes to build and run. */
export function driveNote(label: string, project: WorkshopProject): string {
  const pf = has60052(project), word = label.toLowerCase();
  if (word.startsWith('bluetooth')) return `Needs a Bluetooth hub (88012 or 88009) — ${pf ? 'your 60052 can’t drive it: its infrared remote doesn’t talk to a Bluetooth hub' : 'an infrared remote can’t drive it'}.`;
  if (word.startsWith('infrared')) return `Infrared: IR receiver 8884 + battery box 88000 for the motor${pf ? ' — your 60052’s 8879 remote can drive it on a free channel' : ''}.`;
  if (word.includes('servo')) return 'An SG90 servo beside the track, wired to a servo driver board (see Also needs).';
  if (word.includes('screw')) return 'An M8 lead screw turned by a printed crank: still by hand, but smooth and it holds any height.';
  if (word.includes('magnet')) return 'Flipped by hand; magnets hold it up or down. Nothing to wire.';
  if (word.includes('crank')) return 'Turned by its printed crank. Nothing to wire.';
  return 'Worked by hand. Nothing to wire.';
}
/** The palette tile's word on its drive: the choices while it is as it comes ('by hand or motor'), else the one picked; '' for a
 * piece that is always motorised (a funicular's description names its motor). */
export function driveSummary(spec: ParamSpec, value: number): string {
  const chosen = spec.options!.find(option => option.value === value);
  if (value !== spec.default && chosen) return chosen.label;
  const kinds = [...new Set(spec.options!.map(option => {
    const word = option.label.toLowerCase();
    return word.includes('servo') ? 'servo' : word.includes('screw') ? 'lead screw' : /motor|bluetooth|infrared/.test(word) ? 'motor' : 'by hand';
  }))];
  return kinds.includes('by hand') ? kinds.join(' or ') : '';
}
/** How the piece is worked: one button per drive option, and what the picked one takes. */
export function DriveChoice({ spec, value, project, onSet }: { spec: ParamSpec; value: number; project: WorkshopProject; onSet: (value: number) => void }) {
  const chosen = spec.options!.find(option => option.value === value) ?? spec.options![0];
  return <div className="builder-drive">
    <div className="builder-source" role="group" aria-label={spec.label}>
      {spec.options!.map(option => <button key={option.value} type="button" aria-pressed={option.value === chosen.value}
        title={driveNote(option.label, project)} onClick={() => { if (option.value !== chosen.value) onSet(option.value); }}>{option.label}</button>)}
    </div>
    <small className="builder-drive-note">{driveNote(chosen.label, project)}</small>
  </div>;
}

/** What the Route height section is, in one sentence. */
const ROUTE_HEIGHT_WORDS = 'The floor this whole route sits on. Raise it to run track on a box or shelf; lower it below 0 for a sunken board.';

/**
 * The piece you are working with, beside the Pieces sidebar (a bottom sheet on narrow screens): the armed tile ('Placing: …')
 * or the selected piece or shelf ('Selected: …'), always in the same place with the same sections in the same order — Shape,
 * Drive, Print, Also needs, Settings, Info, then (selected only) a folded Route height and the piece's actions. A section without
 * content is left out. A community item's mark, with its licence and library folder, sits under its name. It never takes focus
 * on its own; Esc inside it or × closes it.
 */
export function PiecePanel({ mode, name, meta, owned, community, shape, drive, print, alsoNeeds, settings, info, routeHeight, actions, hint, onClose, panelRef }: {
  mode: 'placing' | 'selected'; name: string; meta?: string; owned?: OwnedStock; community?: Community;
  shape?: ReactNode;
  /** How a mechanism or point is worked (by hand, motor, servo): its own section, right after Shape. */
  drive?: ReactNode;
  print?: ReactNode; alsoNeeds?: ReactNode; settings?: ReactNode; info?: ReactNode;
  /** Selected track only: the route's ground and lifting its connected track. */
  routeHeight?: ReactNode;
  actions?: readonly BarAction[];
  hint?: string;
  onClose: () => void;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const word = mode === 'placing' ? 'Placing' : 'Selected';
  const section = (label: string, body: ReactNode) => body ? <section className="builder-panel-section" aria-label={label}>
    <span className="builder-panel-label">{label}</span>{body}</section> : null;
  return <section ref={panelRef} tabIndex={-1} className={`builder-flyout builder-piece-panel is-${mode}`} aria-label={`${word}: ${name}${meta ? ` · ${meta}` : ''}`}
    onKeyDown={event => { if (shortcutFor(event, 'palette-options') === 'options-close') { event.stopPropagation(); onClose(); } }}>
    <header className="builder-flyout-head"><div><strong><span className="builder-panel-mode">{word}:</span> {name}</strong>
      {(meta || owned && owned.total > 0) && <small>{meta}{owned && owned.total > 0 &&
        <span className={`builder-owned-mark ${owned.left ? '' : 'is-empty'}`}>{meta ? ' — ' : ''}{ownedMark(owned)}</span>}</small>}
      {community && <CommunityMark community={community} details/>}</div>
      <button type="button" className="builder-flyout-close" aria-label={mode === 'placing' ? 'Stop placing' : 'Deselect'} title="Close (Esc)" onClick={onClose}>×</button></header>
    {section('Shape', shape)}
    {section('Drive', drive)}
    {section('Print', print)}
    {alsoNeeds}
    {section('Settings', settings)}
    {section('Info', info)}
    {routeHeight && <details className="builder-panel-fold">
      <summary>Route height</summary>
      <p>{ROUTE_HEIGHT_WORDS}</p>
      {routeHeight}
    </details>}
    {actions && actions.length > 0 && <div className="builder-panel-actions placement-bar-actions" role="group" aria-label={`${name} actions`}>
      {actions.map(action => <BarButton key={action.id} action={action}/>)}</div>}
    {hint && <small className="builder-flyout-hint">{hint}</small>}
  </section>;
}

const SOURCE_WORDS: Record<PieceSource, string> = { owned: 'owned', printed: 'printed', fast: 'fast print' };
const SOURCE_TITLES: Record<PieceSource, string> = { owned: 'Use a piece you own', printed: 'Printed in full detail', fast: 'Fast print: rails and connectors only' };

/** The armed tile in the piece panel: its options, Own / Print / Fast with the owned count, what it also needs and its notes. */
export function PlacingPanel({ entry, onSource, onClose, panelRef }: { entry: PaletteEntry; onSource: (key: string, source: PieceSource) => void; onClose: () => void;
  panelRef?: RefObject<HTMLElement | null> }) {
  const words = entry.sources.map(source => SOURCE_WORDS[source]);
  const sources = entry.sources.length > 1 && <div className="builder-source" role="group" aria-label={`${entry.label}: ${words.slice(0, -1).join(', ')} or ${words.at(-1)}`}>
    {entry.sources.map(source => <button key={source} type="button" data-source={source} aria-pressed={entry.source === source}
      title={source === 'owned' && entry.owned ? `${SOURCE_TITLES.owned} (${entry.owned.left} of ${entry.owned.total} left)` : SOURCE_TITLES[source]} onClick={() => onSource(entry.key, source)}>{source === 'owned' ? 'Own' : source === 'printed' ? 'Print' : 'Fast'}</button>)}
  </div>;
  const count = entry.owned && entry.owned.total > 0 && <small>{entry.owned.left} of {entry.owned.total} owned left</small>;
  const info = (entry.notes?.length || entry.caution) && <>
    {entry.notes?.map(note => <p key={note}>{note}</p>)}
    {entry.caution && <p className="builder-caution" role="note"><strong>Experimental.</strong> {entry.caution}</p>}</>;
  return <PiecePanel mode="placing" name={entry.label} meta={entry.meta} owned={entry.owned} community={entry.community} panelRef={panelRef} onClose={onClose}
    shape={entry.options} drive={entry.drive} print={(sources || count) && <>{sources}{count}</>} alsoNeeds={entry.alsoNeeds} info={info}
    hint="Click the table to place · drag the tile to place once · R rotates · Esc to stop"/>;
}

/** A selected piece of furniture: where it stands, a community preset's mark, and its actions. */
export function FurniturePanel({ name, item, actions, onClose, panelRef }: { name: string; item: Furniture; actions: readonly BarAction[]; onClose: () => void;
  panelRef?: RefObject<HTMLElement | null> }) {
  return <PiecePanel mode="selected" name={name} community={furnitureType(item.family).community} panelRef={panelRef} onClose={onClose} actions={actions}
    info={<small>Centre {Math.round(item.x)} × {Math.round(item.y)} mm · {item.quarterTurns * 90}°</small>}/>;
}

/** One kind edit on the selected piece (a size chip or typed value): it takes that shape — owned where the piece is owned and an official piece has the shape, else printed — or stays as it is when none fits. */
export function setPieceKindValues(project: WorkshopProject, id: string, values: Record<string, number>): WorkshopProject {
  const piece = project.routes.flatMap(route => route.pieces).find(item => item.id === id)!;
  const kind = kindOfFamily(piece.family)!, owned = pieceDefinition(piece.family).source === 'owned';
  const shape = (owned ? kind.shape(values, 'owned') : null) ??
    kind.shape(values, 'printed', project.trackSystem !== 'brick-v1', Object.keys(trackOptions(piece)).length > 0);
  return shape ? setPieceShape(project, id, shape) : project;
}

/**
 * The selected piece in the piece panel: its shape (kind chips, parameters, bend, ramp rise), print source, what it also
 * needs, its settings (switch states), notes and the folded Route height. `piece` shows a slider drag in progress (`draft`);
 * every edit applies to the committed project.
 */
export function SelectedPiecePanel({ project, piece, committed, fit, account, fastAvailable, stock, actions, onChange, onDraft, onCommitDraft, onClose, panelRef }: {
  project: WorkshopProject; piece: RoutePiece; committed: RoutePiece | undefined; fit: FitResult; account: Account; fastAvailable: boolean;
  stock: (family: string) => OwnedStock | undefined; actions: readonly BarAction[];
  onChange: (next: WorkshopProject) => void; onDraft: (next: WorkshopProject) => void; onCommitDraft: () => void; onClose: () => void;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const definition = pieceDefinition(piece.family), kind = kindOfFamily(piece.family), states = pieceStates(piece);
  const values = kind?.values(committed ?? piece);
  /** Track options only print on a kind's composite family; setting one on a legacy piece (128 mm straight, R40/R56) converts it. */
  const optionShape = kind && definition.source === 'printed' && project.trackSystem === 'brick-v1' ? kind.shape(kind.values(piece), 'printed', false, true) : null;
  const optionDefinition = optionShape && optionShape.family !== piece.family ? pieceDefinition(optionShape.family) : definition;
  const setOption = (key: string, value: number) => optionDefinition === definition ? setPieceParam(project, piece.id, key, value) :
    value === optionDefinition.params.find(spec => spec.key === key)!.default ? project :
      setPieceShape(project, piece.id, { ...optionShape!, params: { ...optionShape!.params, [key]: value } });
  const rise = committed?.rise ?? 0;
  const route = project.routes.find(item => item.pieces.some(part => part.id === piece.id))!;
  const owned = definition.source === 'owned' ? stock(piece.family) : undefined;
  const problem = definition.problem?.(piece);
  // The drive has its own section; like any setting it shows only while it applies (a servo only on manual points).
  const drive = driveSpec(optionDefinition);
  const driveShown = drive && (!drive.when || drive.when.values.includes(paramValue(optionDefinition, piece, drive.when.key)));
  const shape = <>
    {piece.family === 'track_climb' && <ClimbPieceOptions project={project} piece={committed ?? piece} onChange={onChange}/>}
    {kind && <KindEditor key={piece.id} kind={kind} values={values!} idPrefix="selected-kind" stock={stock}
      fits={next => Boolean(kind.shape(next, 'printed', !fastAvailable) ?? (definition.source === 'owned' ? kind.shape(next, 'owned') : null))}
      onChange={next => onChange(setPieceKindValues(project, piece.id, next))}/>}
    {definition.legacy?.bend !== undefined && <label className="builder-param" htmlFor="selected-flex-bend">Bend <strong>{((piece.bend ?? 0) * 180 / Math.PI).toFixed(3)}°</strong>
      <input id="selected-flex-bend" type="range" min="-5.625" max="5.625" step="0.125" value={(piece.bend ?? 0) * 180 / Math.PI}
        onChange={event => onDraft(setFlexBend(project, piece.id, Number(event.target.value) * Math.PI / 180))}
        onPointerUp={onCommitDraft} onKeyUp={onCommitDraft} onBlur={onCommitDraft}/>
      <small>Right · straight · left</small>
      <button type="button" onClick={() => onChange(setFlexBend(project, piece.id, 0))}>Straighten</button>
    </label>}
    {optionDefinition.params.filter(spec => !spec.hidden && spec !== drive && !(kind && spec.key in kind.values(piece)) &&
      (!spec.when || spec.when.values.includes(paramValue(optionDefinition, piece, spec.when.key)))).map(spec => <ParamControl key={`${piece.id}:${spec.key}`} spec={spec}
      value={paramValue(optionDefinition, piece, spec.key)} committed={paramValue(optionDefinition, committed ?? piece, spec.key)}
      onDraft={value => onDraft(setOption(spec.key, value))} onCommit={onCommitDraft}
      onSet={value => onChange(setOption(spec.key, value))}/>)}
    {definition.legacy?.rise !== undefined && <div className="builder-ramp">
      <label htmlFor="selected-ramp-rise">Height change <strong>{Math.abs(piece.rise ?? 0)} mm</strong></label>
      <div className="builder-ramp-direction" role="group" aria-label="Ramp direction">
        <button type="button" aria-pressed={rise >= 0} onClick={() => onChange(setRampRise(project, piece.id, Math.abs(rise) || 8))}>Up</button>
        <button type="button" aria-pressed={rise < 0} onClick={() => onChange(setRampRise(project, piece.id, -(Math.abs(rise) || 8)))}>Down</button>
      </div>
      <input id="selected-ramp-rise" type="range" min="1" max="90" step="1" value={Math.max(1, Math.abs(piece.rise ?? 0))}
        onChange={event => onDraft(setRampRise(project, piece.id, (rise < 0 ? -1 : 1) * Number(event.target.value)))}
        onPointerUp={onCommitDraft} onKeyUp={onCommitDraft} onBlur={onCommitDraft}/>
    </div>}
    {problem && <small className="builder-kind-problem" role="alert">{problem}</small>}
  </>;
  const settings = states && <>
    {states.length <= 2 && <div className="builder-switch-state" role="group" aria-label="Selected switch routing">
      {states.map(state => <button key={state.id} type="button" aria-pressed={pieceState(piece) === state.id}
        onClick={() => onChange(setPieceState(project, piece.id, state.id))}>{state.label}</button>)}
    </div>}
    {states.length > 2 && <label className="builder-param" htmlFor="selected-piece-state">Setting
      <select id="selected-piece-state" value={pieceState(piece)} onChange={event => onChange(setPieceState(project, piece.id, event.target.value))}>
        {states.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}
      </select></label>}
  </>;
  const info = (definition.caution || definition.notes?.length || definition.body === 'assembly') && <>
    {definition.caution && <p className="builder-caution" role="note"><strong>Experimental.</strong> {definition.caution}</p>}
    {definition.notes?.map(note => <p key={note}>{note}</p>)}
    {definition.body === 'assembly' && <p>{definition.halt ? 'Solid cyan: lined-up position · dashed amber: positions it can move to.' : 'Solid cyan: active path · dashed amber: inactive path.'}</p>}
  </>;
  return <PiecePanel mode="selected" name={kind ? kind.label : definition.label} meta={kind ? kind.describe(values!) : definition.description(committed ?? piece)}
    community={definition.community} panelRef={panelRef} onClose={onClose} actions={actions} shape={shape}
    drive={driveShown && <DriveChoice spec={drive} value={paramValue(optionDefinition, committed ?? piece, drive.key)} project={project}
      onSet={value => onChange(setOption(drive.key, value))}/>}
    print={<>
      {fastAvailable && <PieceSourceControl project={project} piece={piece} onChange={onChange}/>}
      <small>{definition.source === 'owned' ? 'Owned' : pieceIsFast(project, piece) ? 'Printed · fast print' : 'Printed · full detail'}</small>
      {owned && owned.total > 0 && <small>{owned.left} of {owned.total} owned left</small>}
    </>}
    alsoNeeds={committed && <AlsoNeeds body={hardwareRequest(fit.partInstances.filter(part => part.id === committed.id || part.sectionId === committed.id ||
      part.sectionId.startsWith(`${committed.id}:`)), [committed])} account={account}/>}
    settings={settings} info={info}
    routeHeight={<RouteGround project={project} piece={committed ?? piece} route={route} onChange={onChange}/>}/>;
}

/** A `ParamSpec` of the selected piece: a choice, or a slider plus a typed value; each release or entry is one undoable edit. */
function ParamControl({ spec, value, committed, onDraft, onCommit, onSet }: { spec: ParamSpec; value: number; committed: number;
  onDraft: (value: number) => void; onCommit: () => void; onSet: (value: number) => void }) {
  const id = `selected-param-${spec.key}`, unit = spec.unit ? ` ${spec.unit === 'deg' ? '°' : spec.unit}` : '';
  const typed = useTypedNumber({ value: committed, min: spec.min, max: spec.max, unit: spec.unit === 'deg' ? '°' : spec.unit, onSet });
  if (spec.options) return <label className="builder-param" htmlFor={id}>{spec.label}
    <select id={id} value={value} onChange={event => onSet(Number(event.target.value))}>
      {spec.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  return <div className="builder-ramp builder-param">
    <label htmlFor={id}>{spec.label} <strong>{value}{unit}</strong></label>
    <input id={id} type="range" min={spec.min} max={spec.max} step={spec.step} value={value}
      onChange={event => onDraft(Number(event.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/>
    <input aria-label={`${spec.label}${unit}`} step={spec.step} {...typed.input}/>
    {typed.problem && <small className="builder-kind-problem" role="alert">{typed.problem}</small>}
  </div>;
}

/** A typed kind value; `signed` fields show the size and keep the piece's hand. Out-of-range entries are kept out, saying why. */
function KindNumber({ field, value, id, onSet }: { field: KindField; value: number; id: string; onSet: (value: number) => void }) {
  const unit = field.unit === 'deg' ? '°' : field.unit;
  const typed = useTypedNumber({ value: field.signed ? Math.abs(value) : value, min: field.min, max: field.max, unit,
    onSet: number => onSet(field.signed ? Math.sign(value || 1) * number : number) });
  return <label className="builder-param builder-kind-field" htmlFor={id}>{field.label} ({unit})
    <input id={id} step={field.step} {...typed.input}/>
    {typed.problem && <small className="builder-kind-problem" role="alert">{typed.problem}</small>}</label>;
}

/**
 * A track kind's preset chips and custom values (armed tile and selected piece); each chip or entry is one change.
 * `stock`: owned track by family; a chip that builds an owned shape says how many are left.
 */
export function KindEditor({ kind, values, idPrefix, onChange, fits, stock }: { kind: TrackKind; values: Record<string, number>; idPrefix: string;
  onChange: (values: Record<string, number>) => void; fits?: (values: Record<string, number>) => boolean; stock?: (family: string) => OwnedStock | undefined }) {
  const [customRows, setCustomRows] = useState<Record<number, boolean>>({});
  const [problem, setProblem] = useState('');
  const apply = (next: Record<string, number>) => { const issue = kind.problem(next); setProblem(issue ?? ''); if (!issue) onChange(next); };
  const field = (item: KindField) => <KindNumber key={item.key} field={item} value={values[item.key]} id={`${idPrefix}-${item.key}`}
    onSet={value => apply({ ...values, [item.key]: value })}/>;
  return <div className="builder-kind-editor">
    {kind.rows.map((row, index) => {
      const chosen = row.choices.find(choice => choiceChosen(kind, row, choice, values));
      const custom = row.custom !== undefined && (customRows[index] || !chosen);
      return <div key={row.label} className="builder-kind-row">
        <div className="builder-chips" role="group" aria-label={`${kind.label} ${row.label.toLowerCase()}`}>
          {row.choices.map(choice => {
            const next = applyChoice(kind, values, choice.values), owned = stock && choiceStock(kind, values, choice, stock);
            return <button key={choice.label} type="button" title={owned ? `${choice.title ?? choice.label} · you own ${owned.total}, ${owned.left} left` : choice.title} aria-pressed={!custom && choice === chosen} disabled={fits && !fits(next)}
              onClick={() => { setCustomRows(prior => ({ ...prior, [index]: false })); apply(next); }}>{choice.label}{owned && <span className={`builder-chip-owned ${owned.left ? '' : 'is-empty'}`}>{ownedMark(owned)}</span>}</button>;
          })}
          {row.custom && <button type="button" aria-pressed={custom} onClick={() => {
            setCustomRows(prior => ({ ...prior, [index]: true })); if (row.customValues) apply(applyChoice(kind, values, row.customValues)); }}>Custom</button>}
        </div>
        {custom && row.custom!.map(field)}
      </div>;
    })}
    {kind.extra?.(values).map(field)}
    {problem && <small className="builder-kind-problem" role="alert">{problem}</small>}
    {!problem && kind.caution?.(values) && <small className="builder-kind-problem" role="note">{kind.caution(values)}</small>}
  </div>;
}

/** Owned / Print / Fast for the selected piece, plus one click to give its whole route the same print style. */
function PieceSourceControl({ project, piece, onChange }: { project: WorkshopProject; piece: RoutePiece; onChange: (next: WorkshopProject) => void }) {
  const definition = pieceDefinition(piece.family), official = definition.owned !== undefined;
  const source: PieceSource = definition.source === 'owned' ? 'owned' : pieceIsFast(project, piece) ? 'fast' : 'printed';
  const route = project.routes.find(item => item.pieces.some(part => part.id === piece.id))!;
  const printed = route.pieces.filter(part => { const kind = pieceDefinition(part.family); return kind.source === 'printed' && (source !== 'fast' || kind.styles.includes('fast')); });
  const routeMatches = printed.every(part => pieceIsFast(project, part) === (source === 'fast'));
  const options: [PieceSource, string][] = [...(official ? [['owned', 'Owned'] as [PieceSource, string]] : []), ['printed', 'Print'],
    ...(definition.source === 'owned' || definition.styles.includes('fast') ? [['fast', 'Fast'] as [PieceSource, string]] : [])];
  return <div className="builder-piece-source">
    <div className="builder-source" role="group" aria-label="Selected piece: owned, printed or fast print">{options.map(([option, label]) =>
      <button key={option} type="button" data-source={option} aria-pressed={source === option}
        onClick={() => onChange(setPieceSource(project, [piece.id], option))}>{label}</button>)}</div>
    {source !== 'owned' && printed.length > 1 && !routeMatches && <button type="button" className="builder-route-apply"
      onClick={() => onChange(setPieceSource(project, printed.map(part => part.id), source))}>
      Make every printed piece in {route.name} {source === 'fast' ? 'fast print' : 'full detail'}</button>}
  </div>;
}
