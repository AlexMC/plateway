/**
 * Community contributions (R17, R18, KTD10): the service's `/api/submissions` routes for members and
 * `/api/admin/submissions` for Alex's quick look (cad/service/submissions.py), and what the upload forms check in the
 * browser before sending. The service runs the full check (cad/library/check.py) and is the authority.
 */
import type { MeshEnd } from '../domain/pieces/families/community';
import { POWER_NOTES } from '../domain/trains';
import { resetText } from '../export/jobs';
import { apiFetch, apiJson } from '../net/api';
import type { FurnitureDesign } from './furniture-design';

export type SubmissionKind = 'piece' | 'train' | 'furniture';
/** A published upload reads as its library item's state: `live`, `retired` or `removed` (cad/service/library_publish.py). */
export type SubmissionState = 'awaiting_look' | 'rejected' | 'approved' | 'pr_open' | 'merged' | 'closed' | 'withdrawn' | 'live' |
  'retired' | 'removed';
export interface Submission {
  id: string; kind: SubmissionKind; state: SubmissionState; name: string; author: string; licence: string;
  metadata: Record<string, unknown>;
  /** Why it was rejected (Alex's reason, or the pull request's closing comment); null otherwise. */
  reason: string | null;
  uploadedAt: string; reviewedAt: string | null;
}
/** The upload cap that binds `left`: stored uploads today, or upload tries (refused ones included) today or this hour. */
export type UploadLimit = 'uploads' | 'attempts_today' | 'attempts_hour';
export interface MySubmissions {
  submissions: Submission[];
  /** Uploads left under the binding cap, `limit`; `resetsAt` is when that number next goes up (null while it is at its most).
   * An admin has no cap: `left` and `limit` are null. */
  left: number | null; limit: UploadLimit | null; resetsAt: string | null;
  canReview: boolean;
}
export interface ReviewQueue { waiting: Submission[]; reviewed: Submission[] }
export interface QuickLook extends Submission { file: { name: string; bytes: number } | null }

/** cad/library/check.py: binary STL only, up to 20 MB and 200,000 triangles; trains up to 250 KB. A piece fits the A1
 * mini as its arrange places it: `BED` high and `PIECE_PLAN` across in plan (the bed less a 7 mm margin each side). */
export const PIECE_BYTES = 20_000_000, PIECE_TRIANGLES = 200_000, PIECE_SMALLEST = 10, BED = 180, PIECE_PLAN = BED - 2 * 7;
export const TRAIN_BYTES = 250_000, TEXT_MAX = 120, REASON_MAX = 1000;
export const LICENCE = 'CC-BY-4.0';
export const ADAPTED_LICENCES = ['CC-BY-2.0', 'CC-BY-2.5', 'CC-BY-3.0', 'CC-BY-4.0'] as const;
export const POWERS = ['none', '4.5V', '12V', '9V', 'RC', 'IR', 'BT', 'monorail'] as const;
/** A train's power as shown: its display label, or the stored value when it is not one of POWERS. */
export const powerLabel = (power: unknown) => { const known = POWERS.find(item => item === power); return known ? POWER_NOTES[known].label : String(power ?? ''); };
export const CAR_KINDS = ['loco', 'tender', 'wagon', 'coach', 'caboose', 'other'] as const;
/** Shown before the rights attestation on every upload form. */
export const PUBLIC_NOTICE = 'Once Alex approves this upload, it and your display name are public on GitHub permanently, even if it is not merged or you delete your account.';
export const TWO_ENDED_NOTE = 'Contributed pieces are two-ended plain track for now: one track from end to end, no junctions, crossings or moving parts. They print exactly as uploaded.';

const STATES: Record<SubmissionState, string> = {
  awaiting_look: 'Waiting for review', rejected: 'Rejected', approved: 'Approved: becoming a pull request',
  pr_open: 'Approved: final check on GitHub', merged: 'Merged: joining the library', closed: 'Rejected', withdrawn: 'Withdrawn',
  live: 'In the library', retired: 'Retired from the palette', removed: 'Removed from the library'
};
/** What the contributor sees for a state; a pull request closed without merging reads as rejected. */
export const stateLabel = (state: SubmissionState) => STATES[state];
export const isRejected = (submission: Pick<Submission, 'state'>) => submission.state === 'rejected' || submission.state === 'closed';
export const label = (licence: string) => licence.replace(/^CC-BY-/, 'CC BY ');
/** A CC BY licence's deed (`CC-BY-2.0` → …/by/2.0/). */
export const licenceUrl = (licence: string) => `https://creativecommons.org/licenses/by/${licence.slice('CC-BY-'.length)}/`;

