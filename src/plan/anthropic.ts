import { AssistError, type PlanClient, type PlanReply, type PlanRequest, type PlanUsage } from './assist';
import { PLAN_REFERENCE, SUBMIT_PLAN_TOOL } from './prompt';

/**
 * Describe track's model call, made from the browser straight to Anthropic on the user's own key (KTD4): one streamed
 * Messages request that offers the `submit_plan` tool, read back as `{plan, notes, usage}`. Plateway's server never sees
 * the key or the request. scripts/plan-eval.ts runs the same client from Node with a key from its environment.
 */

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
// At the API default ("high") Sonnet 5.5 thought for 19k tokens and ~150 s per plan and a repair overran 32k tokens.
export const DEFAULT_EFFORT: Effort = 'medium';
// Adaptive thinking counts against max_tokens.
const MAX_TOKENS = 32000;
const UPSTREAM_MESSAGE_LIMIT = 300;

export const KEY_REJECTED = 'This key was rejected.';
export const NO_CREDIT = 'Your Anthropic account is out of credit.';
export const RATE_LIMITED = 'Anthropic is rate-limiting your key; try again in a minute.';
export const MODEL_UNAVAILABLE = 'Your account can’t use this model.';
export const OVERLOADED = 'Anthropic is overloaded; try again in a moment.';
export const UNREACHABLE = 'Could not reach Anthropic; check your connection.';
export const CUT_OFF = 'The model’s plan was cut off; try a simpler request.';
export const NO_PLAN = 'The model did not return a plan; try again.';
export const DECLINED = 'The model declined this request; describe the layout differently.';
export const UNUSABLE_PLAN = 'The model returned an unusable plan; try again.';
const NUDGE = 'You did not call submit_plan. Call it now with the complete plan and your notes.';

const ROLE = `# Role

You design train layouts for standard brick track in the Plateway app. The user describes the layout they want;
you answer by calling the \`submit_plan\` tool exactly once with a track plan v1 (the language is defined below) and
short notes for the user. The app builds your plan with its own editor operations, checks it, and when anything fails
it sends you the plan back with the builder's report so you can fix it.

## Rules

- Follow the track plan language below exactly. Unknown keys, families, ports and options are errors: use only the
  step kinds, families and params documented here, and never invent a family, port or option.
- Use the room and inventory in the user's message: the room size (every piece, including its 32 mm half-width and
  connectors, must stay inside the room), the pieces the user owns, the train, the track system and the printer.
- \`shelves\` are already in the room: start tracks at their cubbies by those ids (\`{"kallax": "K1", ...}\`) and never add
  them to \`furniture\` again; add a shelf only when the user asks for a new one. Keep track clear of every shelf except
  through a cubby opening.
- \`mode\` "fresh": the user's current track is removed and your plan is the whole layout. \`mode\` "add": your plan is
  built onto \`existingTrack\`; join it through its open ends (\`{"from": "existing.e1"}\`, \`{"close": "existing.e2"}\`)
  where the request connects to it, and keep new track clear of the area it covers.
- Prefer the pieces the user owns (standard 128 mm straights, R40 curves, turnouts, crossings) and design around their
  counts; use printed pieces only where the request needs shapes the user does not own or has run out of.
- Do the geometry before you write: turns in a loop add up to 360°, straights on opposite sides balance, and the
  extents fit the room (a 180° R40 turn reaches 352 mm beyond where it starts).
- Finish every loop, and every track that rejoins other track, with \`close\`; end a dead end with \`buffer\` unless the
  user wants it open. Name junctions with \`as\` and start branch tracks \`from\` their ports.
- When the request is impossible or cannot fit the room or inventory, do not fake it: submit the closest sensible plan
  and say plainly in the notes what you changed and why.
- When repairing a plan, read every error in the builder's report, fix all of them, and keep the parts that already
  built.
- \`notes\` are 1-4 sentences to the user in plain language: what you built and any compromise. No JSON, no step
  paths, no jargon from this brief, and nothing about checking or building the plan: the app reports that itself.
- In \`notes\` and any other text the user sees (plan names and descriptions too), say "brick track" and "brick trains"
  and never use the word LEGO, even if the user does.
`;

