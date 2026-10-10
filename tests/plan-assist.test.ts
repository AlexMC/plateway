// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOut } from '../src/account/account';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placeFurniture } from '../src/editor/furniture';
import { PlanAssistPanel, usePlanAssist } from '../src/editor/plan-assist-ui';
import { anthropicClient, CUT_OFF, KEY_REJECTED, MESSAGES_URL, MODEL_UNAVAILABLE, NO_CREDIT, OVERLOADED, RATE_LIMITED, UNREACHABLE } from '../src/plan/anthropic';
import { AssistError, assistPlan, planContext, assistBase, KEY_ITEM, type AssistProgress, type PlanClient, type PlanReply, type PlanRequest } from '../src/plan/assist';
import { PLAN_REFERENCE, SUBMIT_PLAN_TOOL } from '../src/plan/prompt';
import { buildPlan } from '../src/plan/build';
import { parsePlan } from '../src/plan/types';
import SCHEMA from '../src/plan/plan.schema.json';
import LANGUAGE from '../docs/track-plan-language.md?raw';

const EXAMPLES = import.meta.glob<unknown>('../docs/plans/examples/*.json', { eager: true, import: 'default' });
const EXAMPLE_TEXTS = import.meta.glob<string>('../docs/plans/examples/*.json', { eager: true, query: '?raw', import: 'default' });
const oval = () => structuredClone(EXAMPLES['../docs/plans/examples/oval.json']) as { tracks: { steps: unknown[] }[] };
/** An oval with a typo the parser rejects. */
const typo = () => {
  const plan = oval();
  plan.tracks[0].steps[0] = { straight: 128, cuont: 4 };
  return plan;
};

