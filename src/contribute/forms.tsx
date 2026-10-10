import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EndsEditor, endsProblem } from './ends-editor';
import { meshFromStl, type MarkedEnds, type StlMesh } from './ends';
import {
  ADAPTED_LICENCES, CAR_KINDS, EMPTY_TRAIN, LICENCE, POWERS, PUBLIC_NOTICE, TEXT_MAX, TWO_ENDED_NOTE, base64, glbProblem,
  label, licenceUrl, powerLabel, sizeHint, stlProblem, trainMetadata, upload, type Submission, type TrainDraft, type UploadBody
} from './contribute';
import { ModelViewer } from './viewer';

export const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** The permanent-publication notice (R18), then the rights attestation for the upload's licence (R17). */
export function Attestation({ licence, statement, checked, onChange }: {
  licence: string; statement: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <div className="contribute-attest">
    <p className="contribute-notice">{PUBLIC_NOTICE}</p>
    <label className="contribute-check"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span>{statement} I share it under <a href={licenceUrl(licence)} target="_blank" rel="noopener">{label(licence)}</a>.</span></label>
  </div>;
}

/** What every upload form gets from the page: where a sent upload goes, why sending is closed for now ('' while it is
 * open: the uploads left are spent), and a call after every try, sent or refused, since each one counts. */
export interface UploadProps { onSubmitted: (submission: Submission) => void; closed?: string; onTried?: () => void }

/** An upload form's frame: its fields, the attestation, the service's answer and the send button. */
export function UploadForm({ label: name, children, ready, busy, error, closed, onSubmit }: {
  label: string; children: ReactNode; ready: boolean; busy: boolean; error: string; closed?: string; onSubmit: () => void;
}) {
  const open = ready && !busy && !closed;
  return <form className="contribute-form" aria-label={name} onSubmit={(event: FormEvent) => { event.preventDefault(); if (open) onSubmit(); }}>
    {children}
    {error && <p className="account-error" role="alert">{error}</p>}
    <div className="save-actions">
      {closed && <p className="contribute-closed" role="status">{closed}</p>}
      <button type="submit" className="primary-button" disabled={!open}>{busy ? 'Checking…' : 'Send for review'}</button>
    </div>
  </form>;
}

/** Sends `body`; the submission, or the error message to show (the service's check result, the upload limits…). */
export function useUpload({ onSubmitted, onTried }: UploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(body: UploadBody) {
    setBusy(true); setError('');
    try { onSubmitted(await upload(body)); }
    catch (failure) { setError(message(failure, 'Could not send the upload.')); }
    finally { setBusy(false); onTried?.(); }
  }
  return { busy, error, setError, send };
}

async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const file = event.target.files?.[0];
  return file ? { name: file.name, bytes: await file.arrayBuffer() } : null;
}

/** A piece: its binary STL, its two marked ends and its name (R17, R20). */
export function PieceForm({ initial, ...props }: UploadProps & { initial?: { name: string; ends: MarkedEnds } }) {
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer; mesh: StlMesh } | null>(null);
  const [fileProblem, setFileProblem] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [ends, setEnds] = useState<MarkedEnds>(initial?.ends ?? [null, null]);
  const [attest, setAttest] = useState(false);
  const { busy, error, setError, send } = useUpload(props);
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = await readFile(event);
    setError('');
    if (!chosen) return;
    const problem = stlProblem(chosen.bytes);
    setFileProblem(problem ?? '');
    setFile(problem ? null : { ...chosen, mesh: meshFromStl(chosen.bytes) });
  }
  const hint = file && sizeHint(file.mesh.size);
  const ready = !!file && !hint && endsProblem(file.mesh, ends) === null && !!name.trim() && attest;
  return <UploadForm label="Upload a piece" ready={ready} busy={busy} error={error} closed={props.closed}
    onSubmit={() => void send({ kind: 'piece', licence: LICENCE, attest: true, metadata: { name: name.trim(), ends }, file: base64(file!.bytes) })}>
    <p className="contribute-note">{TWO_ENDED_NOTE}</p>
    <label className="save-name">STL file<input type="file" accept=".stl,model/stl" onChange={event => void choose(event)} /></label>
    <p className="save-hint">Binary STL in millimetres, +z up, its flat underside down: up to 20 MB and 200,000 triangles, no wider than the A1 mini bed (180 mm).</p>
    {fileProblem && <p className="account-error" role="alert">{fileProblem}</p>}
    {file && <p className="contribute-facts">{file.name} · {(file.mesh.faces.length / 3).toLocaleString('en-GB')} triangles ·
      {' '}{file.mesh.size.map(value => Math.round(value * 10) / 10).join(' × ')} mm</p>}
    {hint && <p className="account-error" role="alert">{hint}</p>}
    {file && !hint && <EndsEditor mesh={file.mesh} ends={ends} onChange={setEnds} />}
    <label className="save-name">Name<input value={name} maxLength={TEXT_MAX} placeholder="Wide 45° curve" onChange={event => setName(event.target.value)} /></label>
    <Attestation licence={LICENCE} statement="I designed this piece, or have the right to share it." checked={attest} onChange={setAttest} />
  </UploadForm>;
}

