import { useState } from 'react';
import { changeProject, type WorkshopProject } from '../domain/project';
import { effectivePrint, styleCounts } from '../domain/printer';
import { setSetupPrinter } from '../editor/setup-defaults';
import './design.css';

export const DESIGN_FIELDS = [
  ['deck_width','Deck width'],['deck_thickness','Deck thickness'],['joint_width','Joint width'],
  ['joint_depth','Joint tongue depth'],['joint_height','Joint height'],['joint_clearance','Joint clearance'],
  ['joint_length','Joint rail length'],['foot_length','Freestanding foot length'],['foot_width','Freestanding foot width'],
  ['foot_thickness','Freestanding foot thickness'],['stem_width','Column width'],['stem_depth','Column depth'],
  ['seat_width','Seat width'],['seat_depth','Seat depth'],['seat_thickness','Seat thickness'],
  ['reach','Anchored bracket reach'],['plate_width','Anchor plate width'],['plate_thickness','Anchor plate thickness'],
  ['arm_width','Bracket arm width'],['arm_thickness','Bracket arm thickness'],
  ['hole_diameter','Anchor hole diameter'],['hole_spacing','Anchor hole spacing'],
  ['coupon_body_length','Coupon body length']
] as const;

export function designFields(project: WorkshopProject) {
  return project.trackSystem === 'brick-v1' ?
    DESIGN_FIELDS.filter(([key]) => !key.startsWith('joint_') && !key.startsWith('deck_') && key !== 'coupon_body_length') :
    DESIGN_FIELDS;
}

interface PresetLists { materials: string[]; processes: string[]; fastProcess?: string }
/** Values the local slicer accepts; top-level lists are for the 0.4 mm nozzle. `fastProcess` is the fast-print track process. */
export type PrintPresets = Partial<Record<WorkshopProject['printer'], PresetLists & { byNozzle?: Record<string, PresetLists> }>>;

/** A positive number typed by the user, or null for an empty field; undefined means the draft is not valid yet. */
function parseMillimetres(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function DesignPanel({ project, presets, hasSupports, onChange }: {
  project: WorkshopProject; presets: PrintPresets; hasSupports: boolean; onChange: (project: WorkshopProject) => void;
}) {
  const print = effectivePrint(project);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const printerPresets = presets[project.printer];
  const available = printerPresets?.byNozzle?.[String(print.nozzleMm)] ?? printerPresets;
  const nozzles = [...new Set([print.nozzleMm, ...Object.keys(printerPresets?.byNozzle ?? {}).map(Number)])].sort((a, b) => a - b);

  function setNozzle(nozzleMm: number) {
    const lists = printerPresets?.byNozzle?.[String(nozzleMm)];
    onChange(changeProject(project, draft => {
      draft.printSettings.nozzleMm = nozzleMm;
      if (lists?.materials.length && !lists.materials.includes(print.material)) draft.material = lists.materials[0];
      if (lists?.processes.length && !lists.processes.includes(print.profile)) draft.printSettings.profile = lists.processes[0];
    }));
  }
  const options = (values: readonly string[] | undefined, current: string) => [...new Set([current, ...(values ?? [])])];

  function setPrinter(printer: WorkshopProject['printer']) {
    const next = setSetupPrinter(project, printer);
    const materials = presets[printer]?.byNozzle?.[String(effectivePrint(next).nozzleMm)]?.materials ?? presets[printer]?.materials;
    onChange(materials?.length && !materials.includes(effectivePrint(next).material)
      ? changeProject(next, draft => { draft.material = materials[0]; }) : next);
  }

  function commit(key: string, apply: (draft: WorkshopProject, value: number | null) => void, saved: number | null | undefined) {
    const text = drafts[key];
    setDrafts(({ [key]: _, ...rest }) => rest);
    if (text === undefined) return;
    const value = parseMillimetres(text);
    if (value === undefined || value === (saved ?? null)) return;
    onChange(changeProject(project, draft => apply(draft, value)));
  }

  const numberInput = (key: string, label: string, saved: number | undefined, apply: (draft: WorkshopProject, value: number | null) => void, placeholder?: string) =>
    <label key={key}>{label}<input type="number" min="0.001" step="any" aria-label={label} placeholder={placeholder}
      value={drafts[key] ?? (saved === undefined ? '' : String(saved))} aria-invalid={drafts[key] !== undefined && parseMillimetres(drafts[key]) === undefined}
      onChange={event => setDrafts(previous => ({ ...previous, [key]: event.target.value }))}
      onBlur={() => commit(key, apply, saved)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;

  return <section className="design-panel"><h3>Printer &amp; process</h3>
    <div className="design-grid">
      <label>Printer<select value={project.printer} onChange={event => setPrinter(event.target.value as WorkshopProject['printer'])}>
        <option value="X1 Carbon">X1 Carbon</option><option value="A1 mini">A1 mini</option></select></label>
      <label>Material<select value={print.material} onChange={event => onChange(changeProject(project, draft => { draft.material = event.target.value; }))}>
        {options(available?.materials, print.material).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Process<select value={print.profile} onChange={event => onChange(changeProject(project, draft => { draft.printSettings.profile = event.target.value; }))}>
        {options(available?.processes, print.profile).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Nozzle<select value={print.nozzleMm} onChange={event => setNozzle(Number(event.target.value))}>
        {nozzles.map(value => <option key={value} value={value}>{value} mm</option>)}</select></label>
    </div>
    {styleCounts(project).fast > 0 && <p>Fast print pieces use a faster process of their own; this process prints full-detail pieces, turnout moving parts and supports.</p>}
    {(hasSupports || project.trackSystem !== 'brick-v1') && <><h3>Part dimensions</h3><p>Millimetres. Leave a size empty to skip that part.</p>
    <div className="design-grid">{designFields(project).map(([key, label]) => numberInput(key, label, project.partDesign[key],
      (draft, value) => { if (value === null) delete draft.partDesign[key]; else draft.partDesign[key] = value; }, 'Not set'))}</div></>}
  </section>;
}