/** A client that answers from a script and records what it was asked. */
function scripted(...replies: unknown[]): PlanClient & { requests: PlanRequest[] } {
  const requests: PlanRequest[] = [];
  const client = async (request: PlanRequest): Promise<PlanReply> => {
    requests.push(structuredClone(request));
    const plan = replies[Math.min(requests.length - 1, replies.length - 1)];
    return { plan, notes: `reply ${requests.length}`, usage: { model: 'fake', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
  return Object.assign(client, { requests });
}

describe('describe-the-track loop', () => {
  it('sends a failing draft back with its report and keeps the repaired plan', async () => {
    const client = scripted(typo(), oval());
    const progress: AssistProgress[] = [];
    const result = await assistPlan({ client, project: createStandardProject('t'), mode: 'fresh', description: 'an oval', onProgress: item => progress.push(item) });
    expect(result).toMatchObject({ ok: true, repairs: 1, notes: 'reply 2', usage: { calls: 2, input: 200, output: 20 } });
    expect(client.requests[0]).not.toHaveProperty('plan');
    expect(client.requests[1]).toMatchObject({ description: 'an oval', plan: typo() });
    expect(client.requests[1].report).toContain('Unknown key "cuont"');
    expect(progress).toContainEqual({ stage: 'repairing', round: 1, of: 3, problem: 'the plan has invalid entries' });
    expect(result.built.project.routes.flatMap(route => route.pieces)).toHaveLength(24);
  });

  it('gives up after three repair rounds and returns the plan with the fewest problems', async () => {
    const twoTypos = typo();
    twoTypos.tracks[0].steps[2] = { straight: 128, cuont: 4 };
    const client = scripted(twoTypos, typo());
    const result = await assistPlan({ client, project: createStandardProject('t'), mode: 'fresh', description: 'an oval' });
    expect(client.requests).toHaveLength(4);
    expect(result).toMatchObject({ ok: false, repairs: 3, notes: 'reply 4' });
    expect(result.attempts).toHaveLength(4);
    expect(result.built.report.errors).toHaveLength(1);
  });

  it('keeps the draft when a repair call fails, saying why repairing stopped', async () => {
    const replies = [typo()];
    const client: PlanClient = async () => {
      const plan = replies.shift();
      if (!plan) throw new Error("The model's plan was cut off; try a simpler request.");
      return { plan, notes: 'draft' };
    };
    const result = await assistPlan({ client, project: createStandardProject('t'), mode: 'fresh', description: 'an oval' });
    expect(result).toMatchObject({ ok: false, repairs: 1, notes: 'draft', plan: typo(), stopped: "The model's plan was cut off; try a simpler request." });
    const controller = new AbortController();
    const cancelling: PlanClient = async request => { if (request.report) controller.abort(); return { plan: typo(), notes: '' }; };
    await expect(assistPlan({ client: cancelling, project: createStandardProject('t'), mode: 'fresh', description: 'an oval', signal: controller.signal })).rejects.toThrow();
  });

  it('refines the current plan with the earlier requests, without a report', async () => {
    const client = scripted(oval());
    const result = await assistPlan({ client, project: createStandardProject('t'), mode: 'fresh', description: 'make it bigger',
      previous: { plan: oval(), history: ['an oval'] } });
    expect(client.requests).toEqual([expect.objectContaining({ description: 'make it bigger', plan: oval(), history: ['an oval'] })]);
    expect(client.requests[0]).not.toHaveProperty('report');
    expect(result.history).toEqual(['an oval', 'make it bigger']);
  });

  it('builds onto the open ends and shelves of the existing layout by the names the context gives', async () => {
    const [withShelf] = placeFurniture(createStandardProject('t'), { x: 1200, y: 1900 }, 0);
    const line = buildPlan({ version: 1, tracks: [{ id: 'a', start: { x: 400, y: 600, heading: 0 }, steps: [{ straight: 128, count: 2 }] }] }, withShelf).project;
    const context = planContext(assistBase(line, 'add'), 'add');
    expect(context.shelves).toEqual([expect.objectContaining({ id: 'K1', quarterTurns: 0 })]);
    expect(context.existingTrack?.openEnds.map(end => [end.ref, end.x, end.heading])).toEqual(expect.arrayContaining([['existing.e1', 400, 180], ['existing.e2', 656, 0]]));
    const grown = buildPlan({ version: 1, tracks: [{ id: 'b', start: { from: 'existing.e2' }, steps: [{ straight: 128 }] },
      { id: 'c', start: { kallax: 'K1', cubby: [1, 1] }, steps: [] }] }, line);
    expect(grown.report.errors).toEqual([]);
    expect(grown.project.routes.flatMap(route => route.pieces)).toHaveLength(3);
    // Starting fresh keeps the shelf but not the track, and a shelf the layout has cannot be added again.
    const fresh = assistBase(line, 'fresh');
    expect([fresh.routes.length, fresh.furniture.length, planContext(fresh, 'fresh').existingTrack]).toEqual([0, 1, null]);
    const twice = buildPlan({ version: 1, furniture: [{ id: 'K1', kallax: { x: 1200, y: 300 } }], tracks: [{ id: 'm', start: { x: 300, y: 300 }, steps: [] }] }, fresh);
    expect(twice.report.errors).toEqual([expect.objectContaining({ path: 'furniture[0].id' })]);
  });
});

type Schema = Record<string, unknown>;
/** Just enough JSON Schema for plan.schema.json; returns the first violation's path. */
function violation(schema: Schema, value: unknown, path = '$'): string | null {
  if (typeof schema.$ref === 'string') return violation((SCHEMA as Schema & { $defs: Record<string, Schema> }).$defs[schema.$ref.split('/').at(-1)!], value, path);
  const types: Record<string, (item: unknown) => boolean> = {
    object: item => typeof item === 'object' && item !== null && !Array.isArray(item), array: Array.isArray,
    string: item => typeof item === 'string', number: item => typeof item === 'number', integer: Number.isInteger, boolean: item => typeof item === 'boolean'
  };
  if (schema.type && !types[schema.type as string](value)) return `${path}: not ${schema.type}`;
  if ('const' in schema && value !== schema.const) return `${path}: not ${JSON.stringify(schema.const)}`;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return `${path}: not in enum`;
  if (schema.oneOf && (schema.oneOf as Schema[]).filter(item => !violation(item, value, path)).length !== 1) return `${path}: not exactly one of oneOf`;
  if (schema.anyOf && (schema.anyOf as Schema[]).every(item => violation(item, value, path))) return `${path}: none of anyOf`;
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path}: below minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path}: above maximum`;
    if (typeof schema.multipleOf === 'number' && !Number.isInteger(value / schema.multipleOf)) return `${path}: not a multiple`;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path}: too short`;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return `${path}: pattern`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path}: too few items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path}: too many items`;
    for (const [index, item] of value.entries()) {
      const problem = schema.items ? violation(schema.items as Schema, item, `${path}[${index}]`) : null;
      if (problem) return problem;
    }
  }
  if (types.object(value)) {
    const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) return `${path}: missing ${key}`;
    for (const [key, item] of Object.entries(object)) {
      const rule = properties[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties as Schema : undefined);
      if (!rule && schema.additionalProperties === false) return `${path}.${key}: not allowed`;
      const problem = rule ? violation(rule, item, `${path}.${key}`) : null;
      if (problem) return problem;
    }
  }
  return null;
}

describe('track plan JSON Schema', () => {
  it('accepts every documented example, as parsePlan does', () => {
    const names = Object.keys(EXAMPLES);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) expect({ name, schema: violation(SCHEMA, EXAMPLES[name]), parse: parsePlan(EXAMPLES[name]).errors }).toEqual({ name, schema: null, parse: [] });
  });

  it('rejects what parsePlan rejects structurally: two actions in a step, unknown keys, a bad reference', () => {
    const bad = (step: unknown) => ({ version: 1, tracks: [{ id: 'm', start: { x: 0, y: 0 }, steps: [step] }] });
    for (const step of [{ straight: 128, buffer: true }, { straight: 128, cuont: 2 }, { close: 'main' }, { curve: 'R40', turn: 'up', angle: 90 }]) {
      expect(violation(SCHEMA, bad(step))).not.toBeNull();
      expect(parsePlan(bad(step)).errors).not.toEqual([]);
    }
  });
});

const KEY = 'sk-ant-test-not-a-key-wxyz';
type Sent = { url: string; init: RequestInit; body: Record<string, any> };
/** A streamed Messages reply: `events` as server-sent events, cut into small chunks so events straddle reads. */
function streamed(events: object[]): Response {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) controller.close();
    else { controller.enqueue(bytes.slice(offset, offset + 37)); offset += 37; }
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const USAGE = { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 };
/** The model thinks, says something, then (unless `stop` says otherwise) calls submit_plan with `input`. */
function modelReply(input: unknown, stop = 'tool_use'): object[] {
  const json = JSON.stringify(input);
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: USAGE } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Two R40 halves ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'and straights.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here it is.' } },
    { type: 'content_block_stop', index: 1 },
    ...(stop === 'tool_use' ? [
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'submit_plan', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: json.slice(0, 20) } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: json.slice(20) } },
      { type: 'content_block_stop', index: 2 }] : []),
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 300 } },
    { type: 'message_stop' }
  ];
}
const failed = (status: number, type: string, message: string) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status });

/** A fake network: Anthropic answers from `replies` in order; Plateway's service answers sign-out. Every request is kept. */
function network(...replies: (() => Response)[]) {
  const sent: Sent[] = [];
  const send = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : {} });
    if (url === MESSAGES_URL) return replies[Math.min(sent.filter(item => item.url === MESSAGES_URL).length - 1, replies.length - 1)]();
    if (url === '/api/auth/logout') return new Response('{}', { status: 200 });
    return new Response('{"detail":"Not Found"}', { status: 404 });
  });
  return { send: send as unknown as typeof fetch, sent };
}

const request: PlanRequest = { description: 'An oval', context: planContext(createStandardProject('t'), 'fresh') };

describe('Anthropic from the browser', () => {
  it('streams one Messages call with the key and the browser-access header, and reads the plan from submit_plan', async () => {
    const { send, sent } = network(() => streamed(modelReply({ notes: 'An owned oval.', plan: oval() })));
    const reply = await anthropicClient({ key: KEY, fetch: send })(request);
    expect(reply).toEqual({ plan: oval(), notes: 'An owned oval.', usage: { model: 'claude-test', ...USAGE, output_tokens: 300 } });
    const [{ url, init, body }] = sent;
    expect([url, init.method]).toEqual(['https://api.anthropic.com/v1/messages', 'POST']);
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' });
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, output_config: { effort: 'medium' }, tool_choice: { type: 'auto' },
      tools: [SUBMIT_PLAN_TOOL] });
    // One cache breakpoint, on the last system block: the tool and the whole system prompt are cached across repairs.
    expect(body.system.map((block: { cache_control?: unknown }) => block.cache_control ?? null)).toEqual([...body.system.slice(1).map(() => null), { type: 'ephemeral' }]);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringMatching(/^## Room and inventory\n\n```json\n\{\n  "mode": "fresh"[\s\S]*## Request\n\nAn oval\n\nAnswer by calling the submit_plan tool/) }]);
  });

  it('turns refine and repair requests into their own sections', async () => {
    const { send, sent } = network(() => streamed(modelReply({ notes: '', plan: oval() })));
    const client = anthropicClient({ key: KEY, fetch: send });
    await client({ ...request, description: 'Make it bigger', plan: oval(), history: ['An oval', 'Add a siding'] });
    await client({ ...request, plan: typo(), report: 'Errors:\n  tracks[0].steps[0]: Unknown key "cuont"' });
    const [refine, repair] = sent.map(item => item.body.messages[0].content as string);
    expect(refine).toContain('## Earlier requests\n\n1. An oval\n2. Add a siding');
    expect(refine).toContain(`## Current plan\n\n\`\`\`json\n${JSON.stringify(oval(), null, 2)}\n\`\`\`\n\n## Change requested\n\nMake it bigger\n\nReturn the complete updated plan.`);
    expect(repair).toContain(`## Plan that failed\n\n\`\`\`json\n${JSON.stringify(typo(), null, 2)}\n\`\`\`\n\n## Builder report\n\n\`\`\`text\nErrors:\n  tracks[0].steps[0]: Unknown key "cuont"\n\`\`\``);
    expect(repair).not.toContain('## Earlier requests');
  });

  it('gives a reply without the tool call one reminder turn, sending the model’s turn back unchanged', async () => {
    const { send, sent } = network(() => streamed(modelReply(null, 'end_turn')), () => streamed(modelReply({ notes: 'Done.', plan: oval() })));
    const reply = await anthropicClient({ key: KEY, fetch: send })(request);
    expect(reply.usage).toMatchObject({ input_tokens: 1800, output_tokens: 600 });
    const [first, second] = sent.map(item => item.body.messages);
    expect(second).toEqual([...first, { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Two R40 halves and straights.', signature: 'sig' }, { type: 'text', text: 'Here it is.' }] },
    { role: 'user', content: 'You did not call submit_plan. Call it now with the complete plan and your notes.' }]);
  });

  it('says what each Anthropic failure means, never showing the key', async () => {
    const cases: [() => Response, string, number][] = [
      [() => failed(401, 'authentication_error', 'invalid x-api-key'), KEY_REJECTED, 401],
      [() => failed(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), NO_CREDIT, 400],
      [() => failed(429, 'rate_limit_error', 'slow down'), RATE_LIMITED, 429],
      [() => failed(404, 'not_found_error', 'model: claude-sonnet-5-5'), MODEL_UNAVAILABLE, 404],
      [() => streamed([...modelReply(null, 'end_turn').slice(0, 3), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), OVERLOADED, 529],
      [() => streamed(modelReply(null, 'max_tokens')), CUT_OFF, 502],
      [() => failed(500, 'api_error', `boom for ${KEY}`), 'Anthropic failed (HTTP 500): boom for [redacted]', 500],
      [() => { throw new TypeError('Failed to fetch'); }, UNREACHABLE, 0]
    ];
    for (const [answer, message, status] of cases) {
      const failure = await anthropicClient({ key: KEY, fetch: network(answer).send })(request).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AssistError);
      expect({ message: (failure as AssistError).message, status: (failure as AssistError).status }).toEqual({ message, status });
    }
  });

  it('ships the plan language, every example and the plan schema exactly as their source files', () => {
    expect(PLAN_REFERENCE[0]).toBe(`# Track plan language reference (docs/track-plan-language.md)\n\n${LANGUAGE}`);
    const names = Object.keys(EXAMPLE_TEXTS).sort();
    expect(PLAN_REFERENCE.slice(1)).toEqual(names.map(name => `# Example plan: ${name.split('/').at(-1)}\n\n\`\`\`json\n${EXAMPLE_TEXTS[name].trim()}\n\`\`\`\n`));
    const { $defs, $schema: _schema, $id: _id, ...plan } = SCHEMA as Record<string, unknown>;
    expect(SUBMIT_PLAN_TOOL.input_schema).toMatchObject({ required: ['notes', 'plan'], additionalProperties: false, $defs, properties: { plan } });
  });
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: { root: Root; host: HTMLElement }[] = [];
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); }
  vi.unstubAllGlobals();
});