let loader: GLTFLoader | null = null;
/** A checked glTF binary as a scene to look at (the service checks it is self-contained before anyone else sees it). */
export function useModel(bytes: ArrayBuffer | null): THREE.Object3D | null {
  const [scene, setScene] = useState<THREE.Object3D | null>(null);
  useEffect(() => {
    let active = true;
    setScene(null);
    if (bytes) (loader ??= new GLTFLoader()).parseAsync(bytes.slice(0), '').then(result => { if (active) setScene(result.scene); }, () => {});
    return () => { active = false; };
  }, [bytes]);
  return scene;
}

/** A train car's model (one self-contained glTF binary, vertex colours only), its set facts, and its source when it was
 * adapted from another CC BY model (R17). */
export function TrainForm({ initial, ...props }: UploadProps & { initial?: TrainDraft }) {
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [fileProblem, setFileProblem] = useState('');
  const [draft, setDraft] = useState<TrainDraft>(initial ?? EMPTY_TRAIN);
  const [attest, setAttest] = useState(false);
  const { busy, error, setError, send } = useUpload(props);
  const model = useModel(file?.bytes ?? null);
  const set = (change: Partial<TrainDraft>) => setDraft(current => ({ ...current, ...change }));
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = await readFile(event);
    setError('');
    if (!chosen) return;
    const problem = glbProblem(chosen.bytes);
    setFileProblem(problem ?? '');
    setFile(problem ? null : chosen);
  }
  const metadata = useMemo(() => trainMetadata(draft), [draft]);
  const licence = draft.adapted ? draft.licence : LICENCE;
  const ready = !!file && !!draft.name.trim() && /^\d{4}$/.test(draft.year) && !!draft.bogies.trim() && draft.front !== '' && draft.rear !== '' &&
    (!draft.adapted || (!!draft.url.trim() && !!draft.authors.trim())) && attest;
  const field = (text: string, key: 'year' | 'bogies' | 'front' | 'rear' | 'url' | 'authors', hint = '') =>
    <label className="save-name">{text}<input value={draft[key]} placeholder={hint} onChange={event => set({ [key]: event.target.value })} /></label>;
  return <UploadForm label="Upload a train" ready={ready} busy={busy} error={error} closed={props.closed}
    onSubmit={() => void send({ kind: 'train', licence, attest: true, metadata, file: base64(file!.bytes) })}>
    <label className="save-name">Model file<input type="file" accept=".glb,model/gltf-binary" onChange={event => void choose(event)} /></label>
    <p className="save-hint">One car as a glTF binary (.glb) in the car frame: x forward, z up, millimetres, the origin midway between the outer
      bogie pivots at railhead top. Vertex colours only, everything embedded: no textures, images, extensions or links to other files.
      Up to 250 KB and 12,000 triangles.</p>
    {fileProblem && <p className="account-error" role="alert">{fileProblem}</p>}
    {file && <ModelViewer object={model} label="The train model in 3D" />}
    <label className="save-name">Name<input value={draft.name} maxLength={TEXT_MAX} onChange={event => set({ name: event.target.value })} /></label>
    <div className="contribute-row">
      {field('Year', 'year', '1966')}
      <label className="save-name">Power<select value={draft.power} onChange={event => set({ power: event.target.value as TrainDraft['power'] })}>
        {POWERS.map(power => <option key={power} value={power}>{powerLabel(power)}</option>)}</select></label>
      <label className="save-name">Track<select value={draft.gauge} onChange={event => set({ gauge: event.target.value as TrainDraft['gauge'] })}>
        <option value="standard">Standard</option><option value="monorail">Monorail</option></select></label>
    </div>
    <div className="contribute-row">
      <label className="save-name">Car<select value={draft.kind} onChange={event => set({ kind: event.target.value as TrainDraft['kind'] })}>
        {CAR_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label className="contribute-check contribute-inline"><input type="checkbox" checked={draft.motorised} onChange={event => set({ motorised: event.target.checked })} />Motorised</label>
    </div>
    <div className="contribute-row">
      {field('Bogie pivots (mm)', 'bogies', '-24, 24')}
      {field('Front coupler (mm)', 'front', '72')}
      {field('Rear coupler (mm)', 'rear', '-94')}
    </div>
    <p className="save-hint">Along the car from its origin: the pivots rear to front, and each coupler’s face. Plateway measures the length, width,
      height and outline from the model.</p>
    <fieldset className="contribute-origin">
      <legend>Who made the model</legend>
      <label className="contribute-check"><input type="radio" name="origin" checked={!draft.adapted} onChange={() => set({ adapted: false })} />I made it (CC BY 4.0)</label>
      <label className="contribute-check"><input type="radio" name="origin" checked={draft.adapted} onChange={() => set({ adapted: true })} />I adapted another CC BY model (LDraw, for example)</label>
      {draft.adapted && <>
        {field('Source web address', 'url', 'https://library.ldraw.org/omr/sets/…')}
        {field('Source authors', 'authors', 'Names, comma separated')}
        <label className="save-name">Source licence<select value={draft.licence} onChange={event => set({ licence: event.target.value })}>
          {ADAPTED_LICENCES.map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label>
        <p className="save-hint">An adapted model keeps its source’s licence and credits its authors.</p>
      </>}
    </fieldset>
    <Attestation licence={licence} checked={attest} onChange={setAttest}
      statement={draft.adapted ? 'I adapted this model from the source above, whose licence allows sharing it.' : 'I made this model, or have the right to share it.'} />
  </UploadForm>;
}
