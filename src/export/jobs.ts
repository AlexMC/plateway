/**
 * Prepares run as queued jobs on the service (R9–R13): this client starts, polls and cancels them, and words their
 * state for the Print step. A member has one active job at a time, whichever project or kind it prepares.
 */
import { ApiError, apiJson } from '../net/api';

export type JobKind = 'layout' | 'coupon' | 'grade';
export type JobState = 'queued' | 'running' | 'interrupted' | 'succeeded' | 'failed' | 'failed_too_large' | 'failed_system' |
  'cancelled' | 'expired';
/** A layout prepared in parts: one part's progress. */
export type JobPart = { index: number; state: JobState; stage: string | null; detail: string | null; progress: number | null };
/** A prepare as `GET /api/jobs/<id>` reports it. `position`: active jobs ahead of it (0 once it runs); `projectId` and
 * `projectName`: the saved project a layout prepares; `interruptions`: server restarts it went through. */
export type PrepareJob = {
  id: string; kind: JobKind; state: JobState; position: number | null; stage: string | null; detail: string | null;
  progress: number | null; error: string | null; packageId: string | null; cancelling: boolean;
  projectId: string | null; projectName: string | null; interruptions: number; parts?: JobPart[];
};
/** One daily limit (R13): `resetsAt` is when the next prepare frees up, once none are left. */
export type DailyLimit = { limit: number; remaining: number; resetsAt: string | null };
export type JobStatus = { active: PrepareJob | null; limits: { layout: DailyLimit; sample: DailyLimit } };

export const JOB_POLL_MS = 3000;
const ACTIVE: readonly JobState[] = ['queued', 'running', 'interrupted'];
export const isActive = (job: PrepareJob) => ACTIVE.includes(job.state);

export const fetchJobStatus = () => apiJson<JobStatus>('jobs', { fallback: 'Could not check your prepares.' });
export const fetchJob = (id: string) => apiJson<PrepareJob>(`jobs/${encodeURIComponent(id)}`, { fallback: 'Could not check the prepare.' });
/** 202 with a new job, or 200 with the member's active one (which may prepare another project or kind). */
export const startJob = (body: unknown) => apiJson<PrepareJob>('jobs', { json: body, fallback: 'Preparing failed.' });
/** Prepares a package again, e.g. after its files expired (R12). */
export const prepareAgain = (packageId: string) =>
  apiJson<PrepareJob>(`packages/${encodeURIComponent(packageId)}/prepare`, { method: 'POST', fallback: 'Preparing failed.' });
export const cancelJob = (id: string) =>
  apiJson<PrepareJob>(`jobs/${encodeURIComponent(id)}`, { method: 'DELETE', fallback: 'Could not cancel the prepare.' });

/** Polls `job` until it ends, reporting every answer. A failed poll is retried on the next tick, except a job that is
 * gone (its account or project was deleted): `onGone` gets the service's message and polling stops. Returns the stop. */
export function watchJob(job: PrepareJob, onUpdate: (job: PrepareJob) => void, onGone: (message: string) => void,
  intervalMs = JOB_POLL_MS): () => void {
  let stopped = false;
  let timer: number | undefined;
  const tick = async () => {
    try {
      const next = await fetchJob(job.id);
      if (stopped) return;
      onUpdate(next);
      if (!isActive(next)) return;
    } catch (error) {
      if (stopped) return;
      if (error instanceof ApiError && error.status === 404) { onGone(error.message); return; }
    }
    timer = window.setTimeout(() => void tick(), intervalMs);
  };
  timer = window.setTimeout(() => void tick(), intervalMs);
  return () => { stopped = true; window.clearTimeout(timer); };
}

/** A 422 for a piece group no prepare can hold (AE2): the limit and the group's estimate. */
export type SizeRefusal = { message: string; limitMb: number; group: { printedParts: number; cadBuilds: number; memoryMb: number } };
export function sizeRefusal(error: unknown): SizeRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.body || typeof error.body !== 'object') return null;
  const body = error.body as Partial<SizeRefusal>;
  return typeof body.limitMb === 'number' && body.group ? { message: error.message, limitMb: body.limitMb, group: body.group } : null;
}

const STAGES: Record<string, string> = {
  cad: 'Building parts', arrange: 'Arranging plates', slice: 'Slicing plates', guide: 'Writing the assembly guide',
  combine: 'Combining the parts'
};
export const KIND_LABELS: Record<JobKind, string> = {
  layout: 'Preparing plates', coupon: 'Generating calibration sample', grade: 'Preparing grade rig'
};

/** "Slicing plates · 2 of 8": the stage and, within it, the step the service reports ("Plate 2 of 8"). */
export function stageText(stage: string | null, detail: string | null): string {
  if (!stage) return 'Starting';
  const label = STAGES[stage] ?? stage;
  const step = detail && /(\d+ of \d+)$/.exec(detail)?.[1];
  return step ? `${label} · ${step}` : label;
}

/** The running part of a layout prepared in parts: "Part 2 of 3". */
export function currentPart(job: PrepareJob): { label: string; part: JobPart } | null {
  const parts = job.parts;
  const part = parts?.find(item => item.state === 'running') ?? parts?.find(item => item.state === 'queued');
  return parts && part && job.stage !== 'combine' ? { label: `Part ${part.index} of ${parts.length}`, part } : null;
}

/** The headline of an active job. */
export function jobHeadline(job: PrepareJob): string {
  if (job.cancelling) return 'Cancelling…';
  if (job.state === 'interrupted' || job.state === 'queued' && job.interruptions > 0) return 'Restarting after a server restart';
  if (job.state === 'queued') return job.position ? `Waiting — ${job.position} ahead of you` : 'Waiting — you’re next';
  const part = currentPart(job);
  return part ? `${KIND_LABELS[job.kind]} · ${part.label}` : KIND_LABELS[job.kind];
}

/** The stage line under the headline: the current part's stage for a layout in parts. */
export function jobStage(job: PrepareJob): string {
  if (job.state !== 'running') return 'Prepares run one at a time on our server.';
  const part = currentPart(job)?.part;
  return part ? stageText(part.stage, part.detail) : stageText(job.stage, job.detail);
}

export const SYSTEM_FAILURE = 'Something went wrong on our side — this didn’t count toward your daily limit.';
export const TOO_LARGE = 'This layout ran out of memory while preparing: it is too large for one prepare. Split long pieces into shorter ones, or remove some pieces, and try again.';

/** When a daily limit frees up, in the member's time: "at 14:30" today, "tomorrow at 09:05" otherwise. */
export function resetText(resetsAt: string | null, now = new Date()): string {
  if (!resetsAt) return 'later';
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? `at ${time}` : `tomorrow at ${time}`;
}
