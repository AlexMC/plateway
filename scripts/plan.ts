/**
 * npm run plan -- <plan.json> [--out project.json] [--save]
 * Builds a track plan, prints the report, optionally writes the project file and/or saves it to the running
 * service (http://localhost:8766) the way the app's Save does, so it appears under Open.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { serializeProject } from '../src/domain/project';
import { buildPlan, describeReport } from '../src/plan/build';

const SERVICE = 'http://localhost:8766';
const USAGE = 'Usage: npm run plan -- <plan.json> [--out project.json] [--save]';

async function main(args: string[]): Promise<number> {
  let file: string | undefined, out: string | undefined, save = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out') out = args[++index];
    else if (arg === '--save') save = true;
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    else if (arg.startsWith('-') || file) { console.error(`Unexpected argument ${arg}.\n${USAGE}`); return 2; }
    else file = arg;
  }
  if (!file || (args.includes('--out') && !out)) { console.error(USAGE); return 2; }
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`);
    return 2;
  }
  const { project, report } = buildPlan(plan);
  console.log(describeReport(report));
  if (out) {
    writeFileSync(out, serializeProject(project));
    console.log(`Wrote ${out}.`);
  }
  if (save) {
    // Exactly as the app's Save: the local member's session (cookie and token), then POST with it from the app's origin.
    const session = await fetch(`${SERVICE}/api/session`, { headers: { Origin: SERVICE } });
    if (!session.ok) throw new Error(`The service refused the session (${session.status}).`);
    const { token } = await session.json() as { token: string };
    const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const response = await fetch(`${SERVICE}/api/projects`, { method: 'POST', body: serializeProject(project),
      headers: { 'Content-Type': 'application/json', 'X-Workshop-Session': token, Origin: SERVICE, Cookie: cookie } });
    if (!response.ok) throw new Error(`Could not save the project (${response.status}): ${await response.text()}`);
    const saved = await response.json() as { id: string; revision: string };
    console.log(`Saved "${project.name}" (${saved.id}, revision ${saved.revision}); open it from Open in the app.`);
  }
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