const dump = (value: unknown) => JSON.stringify(value, null, 2);

/** The single user turn: context, earlier requests, then the draft, refine or repair section. */
export function userMessage({ description, context, plan, report, history = [] }: PlanRequest): string {
  const parts = ['## Room and inventory', `\`\`\`json\n${dump(context)}\n\`\`\``];
  if (history.length) parts.push('## Earlier requests', history.map((text, index) => `${index + 1}. ${text}`).join('\n'));
  if (plan === undefined) parts.push('## Request', description);
  else if (report === undefined) parts.push('## Current plan', `\`\`\`json\n${dump(plan)}\n\`\`\``, '## Change requested', description, 'Return the complete updated plan.');
  else parts.push('## Request', description, '## Plan that failed', `\`\`\`json\n${dump(plan)}\n\`\`\``, '## Builder report', `\`\`\`text\n${report}\n\`\`\``,
    'The plan above failed to build cleanly. Return a corrected complete plan: fix every error in the report and keep what already works.');
  parts.push('Answer by calling the submit_plan tool with the complete plan and your notes.');
  return parts.join('\n\n');
}

export interface AnthropicOptions {
  key: string;
  model?: string;
  effort?: Effort;
  /** Tests answer here; defaults to the global fetch. */
  fetch?: typeof fetch;
}

type Block = { type: string; [field: string]: unknown };
interface Message { model: string; stopReason: string | null; content: Block[]; usage: Record<string, number> }

/** An Anthropic error as the sentence to show; the status stays so a 401 can clear the key. */
function failure(status: number, error: unknown, key: string): AssistError {
  const { type = '', message = '' } = (error && typeof error === 'object' ? error : {}) as { type?: string; message?: string };
  if (status === 401 || type === 'authentication_error') return new AssistError(KEY_REJECTED, 401);
  if (type === 'billing_error' || /credit balance/i.test(message)) return new AssistError(NO_CREDIT, status);
  if (status === 429 || type === 'rate_limit_error') return new AssistError(RATE_LIMITED, 429);
  if (status === 404 || type === 'not_found_error') return new AssistError(MODEL_UNAVAILABLE, 404);
  if (status === 503 || status === 529 || type === 'overloaded_error') return new AssistError(OVERLOADED, status || 529);
  // Upstream text is shown, so the key goes first (never half a key), then the length.
  const detail = (message || type || 'no details').split(key).join('[redacted]').slice(0, UPSTREAM_MESSAGE_LIMIT);
  return new AssistError(`Anthropic failed${status ? ` (HTTP ${status})` : ''}: ${detail}`, status || 502);
}

/** Server-sent events from a streamed response: each event's parsed `data`. */
async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type?: string; [field: string]: unknown }> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer.slice(0, end).split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      buffer = buffer.slice(end + 2);
      if (data) yield JSON.parse(data);
    }
    if (done) return;
  }
}