const CLOSED: Record<UploadLimit, string> = {
  uploads: 'Daily upload limit reached — you can send more', attempts_today: 'Too many upload tries today — try again',
  attempts_hour: 'Too many upload tries this hour — try again'
};
/** What the upload forms say about the uploads left: how many, or at none, why and when (in the member's time) they reopen. */
export function uploadsLeft(mine: Pick<MySubmissions, 'left' | 'limit' | 'resetsAt'>, now = new Date()): string {
  if (mine.left === null || mine.limit === null) return 'As an admin, you have no upload limit.';
  if (!mine.left) return `${CLOSED[mine.limit]} ${resetText(mine.resetsAt, now)}.`;
  return `You can send ${mine.left} more ${mine.left === 1 ? 'upload' : 'uploads'} ${mine.limit === 'attempts_hour' ? 'this hour' : 'today'}.`;
}

/** Why the bytes can't be a piece's STL, checked before anything parses them (check.py `stl_triangles`); else null. */
export function stlProblem(bytes: ArrayBuffer): string | null {
  if (bytes.byteLength > PIECE_BYTES) return `The STL is ${(bytes.byteLength / 1e6).toFixed(1)} MB; the limit is ${PIECE_BYTES / 1e6} MB.`;
  const count = bytes.byteLength >= 84 ? new DataView(bytes).getUint32(80, true) : -1;
  if (bytes.byteLength !== 84 + 50 * count) {
    const head = new TextDecoder().decode(bytes.slice(0, 1024));
    return /^solid/i.test(head) && head.includes('facet') ? 'Only binary STL is accepted, and this is ASCII STL. Export it again as binary STL.' :
      'The STL’s length doesn’t match its triangle count: it is damaged or not a binary STL.';
  }
  if (count === 0) return 'The STL has no triangles.';
  if (count > PIECE_TRIANGLES) return `The STL has ${count.toLocaleString('en-GB')} triangles; the limit is ${PIECE_TRIANGLES.toLocaleString('en-GB')}. Simplify the mesh.`;
  return null;
}

const mm = (value: number) => `${Number(value.toFixed(1)).toLocaleString('en-GB')} mm`;
/** Why a mesh's size can't be a piece (check.py `_size_problem`): the wrong unit, or too large for the A1 mini; else null. */
export function sizeHint(size: readonly [number, number, number]): string | null {
  const largest = Math.max(...size);
  if (largest < PIECE_SMALLEST) return `The piece is only ${mm(largest)} across: was it exported in inches or metres? Plateway reads STL in millimetres.`;
  if (size.some(value => value > BED)) return `The piece is ${size.map(mm).join(' × ')}: larger than the A1 mini bed (${BED} mm). Was it exported in another unit?`;
  if (size[0] > PIECE_PLAN || size[1] > PIECE_PLAN) return `The piece is ${size.map(mm).join(' × ')}: the A1 mini fits at most ${PIECE_PLAN} mm × ${PIECE_PLAN} mm in plan (its ${BED} mm bed less a 7 mm margin each side).`;
  return null;
}

/** Why the bytes can't be a train model before the service checks it, else null. */
export function glbProblem(bytes: ArrayBuffer): string | null {
  if (bytes.byteLength > TRAIN_BYTES) return `The model is ${Math.round(bytes.byteLength / 1000)} KB; the limit is ${TRAIN_BYTES / 1000} KB.`;
  if (bytes.byteLength < 28 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) return 'The file is not a glTF binary (.glb).';
  return null;
}

/** The bytes as base64, for the JSON upload. */
export function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let start = 0; start < view.length; start += 0x8000) text += String.fromCharCode(...view.subarray(start, start + 0x8000));
  return btoa(text);
}

export interface TrainDraft {
  name: string; year: string; power: typeof POWERS[number]; gauge: 'standard' | 'monorail'; kind: typeof CAR_KINDS[number];
  motorised: boolean; bogies: string; front: string; rear: string;
  adapted: boolean; url: string; authors: string; licence: string;
}
export const EMPTY_TRAIN: TrainDraft = { name: '', year: '', power: 'none', gauge: 'standard', kind: 'loco', motorised: false,
  bogies: '', front: '', rear: '', adapted: false, url: '', authors: '', licence: LICENCE };
/** A form filled in again from a rejected upload ("Submit a corrected version"). */
export type Correction =
  | { kind: 'piece'; name: string; ends: [MeshEnd | null, MeshEnd | null] }
  | { kind: 'train'; draft: TrainDraft }
  | { kind: 'furniture'; name: string; design: FurnitureDesign | null };

const text = (value: unknown) => typeof value === 'string' ? value : '';
const numberText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const isEnd = (value: unknown): value is MeshEnd => typeof value === 'object' && value !== null &&
  ['x', 'y', 'z', 'heading'].every(key => Number.isFinite((value as Record<string, unknown>)[key]));