/** The Describe track panel, opened, over a standard project. */
async function describePanel() {
  function Harness() {
    const assist = usePlanAssist(createStandardProject('t'));
    useEffect(() => assist.toggle(), []);
    return createElement(PlanAssistPanel, { assist, hasTrack: false, onAccept: () => {} });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  mounted.push({ root, host });
  return host;
}
const buttonNamed = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === text);
const keyForm = (host: HTMLElement) => host.querySelector<HTMLFormElement>('form[aria-label="Your Anthropic key"]');
async function fill(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enterKey(host: HTMLElement, key: string, remember: boolean) {
  const form = keyForm(host)!;
  await fill(form.querySelector('input[type=password]')!, key);
  if (remember) await act(async () => form.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function press(target: HTMLElement | undefined) {
  if (!target) throw new Error('Nothing to press');
  await act(async () => target.click());
}
/** Lets the streamed reply, the build and the renders it causes land. */
async function until(check: () => boolean) {
  for (let round = 0; round < 200 && !check(); round++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
const keyLine = (host: HTMLElement) => host.querySelector('.plan-assist-key span')?.textContent ?? null;

describe('Describe track on the user’s own key', () => {
  it('asks a visitor for a key before anything is sent, then runs on it with no request to Plateway', async () => {
    const { send, sent } = network(() => streamed(modelReply({ notes: 'An owned oval.', plan: oval() })));
    vi.stubGlobal('fetch', send);
    const host = await describePanel();
    expect(keyForm(host)).not.toBeNull();
    expect(host.textContent).toContain('about $0.19');
    await fill(host.querySelector('textarea')!, 'An oval');
    expect(buttonNamed(host, 'Generate')!.disabled).toBe(true);
    await press(buttonNamed(host, 'Generate'));
    expect(sent).toEqual([]);

    await enterKey(host, KEY, false);
    expect(keyForm(host)).toBeNull();
    expect(keyLine(host)).toBe('Using your key ending …wxyz');
    await press(buttonNamed(host, 'Generate'));
    await until(() => host.textContent!.includes('An owned oval.'));
    expect(sent.map(item => [item.url, (item.init.headers as Record<string, string>)['x-api-key']])).toEqual([[MESSAGES_URL, KEY]]);
  });

  it('keeps a key for the session only, unless remembered; Forget key and signing out remove a remembered key', async () => {
    vi.stubGlobal('fetch', network().send);
    let host = await describePanel();
    await enterKey(host, KEY, false);
    expect([sessionStorage.getItem(KEY_ITEM), localStorage.getItem(KEY_ITEM)]).toEqual([KEY, null]);
    sessionStorage.clear();
    host = await describePanel();
    expect(keyForm(host)).not.toBeNull();

    await enterKey(host, KEY, true);
    expect([sessionStorage.getItem(KEY_ITEM), localStorage.getItem(KEY_ITEM)]).toEqual([null, KEY]);
    sessionStorage.clear();
    host = await describePanel();
    expect(keyLine(host)).toBe('Using your key ending …wxyz');
    await press(buttonNamed(host, 'Forget key'));
    expect(localStorage.getItem(KEY_ITEM)).toBeNull();
    expect(keyForm(host)).not.toBeNull();

    await enterKey(host, 'sk-ant-other-key-1234', true);
    expect(keyLine(host)).toBe('Using your key ending …1234');
    await act(() => signOut());
    expect(localStorage.getItem(KEY_ITEM)).toBeNull();
    expect(keyForm(host)).not.toBeNull();
  });

  it('forgets a key Anthropic rejects and asks for one again, saying why', async () => {
    const { send } = network(() => failed(401, 'authentication_error', 'invalid x-api-key'));
    vi.stubGlobal('fetch', send);
    const host = await describePanel();
    await enterKey(host, KEY, true);
    await fill(host.querySelector('textarea')!, 'An oval');
    await press(buttonNamed(host, 'Generate'));
    await until(() => keyForm(host) !== null);
    expect([sessionStorage.getItem(KEY_ITEM), localStorage.getItem(KEY_ITEM)]).toEqual([null, null]);
    expect(host.querySelector('.plan-assist-error')?.textContent).toBe(KEY_REJECTED);
  });
});
