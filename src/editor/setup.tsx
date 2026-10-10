import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { changeProject, missingPrintMeasurements, type Car, type MeasurementKey, type WorkshopProject } from '../domain/project';
import { CAR_GAUGES, type CarGauge } from '../domain/gauges';
import { OWNED_DEFINITIONS } from '../domain/pieces';
import { MEASUREMENT_LABELS, TYPICAL_COUPLER_GAP, inventoryMatches, setSetupCars, setSetupInventory, setSetupInventoryPreset, setSetupPrinter, type InventoryPreset } from './setup-defaults';
import { POWER_NOTES } from '../domain/trains';
import { TrainAttribution, TrainPicker, useTrainCatalogue } from './train-picker';
import './setup.css';

export { createStandardProject } from './setup-defaults';

/** Where an opener lands: the track counts, the new-car form, or one measurement field. */
export type SetupTarget = 'track' | 'car' | MeasurementKey;

const CAR_NAME = 'setup-car-name';
const ADD_CAR = 'setup-add-car';
const ADD_TRAIN = 'setup-add-train';
const TRAIN_SEARCH = 'setup-train-search';
const countId = (family: string) => `setup-count-${family}`;
const measurementId = (field: MeasurementKey) => `setup-measurement-${field}`;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]';

const CUSTOM_RAIL = ['railGauge', 'railInterfaceWidth', 'railBodyWidth', 'railBaseThickness', 'railHeight'] as const;
const CAR_FIELDS = [['length', 'Length'], ['width', 'Width'], ['height', 'Height'], ['wheelbase', 'Wheelbase'], ['couplerGap', 'Coupler gap']] as const;
const EMPTY_CAR = { name: '', length: '', width: '', height: '', wheelbase: '', couplerGap: String(TYPICAL_COUPLER_GAP), loadDescription: '',
  gauge: 'standard' as CarGauge, cog: false };
const PRESETS: [InventoryPreset, string][] = [['city', 'Typical starter set · 8 straights, 16 curves'], ['none', 'None']];
type CarForm = typeof EMPTY_CAR;
type OnMeasure = (key: MeasurementKey, value: number | null) => void;

/** Text the user is typing; follows the project value whenever the field isn't focused. */
function useDraft(shown: string) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(shown);
  useEffect(() => { if (document.activeElement !== input.current) setDraft(shown); }, [shown]);
  return { input, draft, setDraft };
}

/** A typed value is the user's own; clearing it restores the default, which shows muted. */
function MeasureInput({ project, field, onMeasure }: { project: WorkshopProject; field: MeasurementKey; onMeasure: OnMeasure }) {
  const item = project.measurements[field];
  const shown = item.value === null ? '' : String(item.value);
  const { input, draft, setDraft } = useDraft(shown);
  return <span className={`setup-unit${item.status === 'estimate' ? ' is-default' : ''}`}>
    <input ref={input} id={measurementId(field)} aria-label={`${MEASUREMENT_LABELS[field]} in millimetres`} type="number" min="0.01" step="any" inputMode="decimal"
      value={draft} placeholder={missingPrintMeasurements(project).includes(field) ? 'Needed' : 'Any'}
      onChange={event => {
        const text = event.target.value;
        setDraft(text);
        if (text === '') onMeasure(field, null);
        else if (Number.isFinite(Number(text)) && Number(text) > 0) onMeasure(field, Number(text));
      }} onBlur={() => setDraft(shown)} />
    <i>mm</i>
  </span>;
}

function CountStepper({ family, label, count, onCount }: { family: string; label: string; count: number; onCount: (count: number) => void }) {
  const { input, draft, setDraft } = useDraft(String(count));
  return <span className="setup-stepper">
    <button type="button" aria-label={`One fewer ${label}`} aria-disabled={count === 0} onClick={() => { if (count > 0) onCount(count - 1); }}>−</button>
    <input ref={input} id={countId(family)} aria-label={`Owned ${label}`} type="number" min="0" step="1" inputMode="numeric" value={draft}
      onChange={event => {
        const text = event.target.value, next = Number(text);
        setDraft(text);
        if (text !== '' && Number.isSafeInteger(next) && next >= 0) onCount(next);
      }} onBlur={() => setDraft(String(count))} />
    <button type="button" aria-label={`One more ${label}`} onClick={() => onCount(count + 1)}>+</button>
  </span>;
}

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return <div className="setup-row">
    <label className="setup-row-label" htmlFor={htmlFor}>{label}{hint && <small>{hint}</small>}</label>
    <div className="setup-row-value">{children}</div>
  </div>;
}

