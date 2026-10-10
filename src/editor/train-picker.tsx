import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { libraryVersion, onLibraryChange } from '../domain/library';
import type { Car } from '../domain/project';
import { POWER_NOTES, catalogueCar, loadTrainCatalogue, searchTrainSets, type TrainCatalogue, type TrainSet } from '../domain/trains';
import { CommunityMark } from './community-mark';

const SHOWN = 40;

/** The bundled train catalogue and the community trains, or why it isn't available; it grows as late library trains register. */
export function useTrainCatalogue(): { catalogue: TrainCatalogue | null; error: string } {
  const [catalogue, setCatalogue] = useState<TrainCatalogue | null>(null);
  const [error, setError] = useState('');
  const library = useSyncExternalStore(onLibraryChange, libraryVersion);
  useEffect(() => {
    let live = true;
    loadTrainCatalogue().then(result => { if (live) setCatalogue(result); },
      reason => { if (live) setError(reason instanceof Error ? reason.message : 'Train catalogue unavailable'); });
    return () => { live = false; };
  }, [library]);
  return { catalogue, error };
}

/** A catalogue set's number; a community train has none. */
const setNumber = (set: TrainSet) => set.community ? '' : set.id.replace(/-1$/, '');
const mm = (value: number) => Math.round(value);

/** Search the train catalogue and add a whole set or single cars, with sizes measured from the set's model. */
export function TrainPicker({ catalogue, error, onAdd, onClose }: {
  catalogue: TrainCatalogue | null; error: string; onAdd: (cars: Car[]) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const matches = useMemo(() => catalogue ? searchTrainSets(catalogue, query) : [], [catalogue, query]);
  return <div className="setup-train-picker" role="region" aria-label="Add a train">
    <div className="setup-train-search">
      <input id="setup-train-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
        placeholder="Set number, name or power" aria-label="Search trains" />
      <button type="button" onClick={onClose}>Done</button>
    </div>
    {error ? <p role="alert">{error}</p> : !catalogue ? <p className="setup-note">Loading trains…</p> : <>
      <p className="setup-note">{matches.length} of {catalogue.sets.length} sets for standard brick track and monorail. No catalogue
        trains run on narrow gauge or rack track.</p>
      <ul className="setup-train-sets">{matches.slice(0, SHOWN).map(set => {
        const open = openId === set.id, power = POWER_NOTES[set.power];
        return <li key={set.id}>
          <button type="button" className="setup-train-set" aria-expanded={open} onClick={() => setOpenId(open ? null : set.id)}>
            <strong>{`${setNumber(set)} ${set.name}`.trim()}</strong>
            <small>{set.year} · {power.label}{set.gauge === 'monorail' ? ' · monorail' : ''} · {set.cars.length} {set.cars.length === 1 ? 'car' : 'cars'}
              {set.source.kind === 'procedural' ? ' · estimated shape' : ''}</small>
            {set.community && <CommunityMark community={set.community}/>}
          </button>
          {open && <div className="setup-train-detail">
            {set.community && <CommunityMark community={set.community} details/>}
            {power.note && <p className="setup-power-note" role="note">{power.note}</p>}
            {set.source.kind === 'procedural' && <details className="setup-about">
              <summary>No LDraw model of this set exists: its shape and sizes are estimated, not measured.</summary>
              {set.source.evidence && <p className="setup-note">{set.source.evidence}</p>}</details>}
            <ol className="setup-cars">{set.cars.map(car => <li key={car.id}>
              <div><strong>{car.name}{car.motorised ? ' · motor' : ''}</strong>
                <small>{mm(car.length)} × {mm(car.width)} × {mm(car.height)} mm · wheelbase {mm(car.wheelbase)} mm</small></div>
              <div className="setup-car-actions"><button type="button" aria-label={`Add ${car.name} from ${setNumber(set) || set.name}`}
                onClick={() => onAdd([catalogueCar(set, car)])}>Add</button></div>
            </li>)}</ol>
            <button type="button" className="setup-primary" onClick={() => onAdd(set.cars.map(car => catalogueCar(set, car)))}>
              Add whole set · {set.cars.length} {set.cars.length === 1 ? 'car' : 'cars'}</button>
          </div>}
        </li>;
      })}</ul>
      {matches.length > SHOWN && <p className="setup-note">Showing {SHOWN} of {matches.length}; search to narrow the list.</p>}
    </>}
  </div>;
}

/** Where each model comes from and under what licence. */
export function TrainAttribution({ catalogue }: { catalogue: TrainCatalogue }) {
  return <details className="setup-about">
    <summary>About these models</summary>
    <p className="setup-note">Train models come from the LDraw Official Model Repository and the LDraw parts library, measured
      from their geometry (1 LDU = 0.4 mm).
      {' '}<a href={`${import.meta.env.BASE_URL}trains/ATTRIBUTION.md`} target="_blank" rel="noreferrer">Full attribution</a></p>
    <ul>{catalogue.sets.map(set => <li key={set.id}>
      <strong>{`${setNumber(set)} ${set.name}`.trim()}</strong>{' '}
      {set.source.kind === 'procedural' ? <>estimated, not measured: no LDraw model exists{set.source.url && <> · <a href={set.source.url} target="_blank" rel="noreferrer">instructions</a></>}</> :
        <>{set.source.authors?.length ? `by ${set.source.authors.join(', ')}` : 'LDraw model'}{set.source.license ? ` · ${set.source.license}` : ''}
          {set.source.url && <> · <a href={set.source.url} target="_blank" rel="noreferrer">source</a></>}</>}
    </li>)}</ul>
  </details>;
}
