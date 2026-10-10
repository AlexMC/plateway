import { SCISSORS_RADII, SCISSORS_SPACINGS } from '../domain/pieces/families/crossover';
import type { TripleOptions } from './triple';

/** Palette key of the triple-crossover kit (not a piece family). */
export const TRIPLE_KEY = 'kit:triple';
export const TRIPLE_INITIAL: TripleOptions = { spacing: 128, radius: 320, hand: 1 };

/** The kit's one-line summary for its palette tile. */
export const tripleSummary = (values: TripleOptions) => `2 scissors in a row · tracks 1–2 then 2–3 · ${values.spacing / 8}-stud spacing`;

/** The kit's spacing, diagonal radius and hand (each change re-arms it). Only the scissors' printable spacing and radius pairs are offered. */
export function TripleSettings({ values, onChange }: { values: TripleOptions; onChange: (values: TripleOptions) => void }) {
  const select = (id: string, label: string, value: number, options: { value: number; label: string }[], set: (value: number) => TripleOptions) =>
    <label className="builder-param" htmlFor={id}>{label}
      <select id={id} value={value} onChange={event => onChange(set(Number(event.target.value)))}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  const radii = SCISSORS_RADII[values.spacing] ?? [];
  return <div className="builder-kind-editor">
    {select('triple-spacing', 'Track spacing', values.spacing, SCISSORS_SPACINGS.map(value => ({ value, label: `${value / 8} studs` })),
      spacing => ({ ...values, spacing, radius: SCISSORS_RADII[spacing].includes(values.radius) ? values.radius : SCISSORS_RADII[spacing][0] }))}
    {select('triple-radius', 'Diagonal radius', values.radius, radii.map(value => ({ value, label: `R${value / 8}` })), radius => ({ ...values, radius }))}
    {select('triple-hand', 'Tracks fan', values.hand, [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }], hand => ({ ...values, hand: hand < 0 ? -1 : 1 }))}
  </div>;
}