function Segmented<T extends string>({ label, options, value, onChoose }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChoose: (value: T) => void }) {
  return <div className="setup-segmented" role="group" aria-label={label}>{options.map(([option, text]) =>
    <button key={option} type="button" aria-pressed={value === option} onClick={() => { if (value !== option) onChoose(option); }}>{text}</button>)}</div>;
}

export function SetupDrawer({ project, onChange, onMeasure, hasSupports, request, onClose }: {
  project: WorkshopProject; onChange: (project: WorkshopProject) => void; onMeasure: OnMeasure; hasSupports: boolean;
  /** A new object each time Setup is opened, so reopening at another target moves focus again. */
  request: { target: SetupTarget | null };
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [editingCar, setEditingCar] = useState<string | null>(null);
  const [car, setCar] = useState<CarForm>(EMPTY_CAR);
  const [carError, setCarError] = useState('');
  const [carFormOpen, setCarFormOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { catalogue, error: catalogueError } = useTrainCatalogue();
  /** Element to focus after the next render; '' is the drawer itself. */
  const [focusId, setFocusId] = useState<string | null>(null);

  const openCarForm = (form: CarForm, id: string | null) => {
    setPickerOpen(false); setEditingCar(id); setCar(form); setCarError(''); setCarFormOpen(true); setFocusId(CAR_NAME);
  };
  const closeCarForm = () => { setEditingCar(null); setCar({ ...EMPTY_CAR }); setCarError(''); setCarFormOpen(false); setFocusId(ADD_CAR); };
  const openPicker = () => { closeCarForm(); setPickerOpen(true); setFocusId(TRAIN_SEARCH); };

  useEffect(() => {
    const target = request.target;
    if (target === 'car') openPicker();
    else setFocusId(target === null ? '' : target === 'track' ? countId(OWNED_DEFINITIONS[0].family) : measurementId(target));
  }, [request]);
  useEffect(() => {
    if (focusId === null) return;
    const element = focusId ? document.getElementById(focusId) : panel.current;
    element?.focus({ preventScroll: true });
    // Show the whole form or section around the field, not just the field.
    if (focusId) (element?.closest('form, .setup-section') ?? element)?.scrollIntoView({ block: 'nearest' });
    setFocusId(null);
  }, [focusId]);
  useEffect(() => {
    // Escape closes from anywhere except another text field (the header rename handles its own).
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target instanceof HTMLInputElement && !panel.current?.contains(event.target))) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [onClose]);

  function keepFocusInside(event: KeyboardEvent<HTMLElement>) {
    // The builder listens on window for R, Delete and undo; they must not act on the layout from here.
    event.stopPropagation();
    if (event.key !== 'Tab' || !panel.current) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  const update = (mutate: (draft: WorkshopProject) => void) => onChange(changeProject(project, mutate));
  const saveCar = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Car = { id: editingCar ?? crypto.randomUUID(), name: car.name.trim(),
      length: Number(car.length), width: Number(car.width), height: Number(car.height),
      wheelbase: Number(car.wheelbase), couplerGap: Number(car.couplerGap || 0), loadDescription: car.loadDescription.trim(),
      ...(car.gauge === 'standard' ? {} : { gauge: car.gauge }), ...(car.cog ? { cog: true as const } : {}) };
    try {
      onChange(setSetupCars(project, next));
      closeCarForm();
    } catch (error) { setCarError(error instanceof Error ? error.message : 'Check the car sizes.'); }
  };
  const moveCar = (index: number, by: -1 | 1) => update(draft => { [draft.cars[index], draft.cars[index + by]] = [draft.cars[index + by], draft.cars[index]]; });
  const example = project.cars.some(item => item.example);
  // Each catalogue set in the train whose power needs a word: metal-rail 9 V on plastic rails, infrared beside Bluetooth mechanisms…
  const powerNotes = [...new Set(project.cars.flatMap(item => item.model ? [item.model.set] : []))].flatMap(id => {
    const set = catalogue?.sets.find(item => item.id === id), note = set && POWER_NOTES[set.power].note;
    return set && note ? [{ id, text: `${set.id.replace(/-1$/, '')} ${set.name}: ${note}` }] : [];
  });
  const totalPieces = OWNED_DEFINITIONS.reduce((sum, { family }) => sum + (project.inventory[family] ?? 0), 0);
  const room = project.measurements;
  const roomDefault = room.roomWidth.status === 'estimate' || room.roomDepth.status === 'estimate';

  return <>
    <div className="setup-scrim" aria-hidden="true" onClick={onClose} />
    <aside ref={panel} className="setup-drawer" role="dialog" aria-modal="true" aria-label="Setup" tabIndex={-1} onKeyDown={keepFocusInside}>
      <header className="setup-drawer-head"><h2>Setup</h2><button type="button" className="setup-close" aria-label="Close setup" onClick={onClose}>✕</button></header>
      <div className="setup-drawer-body">
        <section className="setup-section" aria-labelledby="setup-track-title">
          <div className="setup-section-head"><h3 id="setup-track-title">Your track</h3><span>{totalPieces} {totalPieces === 1 ? 'piece' : 'pieces'}</span></div>
          <div className="setup-chips" role="group" aria-label="Track presets">{PRESETS.map(([preset, label]) =>
            <button key={preset} type="button" aria-pressed={inventoryMatches(project, preset)} onClick={() => onChange(setSetupInventoryPreset(project, preset))}>{label}</button>)}</div>
          <ul className="setup-counts">{OWNED_DEFINITIONS.map(({ family, label, owned }) => {
            const kit = owned?.kit;
            return <li key={family}>
              <label htmlFor={countId(family)}>{label}<small>{kit ?? owned?.partNumbers.join(' / ')}</small></label>
              <CountStepper family={family} label={`${label} ${kit ? 'assemblies' : 'pieces'}`} count={project.inventory[family] ?? 0}
                onCount={count => onChange(setSetupInventory(project, family, count))} />
            </li>;
          })}</ul>
        </section>

        <section className="setup-section" aria-labelledby="setup-train-title">
          <div className="setup-section-head"><h3 id="setup-train-title">Your train</h3>{example && <span className="setup-tag">Example train</span>}</div>
          <ol className="setup-cars">{project.cars.map((item, index) => <li key={item.id}>
            <div><strong>{item.name}</strong><small>{item.model ? `${item.model.set.replace(/-1$/, '')} · ` : ''}{Math.round(item.length)} × {Math.round(item.width)} × {Math.round(item.height)} mm{item.loadDescription ? ` · ${item.loadDescription}` : ''}
              {item.gauge === 'narrow' ? ' · narrow gauge' : item.gauge === 'monorail' ? ' · monorail' : ''}{item.cog ? ' · cog' : ''}</small></div>
            {!item.example && <div className="setup-car-actions">
              {/* A catalogue model's sizes are measured; a custom car's are the user's to edit. */}
              {!item.model && <button type="button" onClick={() => openCarForm({ name: item.name, length: String(item.length), width: String(item.width), height: String(item.height),
                wheelbase: String(item.wheelbase), couplerGap: String(item.couplerGap), loadDescription: item.loadDescription ?? '',
                gauge: item.gauge ?? 'standard', cog: item.cog === true }, item.id)}>Edit</button>}
              <button type="button" aria-label={`Move ${item.name} up`} aria-disabled={index === 0} onClick={() => { if (index > 0) moveCar(index, -1); }}>↑</button>
              <button type="button" aria-label={`Move ${item.name} down`} aria-disabled={index === project.cars.length - 1} onClick={() => { if (index < project.cars.length - 1) moveCar(index, 1); }}>↓</button>
              <button type="button" aria-label={`Remove ${item.name}`} onClick={() => {
                update(draft => { draft.cars.splice(index, 1); });
                if (editingCar === item.id) closeCarForm(); else setFocusId(ADD_CAR);
              }}>Remove</button>
            </div>}
          </li>)}</ol>
          {powerNotes.map(note => <p key={note.id} className="setup-power-note" role="note">{note.text}</p>)}
          {carFormOpen ? <form className="setup-car-form" onSubmit={saveCar} aria-label={editingCar ? 'Edit car' : 'Add car'}>
            <label className="setup-car-name">Name<input id={CAR_NAME} required value={car.name} onChange={event => setCar({ ...car, name: event.target.value })}
              placeholder={project.cars.some(item => !item.example) ? 'e.g. Wagon' : 'e.g. Locomotive'} /></label>
            {CAR_FIELDS.map(([key, label]) => <label key={key} className={`setup-car-${key}`}>{label}<span className="setup-unit">
              <input type="number" required={key !== 'couplerGap'} min={key === 'couplerGap' ? 0 : 0.01} step="any" inputMode="decimal" value={car[key]}
                onChange={event => setCar(current => ({ ...current, [key]: event.target.value }))} /><i>mm</i></span></label>)}
            <label className="setup-car-load">Load (optional)<input value={car.loadDescription} onChange={event => setCar({ ...car, loadDescription: event.target.value })} placeholder="e.g. crane arm raised" /></label>
            <label className="setup-car-gauge">Track<select value={car.gauge} onChange={event => setCar({ ...car, gauge: event.target.value as CarGauge })}>
              {CAR_GAUGES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label className="setup-car-cog"><input type="checkbox" checked={car.cog} onChange={event => setCar({ ...car, cog: event.target.checked })} />Cog drive</label>
            {carError && <p role="alert">{carError}</p>}
            <div className="setup-car-buttons"><button type="submit" className="setup-primary">{editingCar ? 'Save car' : 'Add car'}</button><button type="button" onClick={closeCarForm}>Cancel</button></div>
          </form> : pickerOpen ? <TrainPicker catalogue={catalogue} error={catalogueError} onClose={() => { setPickerOpen(false); setFocusId(ADD_TRAIN); }}
            onAdd={cars => onChange(setSetupCars(project, ...cars))} /> :
            <div className="setup-train-add">
              <button type="button" id={ADD_TRAIN} className="setup-add" onClick={openPicker}>+ Add a train</button>
              <button type="button" id={ADD_CAR} className="setup-add" onClick={() => openCarForm({ ...EMPTY_CAR }, null)}>+ Custom car</button>
            </div>}
          {catalogue && <TrainAttribution catalogue={catalogue} />}
        </section>

        <section className="setup-section" aria-labelledby="setup-room-title">
          <div className="setup-section-head"><h3 id="setup-room-title">Room</h3></div>
          <Row label="Table" hint={roomDefault ? 'default' : undefined} htmlFor={measurementId('roomWidth')}>
            <MeasureInput project={project} field="roomWidth" onMeasure={onMeasure} /><span className="setup-by">×</span><MeasureInput project={project} field="roomDepth" onMeasure={onMeasure} />
          </Row>
          <Row label="Max ramp length" htmlFor={measurementId('availableApproachRun')}><MeasureInput project={project} field="availableApproachRun" onMeasure={onMeasure} /></Row>
          {(hasSupports || project.mounting === 'anchored') && <Row label="Supports">
            <Segmented label="Supports" options={[['reversible', 'Freestanding'], ['anchored', 'Anchored']] as const} value={project.mounting}
              onChoose={mode => update(draft => { draft.mounting = mode; })} />
          </Row>}
        </section>

        <section className="setup-section" aria-labelledby="setup-printer-title">
          <div className="setup-section-head"><h3 id="setup-printer-title">Printer</h3></div>
          <Segmented label="Printer" options={[['X1 Carbon', 'X1 Carbon'], ['A1 mini', 'A1 mini']] as const} value={project.printer}
            onChoose={printer => onChange(setSetupPrinter(project, printer))} />
          <p className="setup-note">More print settings in Print → Advanced</p>
        </section>

        {project.trackSystem === 'custom-joiner-v1' && <section className="setup-section" aria-labelledby="setup-custom-title">
          <div className="setup-section-head"><h3 id="setup-custom-title">Custom track</h3></div>
          <p className="setup-note">This project uses the older custom printed-joiner track, which doesn’t connect to standard brick track.</p>
          {CUSTOM_RAIL.map(key => <Row key={key} label={MEASUREMENT_LABELS[key]} htmlFor={measurementId(key)}><MeasureInput project={project} field={key} onMeasure={onMeasure} /></Row>)}
          <button type="button" className="setup-add" onClick={() => {
            if (window.confirm('Switch this project to standard brick track? Connector calibration will reset.')) update(draft => {
              draft.trackSystem = 'brick-v1';
              draft.connectorFit = { adjustmentMm: 0, settingsKey: null, calibrationId: null };
            });
          }}>Switch to standard brick track</button>
        </section>}
      </div>
    </aside>
  </>;
}
