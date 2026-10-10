/**
 * ANTHROPIC_API_KEY=… npm run plan-eval -- [--cases docs/plans/eval/cases.json] [--only id,id] [--concurrency 3]
 * Runs every describe-the-track case through Build's own loop (src/plan/assist.ts) and the browser's Anthropic client
 * (src/plan/anthropic.ts) on the key in the environment, scores each case's checks (src/plan/eval.ts), prints a table
 * and writes /tmp/plan-eval/<timestamp>.json. ANTHROPIC_MODEL and ANTHROPIC_EFFORT override the app's model and effort.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { anthropicClient, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort } from '../src/plan/anthropic';
import { assistPlan } from '../src/plan/assist';
import { evalOutcome, evalProject, type EvalCases, type EvalOutcome } from '../src/plan/eval';

const USAGE = 'Usage: ANTHROPIC_API_KEY=… npm run plan-eval -- [--cases file.json] [--only id,id] [--concurrency 3]';

async function main(args: string[]): Promise<number> {
  const options: Record<string, string> = { cases: 'docs/plans/eval/cases.json', concurrency: '3', only: '' };
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (args[index] === '--help' || args[index] === '-h') { console.log(USAGE); return 0; }
    if (!args[index].startsWith('--') || !(key in options) || args[index + 1] === undefined) { console.error(`Unexpected argument ${args[index]}.\n${USAGE}`); return 2; }
    options[key] = args[++index];
  }
  const concurrency = Math.max(1, Number(options.concurrency) || 3);
  const suite = JSON.parse(readFileSync(options.cases, 'utf8')) as EvalCases;
  const only = options.only ? new Set(options.only.split(',')) : null;
  const cases = suite.cases.filter(test => !only || only.has(test.id));
  if (!cases.length) { console.error('No cases to run.'); return 2; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error(`Set ANTHROPIC_API_KEY.\n${USAGE}`); return 2; }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, effort = (process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort)) { console.error(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')}.`); return 2; }
  const client = anthropicClient({ key, model, effort });

  const outcomes: EvalOutcome[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++, test = cases[index], started = performance.now();
      const seconds = () => Math.round((performance.now() - started) / 100) / 10;
      try {
        const result = await assistPlan({ client, project: evalProject(test.id, suite.setup, test.setup), mode: 'fresh', description: test.description });
        outcomes[index] = evalOutcome(test, result, seconds());
      } catch (error) {
        outcomes[index] = { id: test.id, description: test.description, seconds: seconds(), ok: false, repairs: 0, tokens: 0,
          checks: Object.keys(test.checks).map(check => ({ check, pass: false, expected: '', actual: 'not run' })), metrics: null,
          notes: '', plan: null, report: null, reportText: '', attempts: [], usage: null, error: error instanceof Error ? error.message : String(error) };
      }
      const outcome = outcomes[index];
      console.error(`  ${outcome.id}: ${outcome.error ?? `${outcome.checks.filter(check => check.pass).length}/${outcome.checks.length} checks`} (${outcome.seconds} s)`);
    }
  };
  console.error(`Running ${cases.length} cases on ${model} at ${effort} effort (concurrency ${concurrency})…`);
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const rows = outcomes.map(outcome => [outcome.id, outcome.error ? 'ERROR' : outcome.ok ? 'ok' : 'no', String(outcome.repairs),
    `${outcome.checks.filter(check => check.pass).length}/${outcome.checks.length}`, String(outcome.tokens), String(outcome.seconds),
    outcome.error ?? [...outcome.checks.filter(check => !check.pass).map(check => `${check.check} ${check.actual} (want ${check.expected})`),
      ...(outcome.stopped ? [`repair stopped: ${outcome.stopped}`] : [])].join('; ')]);
  const header = ['case', 'ok', 'rounds', 'checks', 'tokens', 'seconds', 'failed checks'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const line = (row: string[]) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column])).join('  ');
  console.log([line(header), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)].join('\n'));
  const passed = outcomes.reduce((sum, outcome) => sum + outcome.checks.filter(check => check.pass).length, 0);
  const total = outcomes.reduce((sum, outcome) => sum + outcome.checks.length, 0);
  const tokens = outcomes.reduce((sum, outcome) => sum + outcome.tokens, 0);
  console.log(`\n${outcomes.filter(outcome => outcome.ok).length}/${outcomes.length} plans clean · ${passed}/${total} checks · ` +
    `${outcomes.filter(outcome => outcome.checks.every(check => check.pass)).length}/${outcomes.length} cases fully passed · ${tokens.toLocaleString('en')} tokens`);
  mkdirSync('/tmp/plan-eval', { recursive: true });
  const file = `/tmp/plan-eval/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ cases: options.cases, model: outcomes.find(outcome => outcome.usage?.model)?.usage?.model ?? model, effort, outcomes }, null, 2));
  console.log(`Wrote ${file}.`);
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