/** One streamed Messages call, assembled into the message it streams (content blocks as the API returns them). */
async function streamMessage(body: object, key: string, send: typeof fetch, signal?: AbortSignal): Promise<Message> {
  let response: Response;
  try {
    response = await send(MESSAGES_URL, { method: 'POST', body: JSON.stringify(body), signal, headers: {
      'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AssistError(UNREACHABLE, 0);
  }
  if (!response.ok || !response.body) {
    let error: unknown;
    try { error = (await response.json() as { error?: unknown }).error; } catch { /* no JSON body */ }
    throw failure(response.status, error, key);
  }
  const message: Message = { model: '', stopReason: null, content: [], usage: {} };
  const inputs: string[] = [];
  const addUsage = (usage: unknown) => {
    for (const [name, count] of Object.entries(usage ?? {})) if (typeof count === 'number') message.usage[name] = count;
  };
  let stopped = false;
  for await (const event of serverEvents(response.body)) {
    const index = event.index as number;
    switch (event.type) {
      case 'message_start': {
        const start = event.message as { model?: string; usage?: unknown };
        message.model = start.model ?? '';
        addUsage(start.usage);
        break;
      }
      case 'content_block_start':
        message.content[index] = { ...event.content_block as Block };
        if (message.content[index].type === 'tool_use') inputs[index] = '';
        break;
      case 'content_block_delta': {
        const block = message.content[index], delta = event.delta as Record<string, string>;
        if (delta.type === 'text_delta') block.text = `${block.text ?? ''}${delta.text}`;
        else if (delta.type === 'thinking_delta') block.thinking = `${block.thinking ?? ''}${delta.thinking}`;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'input_json_delta') inputs[index] += delta.partial_json;
        break;
      }
      case 'content_block_stop':
        if (inputs[index] !== undefined) {
          try { message.content[index].input = inputs[index] ? JSON.parse(inputs[index]) : {}; } catch { message.content[index].input = null; }
        }
        break;
      case 'message_delta':
        message.stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? message.stopReason;
        addUsage(event.usage);
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        const error = event.error as { type?: string } | undefined;
        throw failure(error?.type === 'overloaded_error' ? 529 : error?.type === 'rate_limit_error' ? 429 : 0, error, key);
      }
    }
  }
  if (!stopped) throw new AssistError('Anthropic’s answer broke off; try again.', 502);
  return message;
}

/** Role brief, language reference, then every example. The last block is the prompt-cache breakpoint: the tool and the
 * whole system prompt are cached across repair rounds. */
export const SYSTEM = [ROLE, ...PLAN_REFERENCE].map((text, index, all) => ({ type: 'text', text,
  ...(index === all.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));

/**
 * The model as a PlanClient. Forced tool use is not available (Sonnet 5.5 rejects it), so a reply that ends without
 * calling submit_plan gets one follow-up turn: the reply kept unchanged, thinking blocks included, then a reminder.
 */
export function anthropicClient({ key, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, fetch: send = (input, init) => fetch(input, init) }: AnthropicOptions): PlanClient {
  return async (request: PlanRequest, signal?: AbortSignal): Promise<PlanReply> => {
    let messages: { role: 'user' | 'assistant'; content: string | Block[] }[] = [{ role: 'user', content: userMessage(request) }];
    const usage: PlanUsage = { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (let attempt = 0; ; attempt++) {
      const reply = await streamMessage({ model, max_tokens: MAX_TOKENS, output_config: { effort }, stream: true, system: SYSTEM,
        tools: [SUBMIT_PLAN_TOOL], tool_choice: { type: 'auto' }, messages }, key, send, signal);
      usage.model = reply.model || model;
      for (const name of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) usage[name] += reply.usage[name] ?? 0;
      if (reply.stopReason === 'max_tokens') throw new AssistError(CUT_OFF, 502);
      if (reply.stopReason === 'refusal') throw new AssistError(DECLINED, 502);
      const call = reply.content.find(block => block?.type === 'tool_use' && block.name === 'submit_plan');
      if (call) {
        const input = call.input as { plan?: unknown; notes?: unknown } | null;
        if (!input || typeof input.plan !== 'object' || input.plan === null || Array.isArray(input.plan) || typeof input.notes !== 'string') throw new AssistError(UNUSABLE_PLAN, 502);
        return { plan: input.plan, notes: input.notes, usage };
      }
      if (attempt || reply.stopReason !== 'end_turn' || !reply.content.length) throw new AssistError(NO_PLAN, 502);
      messages = [...messages, { role: 'assistant', content: reply.content }, { role: 'user', content: NUDGE }];
    }
  };
}