/** The rejected upload's metadata as its form's starting point; the file is chosen again. */
export function correction(submission: Submission): Correction {
  const meta = submission.metadata;
  if (submission.kind === 'piece') {
    const ends = Array.isArray(meta.ends) ? meta.ends : [];
    return { kind: 'piece', name: text(meta.name), ends: [isEnd(ends[0]) ? ends[0] : null, isEnd(ends[1]) ? ends[1] : null] };
  }
  if (submission.kind === 'furniture') {
    return { kind: 'furniture', name: text(meta.name), design: typeof meta.design === 'object' && meta.design ? meta.design as FurnitureDesign : null };
  }
  const car = typeof meta.car === 'object' && meta.car ? meta.car as Record<string, unknown> : {};
  const couplers = typeof car.couplers === 'object' && car.couplers ? car.couplers as Record<string, unknown> : {};
  const source = typeof meta.source === 'object' && meta.source ? meta.source as Record<string, unknown> : null;
  return { kind: 'train', draft: {
    name: text(meta.name), year: numberText(meta.year), power: POWERS.find(item => item === meta.power) ?? 'none',
    gauge: meta.gauge === 'monorail' ? 'monorail' : 'standard', kind: CAR_KINDS.find(item => item === car.kind) ?? 'loco',
    motorised: car.motorised === true, bogies: Array.isArray(car.bogies) ? car.bogies.join(', ') : '',
    front: numberText(couplers.front), rear: numberText(couplers.rear), adapted: source !== null,
    url: text(source?.url), authors: Array.isArray(source?.authors) ? source.authors.join(', ') : '', licence: submission.licence
  } };
}

/** The train form's fields as upload metadata; the service measures the car's size, outline and triangles itself. */
export function trainMetadata(draft: TrainDraft): Record<string, unknown> {
  const bogies = draft.bogies.split(/[,\s]+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  return { name: draft.name.trim(), year: Number(draft.year), power: draft.power, gauge: draft.gauge,
    car: { kind: draft.kind, motorised: draft.motorised, bogies, couplers: { front: Number(draft.front), rear: Number(draft.rear) } },
    ...(draft.adapted ? { source: { url: draft.url.trim(), authors: draft.authors.split(',').map(author => author.trim()).filter(Boolean) } } : {}) };
}

export type UploadBody = { kind: SubmissionKind; licence: string; attest: true; metadata: Record<string, unknown>; file?: string };

export async function listMine(): Promise<MySubmissions> {
  return await apiJson<MySubmissions>('submissions', { fallback: 'Could not load your uploads.' });
}

export async function upload(body: UploadBody): Promise<Submission> {
  return await apiJson<Submission>('submissions', { json: body, fallback: 'Could not send the upload.' });
}

export async function reviewQueue(): Promise<ReviewQueue> {
  return await apiJson<ReviewQueue>('admin/submissions', { fallback: 'Could not load the uploads.' });
}

export async function quickLook(id: string): Promise<QuickLook> {
  return await apiJson<QuickLook>(`admin/submissions/${encodeURIComponent(id)}`, { fallback: 'Could not open the upload.' });
}

export async function quickLookFile(id: string): Promise<ArrayBuffer> {
  return await (await apiFetch(`admin/submissions/${encodeURIComponent(id)}/file`, { fallback: 'Could not load the file.' })).arrayBuffer();
}

export async function approveSubmission(id: string): Promise<Submission> {
  return await apiJson<Submission>(`admin/submissions/${encodeURIComponent(id)}/approve`, { method: 'POST', fallback: 'Could not approve the upload.' });
}

/** A library item's state after Alex retires or removes it (cad/service/library_publish.py). */
export interface LibraryItemState { id: string; version: number; kind: SubmissionKind; state: 'live' | 'retired' | 'removed' }

export async function retireItem(itemId: string): Promise<LibraryItemState> {
  return await apiJson<LibraryItemState>(`admin/library/${encodeURIComponent(itemId)}/retire`, { method: 'POST', fallback: 'Could not retire the item.' });
}

export async function removeItem(itemId: string): Promise<LibraryItemState> {
  return await apiJson<LibraryItemState>(`admin/library/${encodeURIComponent(itemId)}/remove`, { method: 'POST', fallback: 'Could not remove the item.' });
}

export async function rejectSubmission(id: string, reason: string): Promise<Submission> {
  return await apiJson<Submission>(`admin/submissions/${encodeURIComponent(id)}/reject`, { json: { reason }, fallback: 'Could not reject the upload.' });
}

/** `#contribute`, Alex's `#review` queue and a quick look `#review=<id>`; null for any other address. */
export type ContributeRoute = { view: 'contribute' } | { view: 'review' } | { view: 'look'; id: string };
const LOOK_HASH = /^#review=([0-9a-f-]{36})$/;
export function contributeRoute(hash: string): ContributeRoute | null {
  if (hash === '#contribute') return { view: 'contribute' };
  if (hash === '#review') return { view: 'review' };
  const look = LOOK_HASH.exec(hash);
  return look ? { view: 'look', id: look[1] } : null;
}
