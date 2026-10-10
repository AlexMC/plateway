import { ELEVATION } from '../domain/elevation';
import { HELIX_COLUMN_OFFSET } from '../domain/pieces/families/helix';
import { Chips, NumberField } from './elevation-ui';
import { HELIX_COLUMNS, HELIX_RADII, HELIX_SECTOR, minimumRise, planHelix, type HelixOptions } from './helix';
import type { WallRunOptions } from './wall-run';

/** Palette keys of the helix and wall/shelf-run kits (not piece families). */
export const HELIX_KEY = 'kit:helix';
export const WALL_RUN_KEY = 'kit:wall-run';
export const HELIX_INITIAL: HelixOptions = { radius: 576, turns: 2, rise: minimumRise(576), hand: 1, direction: 1, columns: 8, side: 1,
  offset: HELIX_COLUMN_OFFSET };
export const WALL_RUN_INITIAL: WallRunOptions = { length: 1024, height: 300, mount: 1, side: 1, reach: 72, spacing: 256, shelf: 16 };

/** Helix kit summary for its palette tile: radius, turns, grade, height and sections. */
export function helixSummary(values: HelixOptions): string {
  const plan = planHelix(values);
  return `R${values.radius / 8} · ${values.turns} turns · ${(plan.grade * 100).toFixed(1)}% · ${plan.height >= 0 ? '+' : ''}${plan.height.toFixed(0)} mm · ${plan.sections.length} sections`;
}

/** Helix kit settings: radius, turns, rise per turn, hand, direction and columns; it shows clearance and problems. */
export function HelixSettings({ values, onChange }: { values: HelixOptions; onChange: (values: HelixOptions) => void }) {
  const plan = planHelix(values);
  const radius = (value: number) => onChange({ ...values, radius: value, rise: Math.max(values.rise, minimumRise(value)) });
  return <div className="builder-kind-editor">
    <div className="builder-kind-row">
      <Chips label="Helix radius" value={values.radius} onPick={radius} options={HELIX_RADII.map(value =>
        ({ value, label: `R${value / 8}`, title: `${value} mm radius · ${(minimumRise(value) / (2 * Math.PI * value) * 100).toFixed(1)}% at the least rise` }))}/>
      <NumberField id="helix-radius" label="Radius" unit="mm" value={values.radius} min={320} max={1472} step={8} onSet={radius}/>
    </div>
    <div className="builder-kind-row">
      <NumberField id="helix-turns" label="Turns" unit="¼ steps" value={values.turns} min={1} max={8} step={0.25} onSet={turns => onChange({ ...values, turns })}/>
      <NumberField id="helix-rise" label="Rise per turn" unit="mm" value={values.rise} min={60} max={300} step={ELEVATION.plate} onSet={rise => onChange({ ...values, rise })}/>
    </div>
    <div className="builder-kind-row">
      <Chips label="Helix hand" value={values.hand} onPick={hand => onChange({ ...values, hand: hand < 0 ? -1 : 1 })}
        options={[{ value: 1, label: 'Turns left' }, { value: -1, label: 'Turns right' }]}/>
      <Chips label="Helix direction" value={values.direction} onPick={direction => onChange({ ...values, direction: direction < 0 ? -1 : 1 })}
        options={[{ value: 1, label: 'Climbs' }, { value: -1, label: 'Descends' }]}/>
    </div>
    <div className="builder-kind-row">
      <Chips label="Columns per turn" value={values.columns} onPick={columns => onChange({ ...values, columns })}
        options={HELIX_COLUMNS.map(count => ({ value: count, label: count ? `${count} columns` : 'No columns',
          title: count ? `A column every ${360 / count}°` : 'Support it yourself' }))}/>
      {values.columns > 0 && <Chips label="Column side" value={values.side} onPick={side => onChange({ ...values, side: side < 0 ? -1 : 1 })}
        options={[{ value: 1, label: 'Inside' }, { value: -1, label: 'Outside', title: 'Check the columns clear the track that enters and leaves' }]}/>}
      {values.columns > 0 && <NumberField id="helix-offset" label="Column from centre" unit="mm" value={values.offset} min={48} max={96} step={1}
        onSet={offset => onChange({ ...values, offset })}/>}
    </div>
    <small>{plan.sections.length} sections of {HELIX_SECTOR}° · eases over {plan.easing} at each end · {plan.clearance === Infinity ? 'one turn or less' :
      `${Math.max(0, plan.clearance).toFixed(0)} mm between turns`}</small>
    {plan.problem ? <small className="builder-kind-problem" role="alert">{plan.problem}</small> :
      plan.caution && <small className="builder-kind-caution" role="status">{plan.caution}</small>}
  </div>;
}

/** Wall/shelf run kit label and summary for its palette tile: a straight run at a height on printed brackets. */
export const wallRunLabel = (values: WallRunOptions) => values.mount === 1 ? 'Wall run' : 'Shelf run';
export function wallRunSummary(values: WallRunOptions): string {
  const brackets = Math.max(1, Math.round(values.length / values.spacing));
  return `${values.length} mm at ${values.height} mm · about ${brackets} ${values.mount === 1 ? 'wall' : 'shelf'} brackets`;
}

/** Wall/shelf run kit settings. */
export function WallRunSettings({ values, onChange }: { values: WallRunOptions; onChange: (values: WallRunOptions) => void }) {
  return <div className="builder-kind-editor">
    <div className="builder-kind-row">
      <Chips label="Bracket type" value={values.mount} onPick={mount => onChange({ ...values, mount: mount === 2 ? 2 : 1 })}
        options={[{ value: 1, label: 'Wall', title: 'Screwed to the wall' }, { value: 2, label: 'Shelf', title: 'Screwed down on a shelf' }]}/>
      <Chips label="Wall side" value={values.side} onPick={side => onChange({ ...values, side: side < 0 ? -1 : 1 })}
        options={[{ value: 1, label: 'Wall on the left' }, { value: -1, label: 'Wall on the right' }]}/>
    </div>
    <div className="builder-kind-row">
      <NumberField id="wall-length" label="Length" unit="mm" value={values.length} min={128} max={8000} step={8} onSet={length => onChange({ ...values, length })}/>
      <NumberField id="wall-height" label="Height" unit="mm" value={values.height} min={0} max={2000} step={ELEVATION.plate} onSet={height => onChange({ ...values, height })}/>
    </div>
    <div className="builder-kind-row">
      <NumberField id="wall-reach" label="Wall to track centre" unit="mm" value={values.reach} min={48} max={150} step={4} onSet={reach => onChange({ ...values, reach })}/>
      <NumberField id="wall-spacing" label="Bracket every" unit="mm" value={values.spacing} min={64} max={512} step={32} onSet={spacing => onChange({ ...values, spacing })}/>
      {values.mount === 2 && <NumberField id="wall-shelf" label="Track above shelf" unit="mm" value={values.shelf} min={10} max={120} step={1} onSet={shelf => onChange({ ...values, shelf })}/>}
    </div>
    <small>Drop on an open end to continue it, or anywhere to start at the height. Brackets go under full sleepers.</small>
  </div>;
}
