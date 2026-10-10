import { useMemo, useRef, useState } from 'react';
import type { FurnitureType } from '../domain/furniture';
import { LICENCE, TEXT_MAX } from './contribute';
import { Attestation, UploadForm, useUpload, type UploadProps } from './forms';
import { DEFAULT_DESIGN, DESIGN_LIMITS, designProblem, furnitureFromDesign, type FurnitureDesign } from './furniture-design';
import { FurniturePreview, PREVIEW_FAMILY } from './furniture-preview';

/** A number input's value: NaN while it is empty, which `designProblem` reports. */
const numberOf = (text: string) => text.trim() === '' ? Number.NaN : Number(text);

/**
 * A furniture preset (R17): the outline, the surfaces track runs on with their heights, an optional cubby grid, colour
 * and label, previewed live in the Build 3D scene. Sends the `FurnitureType` the service checks (cad/library/check.py).
 */
export function FurnitureForm({ initial, ...props }: UploadProps & { initial?: { name: string; design: FurnitureDesign | null } }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [design, setDesign] = useState<FurnitureDesign>(initial?.design ?? DEFAULT_DESIGN);
  const [attest, setAttest] = useState(false);
  const { busy, error, send } = useUpload(props);
  const problem = designProblem(design);
  const label = name.trim() || 'Furniture';
  // While a number field is empty the preview keeps the last whole design.
  const shown = useRef<FurnitureType | null>(null);
  const preview = useMemo(() => {
    const numbers = [design.width, design.depth, ...design.surfaces.map(surface => surface.height), design.cubbies.rows, design.cubbies.cols, design.cubbies.opening];
    if (numbers.every(Number.isFinite) || !shown.current) shown.current = furnitureFromDesign(design, label, PREVIEW_FAMILY);
    return shown.current;
  }, [design, label]);
  const set = (change: Partial<FurnitureDesign>) => setDesign(current => ({ ...current, ...change }));
  const setSurface = (index: number, change: Partial<FurnitureDesign['surfaces'][number]>) =>
    set({ surfaces: design.surfaces.map((surface, at) => at === index ? { ...surface, ...change } : surface) });
  const size = (text: string, key: 'width' | 'depth') =>
    <label className="save-name">{text}<input type="number" min={DESIGN_LIMITS.size[0]} max={DESIGN_LIMITS.size[1]} value={Number.isNaN(design[key]) ? '' : design[key]}
      onChange={event => set({ [key]: numberOf(event.target.value) })} /></label>;
  const cubby = (text: string, key: 'rows' | 'cols' | 'opening') =>
    <label className="save-name">{text}<input type="number" min={0} value={Number.isNaN(design.cubbies[key]) ? '' : design.cubbies[key]}
      onChange={event => set({ cubbies: { ...design.cubbies, [key]: numberOf(event.target.value) } })} /></label>;
  return <UploadForm label="Upload furniture" ready={!problem && !!name.trim() && attest} busy={busy} error={error} closed={props.closed}
    onSubmit={() => void send({ kind: 'furniture', licence: LICENCE, attest: true,
      metadata: { name: name.trim(), design, type: furnitureFromDesign(design, name.trim(), PREVIEW_FAMILY) } })}>
    <div className="contribute-furniture">
      <div className="contribute-furniture-fields">
        <label className="save-name">Label<input value={name} maxLength={TEXT_MAX} placeholder="Hobby table" onChange={event => setName(event.target.value)} /></label>
        <div className="contribute-row">{size('Width (mm)', 'width')}{size('Depth (mm)', 'depth')}</div>
        <fieldset className="contribute-surfaces">
          <legend>Surfaces for track</legend>
          {design.surfaces.map((surface, index) => <div className="contribute-row" key={index}>
            <input aria-label={`Surface ${index + 1} name`} value={surface.name} maxLength={40} onChange={event => setSurface(index, { name: event.target.value })} />
            <input aria-label={`Surface ${index + 1} height (mm)`} type="number" min={DESIGN_LIMITS.height[0]} max={DESIGN_LIMITS.height[1]}
              value={Number.isNaN(surface.height) ? '' : surface.height} onChange={event => setSurface(index, { height: numberOf(event.target.value) })} />
            <button type="button" className="quiet-button" onClick={() => set({ surfaces: design.surfaces.filter((_, at) => at !== index) })}>Remove</button>
          </div>)}
          <button type="button" className="quiet-button" disabled={design.surfaces.length >= DESIGN_LIMITS.surfaces}
            onClick={() => set({ surfaces: [...design.surfaces, { name: `shelf ${design.surfaces.length + 1}`, height: 400 }] })}>Add surface</button>
          <p className="save-hint">Each surface is a board across the whole outline at that height, on four corner legs.</p>
        </fieldset>
        <fieldset className="contribute-surfaces">
          <legend>Cubby grid</legend>
          <div className="contribute-row">{cubby('Rows', 'rows')}{cubby('Columns', 'cols')}{cubby('Opening (mm)', 'opening')}</div>
          <p className="save-hint">Open-through cubbies from the floor up, square openings, 18 mm boards; leave rows at 0 for none.</p>
        </fieldset>
        <label className="save-name contribute-colour">Colour<input type="color" value={design.colour} onChange={event => set({ colour: event.target.value })} /></label>
      </div>
      <div className="contribute-furniture-side">
        <FurniturePreview type={preview} />
        <p className={`contribute-status${problem ? ' is-warn' : ''}`} role="status">{problem ??
          `${preview.width} × ${preview.depth} × ${preview.height} mm · ${preview.surfaces.length} ${preview.surfaces.length === 1 ? 'surface' : 'surfaces'} for track`}</p>
      </div>
    </div>
    <Attestation licence={LICENCE} statement="I designed this furniture preset." checked={attest} onChange={setAttest} />
  </UploadForm>;
}
