// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkshopProject } from '../src/domain/project';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placePiece, setPieceSource } from '../src/editor/operations';
import { couponFitStatus, recordCouponFit } from '../src/export/evidence-view';
import { couponTrial, printSelection } from '../src/export/actions';
import { ExportPanel, currentLayoutPackages } from '../src/export/panel';
import { matchingCoupon, partName, type ArtifactReceipt } from '../src/export/receipt';
import { fitProject } from '../src/fitting/fit';
import type { Account } from '../src/account/account';
import type { JobPart, PrepareJob } from '../src/export/jobs';
import { button, service, settle, workspaceHooks, type Call, type Reply } from './workspace-harness';

const MEMBER: Account = { status: 'member', member: { id: 'u1', email: 'ada@example.com', displayName: 'Ada', verified: true, purgeAt: null } };

function receipt(project: WorkshopProject, id: string, parts: Array<{ id: string; family: string; parameters: Record<string, number> }>,
  manifest?: string): ArtifactReceipt {
  return {
    id, cadSourceCurrent: true, layoutRevision: project.layoutRevision, partRevision: project.revision, printer: printSelection(project),
    parts: parts.map(part => ({ instanceId: part.id, family: part.family, parameters: part.parameters,
      digest: `${id}-digest`, partRevision: project.revision, layoutRevision: project.layoutRevision,
      assemblyPose: null, requestDigest: 'synthetic', mesh: 'part.stl', source: 'part.py',
      plate: 1, plateLabel: part.id })),
    plates: [{ plate: 1, project: `${id}.3mf`, gcode: `${id}.gcode`, objects: parts.map(part => ({ instanceId: part.id, label: part.id })),
      gcodeSha256: 'synthetic', slice: {} }], assemblyGuide: 'guide.md', manifest
  };
}

function printedLayout(): [WorkshopProject, ArtifactReceipt] {
  const [project] = placePiece(createStandardProject('Printed straight'), 'printed_straight', { x: 500, y: 500 });
  return [project, receipt(project, `${project.id}-${project.layoutRevision}`,
    [{ id: 'straight', family: 'printed_straight', parameters: {} }], 'manifest.json')];
}

const render = (project: WorkshopProject, receipts: ArtifactReceipt[] = []) => renderToStaticMarkup(createElement(ExportPanel, {
  project, fit: fitProject(project), account: MEMBER, onNeedAccount: () => {}, saveRevision: async () => ({ id: project.id, revision: crypto.randomUUID() }),
  onReceipt: () => {}, onChange: () => {}, onEditMeasurement: () => {}, receipts }));

describe('current plate package', () => {
  it('stays current through non-layout changes and is replaced after a layout edit', () => {
    const [project, layout] = printedLayout();
    const coupon = receipt(project, 'coupon', couponTrial(project).parts);
    const reported = recordCouponFit(project, coupon, true, 'Clicked onto my track', true);
    expect(reported.revision).not.toBe(project.revision);
    expect(currentLayoutPackages(reported, [layout])).toEqual([layout]);
    const edited = placePiece(reported, 'printed_straight', { x: 1200, y: 500 })[0];
    expect(currentLayoutPackages(edited, [layout])).toEqual([]);
    expect(currentLayoutPackages(project, [{ ...layout, cadSourceCurrent: false }, { ...layout, id: 'trial', manifest: undefined }])).toEqual([]);
  });

  it('keeps plates downloadable after a calibration result is recorded', () => {
    const [project, layout] = printedLayout();
    const coupon = receipt(project, 'coupon', couponTrial(project).parts);
    const reported = recordCouponFit(project, coupon, false, 'Too tight', true);
    const shown = render(reported, [layout, coupon]);
    expect(shown).toContain(`/api/packages/${layout.id}/plates.zip`);
    expect(shown).not.toContain('id="prepare-plates"');
  });

  it('offers Prepare only for printed pieces without a current package', () => {
    const [project, layout] = printedLayout();
    expect(render(project)).toContain('id="prepare-plates"');
    expect(render(project, [layout])).not.toContain('id="prepare-plates"');
    expect(render(createStandardProject('Empty'))).not.toContain('id="prepare-plates"');
    const owned = createStandardProject('Owned only');
    owned.inventory.brick_straight_nominal = 1;
    expect(render(placePiece(owned, 'brick_straight_nominal', { x: 500, y: 500 })[0])).not.toContain('id="prepare-plates"');
  });
});

describe('plate cards and files', () => {
  it('shows the slicer thumbnail when present, otherwise a parts list', () => {
    const [project, layout] = printedLayout();
    expect(render(project, [layout])).toContain('class="export-plate-parts"');
    layout.plates[0].thumbnail = 'plate-01/thumbnail.png';
    const shown = render(project, [layout]);
    expect(shown).toContain(`src="/api/packages/${layout.id}/files/plate-01/thumbnail.png"`);
    expect(shown).not.toContain('class="export-plate-parts"');
  });

  it('lists each part on its plate by the code the guide and the slicer use', () => {
    const [project, layout] = printedLayout();
    layout.plates[0].thumbnail = 'plate-01/thumbnail.png';
    layout.parts[0] = { ...layout.parts[0], code: '2C', piece: '2', pieceName: 'Climb +40 mm', name: 'Climb +40 mm · part 3 of 10' };
    const list = render(project, [layout]).split('aria-label="Parts on plate 1">')[1].split('</ul>')[0];
    expect(list.replace(/<[^>]+>/g, '')).toBe('2C Climb +40 mm · part 3 of 10');
  });

  it('links STEP only for parts that have one', () => {
    const [project, layout] = printedLayout();
    expect(render(project, [layout])).not.toContain('>STEP<');
    layout.parts[0].step = 'straight.step';
    expect(render(project, [layout])).toContain(`/api/packages/${layout.id}/files/straight.step`);
  });

  it('always offers the printable PDF guide, even for a package prepared before it existed, and the markdown beside it', () => {
    const [project, layout] = printedLayout();  // an old package: no PDF of its own, no plain 3MFs, no part codes
    const shown = render(project, [layout]);
    const downloads = shown.split('aria-label="Downloads"')[1].split('</div>')[0];
    expect(downloads).toMatch(new RegExp(`href="/api/packages/${layout.id}/assembly-guide.pdf"[^>]*>Assembly guide \\(PDF\\)</a>`));
    expect(downloads).toContain(`href="/api/packages/${layout.id}/files/guide.md" download="">Assembly guide (Markdown)</a>`);
    expect(downloads.indexOf('(PDF)')).toBeLessThan(downloads.indexOf('(Markdown)'));
    const files = shown.split('class="export-receipt"')[1].split('</article>')[0];
    expect(files).toContain('>Assembly guide (PDF)</a>');
  });

  it('offers one download for the current calibration sample and none for an older one', () => {
    const project = createStandardProject('Calibration');
    const fresh = receipt(project, 'sample-current', couponTrial(project).parts);
    const old = { ...fresh, id: 'sample-old', cadSourceCurrent: false };
    expect(matchingCoupon(project, old)).toBe(false);
    const card = render(project, [old, fresh]).split('aria-label="Connector calibration"')[1].split('</section>')[0];
    expect(card.split('/api/packages/sample-current/files/sample-current.3mf')).toHaveLength(2);
    expect(card).not.toContain('/api/packages/sample-old/');
  });

  it('binds a calibration report to the printed sample file', () => {
    const project = createStandardProject('Sample');
    const coupon = receipt(project, 'printed', couponTrial(project).parts);
    expect(couponFitStatus(project, [coupon])).toBe('pending');
    expect(() => recordCouponFit(project, coupon, true, '', false)).toThrow();
    const observed = recordCouponFit(project, coupon, true, 'Clicked together', true);
    expect(couponFitStatus(observed, [coupon])).toBe('passed');
    expect(couponFitStatus(observed, [{ ...coupon, parts: coupon.parts.map(part => ({ ...part, digest: 'another-print' })) }])).toBe('pending');
    expect(couponFitStatus(recordCouponFit(observed, coupon, false, 'Loose after reprint', true), [coupon])).toBe('failed');
  });

  it('numbers multipart pieces only where an assembly has several parts of a kind', () => {
    const component = (role: string) => ({ instanceId: `switch:${role}`, family: 'track_component', parameters: {},
      assemblyInstanceId: 'switch', assemblyFamily: 'printed_switch_left', componentRole: role,
      partRevision: 'r', layoutRevision: 'l', assemblyPose: null, digest: 'd', requestDigest: 'q', mesh: 'm.stl', source: 's.py',
      plate: 1, plateLabel: role });
    const parts = ['keyed-base-02-1', 'keyed-base-01-1', 'selector-1', 'selector-lock-1', 'keeper-1-1', 'keeper-1-2'].map(component);
    expect(parts.map(part => partName(part, parts))).toEqual([
      'Left turnout · base 2 of 2', 'Left turnout · base 1 of 2', 'Left turnout · selector', 'Left turnout · lock pin',
      'Left turnout · keeper 1 of 2', 'Left turnout · keeper 2 of 2']);
  });

  it('shows the process of each print style in use and lets a mixed layout pick the sample layer height', () => {
    const [project, layout] = printedLayout();
    const card = (shown: string) => shown.split('class="export-printer"')[1].split('</div>')[0];
    const sample = (shown: string) => shown.split('aria-label="Connector calibration"')[1].split('</section>')[0];
    const detailed = render(project);
    expect(card(detailed)).toContain('0.4 mm nozzle · 0.20mm Standard @BBL X1C');
    expect(detailed).not.toContain('Fast print');
    expect(sample(detailed)).not.toContain('Test at');
    const second = placePiece(project, 'printed_straight', { x: 1500, y: 1500 })[0];
    const both = setPieceSource(second, [second.routes.at(-1)!.pieces[0].id], 'fast');
    const shown = render(both, [{ ...layout, layoutRevision: both.layoutRevision,
      plates: layout.plates.map(plate => ({ ...plate, process: '0.28mm Extra Draft @BBL X1C' })) }]);
    expect(card(shown)).toContain('<p>Detailed: 0.20mm Standard @BBL X1C</p><p>Fast: 0.28mm Extra Draft @BBL X1C</p>');
    expect(sample(shown)).toMatch(/Test at.*aria-pressed="true"[^>]*>0\.20 mm.*aria-pressed="false"[^>]*>0\.28 mm/);
    expect(shown).toMatch(/Plate 1 · 1 part.*0\.28 mm layers/);
    const onlyFast = setPieceSource(project, [project.routes[0].pieces[0].id], 'fast');
    expect(card(render(onlyFast))).toContain('<p>0.4 mm nozzle</p><p>Fast: 0.28mm Extra Draft @BBL X1C</p>');
    expect(card(render(onlyFast))).not.toContain('Detailed');
  });
});

describe('ready to print and slicer-neutral files', () => {
  const panel = (project: WorkshopProject, receipts: ArtifactReceipt[], driven: boolean) => renderToStaticMarkup(createElement(ExportPanel, {
    project, fit: fitProject(project), account: MEMBER, onNeedAccount: () => {}, saveRevision: async () => ({ id: project.id, revision: crypto.randomUUID() }), onReceipt: () => {}, onChange: () => {},
    onEditMeasurement: () => {}, onEditTrack: () => {}, onTestDrive: () => {}, driven, receipts }));
  const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('orients a user arriving from Build: printer, style, pieces, plates, and Test drive recommended until driven', () => {
    const [project] = printedLayout();
    const ready = text(panel(project, [], false).split('aria-labelledby="export-ready-title"')[1].split('</section>')[0]);
    expect(ready).toContain('X1 Carbon · 0.4 mm nozzle · Bambu PLA Basic');
    expect(ready).toContain('Detailed');
    expect(ready).toContain('1 printed piece');
    expect(ready).toContain('Not prepared yet');
    expect(ready).toContain('Test drive first');
    expect(text(panel(project, [], true))).not.toContain('Test drive first');
  });

  it('offers a plain 3MF per plate for any slicer and labels the Bambu files as Bambu-only', () => {
    const [project, layout] = printedLayout();
    layout.plates[0] = { ...layout.plates[0], model: 'plate-01/plate-01.3mf' };
    layout.parts[0] = { ...layout.parts[0], code: '1', piece: '1', pieceName: 'Straight', name: 'Straight' };
    const shown = panel(project, [layout], true);
    expect(text(shown)).toContain('1 prepared · 1 part');
    expect(shown).toContain(`href="/api/packages/${layout.id}/files/plate-01/plate-01.3mf" download="plate-01.3mf"`);
    expect(shown).toContain(`href="/api/packages/${layout.id}/files/${layout.id}.3mf" download="plate-01-bambu-project.3mf"`);
    expect(text(shown)).toContain('Other slicers: turn on supports for the connector ends (see guide)');
    expect(text(shown)).toContain('For Bambu printers: supports painted only where needed');
    expect(shown).not.toContain('Prepare again');
  });

  it('never tells the user to open the plates in Bambu Studio; Bambu is named only on its own files', () => {
    const [project, layout] = printedLayout();
    layout.plates[0] = { ...layout.plates[0], model: 'plate-01/plate-01.3mf' };
    for (const shown of [panel(project, [], false), panel(project, [layout], true)]) {
      expect(shown).not.toMatch(/\bopen\w*\b[^.<]*\bin Bambu Studio\b/i);
      const words = text(shown);
      expect(words).toMatch(/your slicer/);
      // Every Bambu mention is a Bambu-specific item: the printer's material/profile names, the Bambu project or its row.
      const mentions = [...words.matchAll(/[^.·]*Bambu[^.·]*/g)].map(match => match[0].trim());
      for (const mention of mentions) expect(mention).toMatch(/Bambu PLA|@BBL|Bambu project|Bambu Studio project|Bambu printers|OrcaSlicer, PrusaSlicer, Cura or Bambu Studio/);
    }
  });

  it('asks, beside the downloads, to prepare again when the current package predates plain 3MFs or part codes', () => {
    const [project, layout] = printedLayout();
    // Between the downloads and the file kinds.
    const heading = (shown: string) => text(shown.split('aria-label="Downloads"')[1].split('class="export-kinds"')[0]);
    const old = panel(project, [layout], true);
    expect(heading(old)).toContain('Prepared with an older version: prepare again for plain 3MF plates and part codes. Prepare again');
    expect(old).not.toContain('download="plate-01.3mf"');
    layout.plates[0] = { ...layout.plates[0], model: 'plate-01/plate-01.3mf' };
    expect(heading(panel(project, [layout], true))).toContain('Prepare again');  // plain 3MFs but no codes yet
    layout.parts[0] = { ...layout.parts[0], code: '1', piece: '1', pieceName: 'Straight', name: 'Straight' };
    expect(panel(project, [layout], true)).not.toContain('Prepare again');
  });
});

describe('shipped guides', () => {
  const guides = import.meta.glob('../docs/assembly/*.md', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

  it('tell the user to open plates in their slicer, never in Bambu Studio alone', () => {
    expect(Object.keys(guides)).toEqual(expect.arrayContaining(['../docs/assembly/print-and-build.md', '../docs/assembly/fit-coupon.md']));
    for (const [file, guide] of Object.entries(guides)) {
      const sentences = guide.split(/(?<=[.!?])\s+/);
      const offending = sentences.filter(sentence => /\bopen\w*\b[^.]*\bin Bambu Studio\b/i.test(sentence) && !/Bambu printer|Bambu (Studio )?project/.test(sentence));
      expect(offending, file).toEqual([]);
    }
    expect(guides['../docs/assembly/print-and-build.md']).toMatch(/Open the plates in your slicer/);
  });
});

describe('queued prepares', { timeout: 30_000 }, () => {
  workspaceHooks();
  const roots: Array<() => void> = [];
  afterEach(() => { for (const unmount of roots.splice(0)) unmount(); vi.useRealTimers(); });

  const LIMITS = { layout: { limit: 10, remaining: 7, resetsAt: null }, sample: { limit: 20, remaining: 20, resetsAt: null } };
  const job = (project: WorkshopProject, fields: Partial<PrepareJob>): PrepareJob => ({ id: 'job-1', kind: 'layout', state: 'queued',
    position: 0, stage: null, detail: null, progress: null, error: null, packageId: null, cancelling: false, projectId: project.id,
    projectName: project.name, interruptions: 0, ...fields });
  /** The fake service: `/api/jobs` answers `active` (and `limits`); each poll of the job answers the next of `polls`. */
  function fake(active: PrepareJob | null, polls: PrepareJob[] = [], routes: Record<string, (call: Call) => Reply> = {},
    limits: unknown = LIMITS) {
    return service({ 'GET /api/packages': () => ({ body: [] }), 'GET /api/jobs': () => ({ body: { active, limits } }),
      ...(active || polls.length ? { [`GET /api/jobs/${(active ?? polls[0]).id}`]: () => ({ body: polls.length > 1 ? polls.shift() : polls[0] }) } : {}),
      ...routes });
  }
  async function mount(project: WorkshopProject, options: { receipts?: ArtifactReceipt[]; onOpenProject?: (id: string) => void } = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ExportPanel, { project, fit: fitProject(project), account: MEMBER,
      onNeedAccount: () => {}, saveRevision: async () => ({ id: project.id, revision: crypto.randomUUID() }), onReceipt: () => {}, onChange: () => {}, onEditMeasurement: () => {},
      receipts: options.receipts ?? [], onOpenProject: options.onOpenProject })));
    await settle();
    roots.push(() => { act(() => root.unmount()); host.remove(); });
    return host;
  }
  /** The next poll of the active job. */
  async function poll() {
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await settle();
  }
  const words = (host: HTMLElement) => host.textContent!.replace(/\s+/g, ' ');
  const prepareButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('#prepare-plates');

  it('a queued job shows its place in the queue, then the stage it runs, and no copy says "on this computer"', async () => {
    vi.useFakeTimers();
    const [project] = printedLayout();
    const calls = fake(null, [job(project, { state: 'running', position: 0, stage: 'slice', detail: 'Plate 2 of 8', progress: 0.67 })],
      { 'POST /api/jobs': () => ({ status: 202, body: job(project, { position: 1 }) }) });
    const host = await mount(project);
    expect(words(host)).toContain('7 of 10 layout prepares left today');
    await act(async () => { prepareButton(host)!.click(); });
    await settle();
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ kind: 'layout' });
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Waiting — 1 ahead of you');
    expect(prepareButton(host)).toBeNull();
    await poll();
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Preparing plates');
    expect(words(host)).toContain('Slicing plates · 2 of 8 · 67%');
    expect(words(host)).not.toMatch(/on this computer/i);
  });

  it('opening the page with a job running resumes showing its progress', async () => {
    const [project] = printedLayout();
    fake(job(project, { state: 'running', stage: 'cad', detail: 'Part 3 of 37', progress: 0.05 }));
    const host = await mount(project);
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Preparing plates');
    expect(words(host)).toContain('Building parts · 3 of 37 · 5%');
    expect(button(host, 'Cancel')).toBeDefined();
  });

  it('a layout in parts shows "Part 2 of 3" with that part’s stage, then one combined result', async () => {
    vi.useFakeTimers();
    const [project, layout] = printedLayout();
    const parts = (second: Partial<JobPart>): JobPart[] => [
      { index: 1, state: 'succeeded' as const, stage: 'guide', detail: null, progress: 1 },
      { index: 2, state: 'running' as const, stage: 'cad', detail: 'Part 4 of 12', progress: 0.2, ...second },
      { index: 3, state: 'queued' as const, stage: null, detail: null, progress: null }];
    const combined: ArtifactReceipt = { ...layout, id: 'combined', layoutParts: [1, 2, 3].map(index => ({ index, plates: [index], pieces: [String(index)] })),
      plates: [1, 2, 3].map(plate => ({ ...layout.plates[0], plate, model: `plate-0${plate}/plate-0${plate}.3mf` })) };
    fake(job(project, { state: 'running', stage: 'cad', detail: 'Part 2 of 3 · Part 4 of 12', progress: 0.4, parts: parts({}) }),
      [job(project, { state: 'succeeded', packageId: 'combined', progress: 1, parts: parts({ state: 'succeeded' }) })],
      { 'GET /api/packages/combined': () => ({ body: combined }) });
    const host = await mount(project);
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Preparing plates · Part 2 of 3');
    expect(words(host)).toContain('Building parts · 4 of 12');
    await poll();
    expect(host.querySelector('.export-progress')).toBeNull();
    const downloads = Array.from(host.querySelectorAll('[aria-label="Downloads"] a'), link => link.textContent);
    expect(downloads).toEqual(['Download all (ZIP)', 'STL files (ZIP)', 'Assembly guide (PDF)', 'Assembly guide (Markdown)']);
    expect(host.querySelector('[aria-label="Downloads"] a')?.getAttribute('href')).toBe('/api/packages/combined/plates.zip');
    expect(Array.from(host.querySelectorAll('.export-plate h3'), title => title.textContent?.split(' ·')[0])).toEqual(['Plate 1', 'Plate 2', 'Plate 3']);
    expect(words(host)).toContain('Prepared in 3 parts and combined into one set');
  });

  it('a piece group above the limit shows the limit and the group’s numbers, and no Prepare button for that layout', async () => {
    const [project] = printedLayout();
    const detail = 'This layout is too large to prepare. Its piece “Helix” has 212 printed parts with 103 different shapes, which needs about 12.1 GB of memory; one prepare can use 6.0 GB, and a piece can’t be split across prepares. Split it into shorter pieces and try again.';
    fake(null, [], { 'POST /api/jobs': () => ({ status: 422, body: { detail, limitMb: 6000, group: { printedParts: 212, cadBuilds: 103, memoryMb: 12100 } } }) });
    const host = await mount(project);
    await act(async () => { prepareButton(host)!.click(); });
    await settle();
    expect(prepareButton(host)).toBeNull();
    const refusal = words(host.querySelector('.export-refusal')!);
    expect(refusal).toContain(detail);
    expect(refusal).toContain('One prepare can use6.0 GB');
    expect(refusal).toContain('This piece needsabout 12.1 GB · 212 printed parts · 103 different shapes');
    expect(host.querySelector('.export-progress')).toBeNull();
  });

  it('an expired receipt shows "Files expired" and prepares the same package again', async () => {
    const [project, layout] = printedLayout();
    const calls = fake(null, [], { [`POST /api/packages/${layout.id}/prepare`]: () => ({ status: 202, body: job(project, {}) }) });
    const host = await mount(project, { receipts: [{ ...layout, expired: true, expiresAt: '2026-10-01T10:00:00+00:00' }] });
    expect(host.querySelector('#plate-files h3')?.textContent).toBe('Files expired');
    expect(host.querySelector('[aria-label="Downloads"]')).toBeNull();
    expect(host.querySelector(`a[href*="/api/packages/${layout.id}/files/"]`)).toBeNull();
    await act(async () => { button(host.querySelector('#plate-files')!, 'Prepare again')!.click(); });
    await settle();
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([`/api/packages/${layout.id}/prepare`]);
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Waiting — you’re next');
  });

  it('with the daily limit reached, Prepare is disabled and says when it frees up', async () => {
    const [project] = printedLayout();
    const resetsAt = new Date(Date.now() + 2 * 3600_000);
    fake(null, [], {}, { ...LIMITS, layout: { limit: 10, remaining: 0, resetsAt: resetsAt.toISOString() } });
    const host = await mount(project);
    expect(prepareButton(host)?.disabled).toBe(true);
    const time = resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(words(host)).toMatch(new RegExp(`Daily limit reached: 10 layout prepares in 24 hours\\. You can prepare again (tomorrow )?at ${time}\\.`));
  });

  it('with a prepare running for another project, Prepare is disabled and links to that project', async () => {
    const [project] = printedLayout();
    const opened: string[] = [];
    fake(job(project, { state: 'running', stage: 'cad', projectId: 'harbour', projectName: 'Harbour loop' }));
    const host = await mount(project, { onOpenProject: id => opened.push(id) });
    expect(prepareButton(host)?.disabled).toBe(true);
    expect(words(host)).toContain('Preparing Harbour loop — open it or cancel it first.');
    expect(host.querySelector('.export-progress')).toBeNull();
    await act(async () => { button(host, 'Open Harbour loop')!.click(); });
    expect(opened).toEqual(['harbour']);
  });

  it('a job that ran out of memory shows the layout-size message', async () => {
    vi.useFakeTimers();
    const [project] = printedLayout();
    const error = 'This layout ran out of memory while preparing: it is too large for one prepare. Split long pieces into shorter ones, or remove some pieces, and try again.';
    fake(job(project, { state: 'running', stage: 'cad' }), [job(project, { state: 'failed_too_large', error })]);
    const host = await mount(project);
    await poll();
    expect(host.querySelector('.export-outcome')?.textContent).toBe(error);
    expect(prepareButton(host)?.disabled).toBe(false);
  });

  it('a system failure says it did not count toward the daily limit and offers Prepare again', async () => {
    vi.useFakeTimers();
    const [project] = printedLayout();
    const calls = fake(job(project, { state: 'running', stage: 'slice' }), [job(project, { state: 'failed_system', error: 'Preparing the print files failed. Try again later.' })],
      { 'POST /api/jobs': () => ({ status: 202, body: job(project, { id: 'job-2' }) }) });
    const host = await mount(project);
    await poll();
    const outcome = host.querySelector('.export-outcome')!;
    expect(outcome.textContent).toContain('Something went wrong on our side — this didn’t count toward your daily limit');
    await act(async () => { button(outcome, 'Prepare again')!.click(); });
    await settle();
    expect(calls.filter(call => call.method === 'POST' && call.path === '/api/jobs')).toHaveLength(1);
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Waiting — you’re next');
  });

  it('cancelling returns the panel to the ready state', async () => {
    const [project] = printedLayout();
    const calls = fake(job(project, { state: 'queued', position: 2 }), [],
      { 'DELETE /api/jobs/job-1': () => ({ body: job(project, { state: 'cancelled' }) }) });
    const host = await mount(project);
    expect(prepareButton(host)).toBeNull();
    await act(async () => { button(host, 'Cancel')!.click(); });
    await settle();
    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(host.querySelector('.export-progress')).toBeNull();
    expect(host.querySelector('.export-outcome')).toBeNull();
    expect(prepareButton(host)?.disabled).toBe(false);
  });

  it('an interrupted job, and one requeued after a server restart, says it is restarting', async () => {
    const [project] = printedLayout();
    for (const interrupted of [job(project, { state: 'interrupted', position: null }), job(project, { state: 'queued', position: 0, interruptions: 1 })]) {
      fake(interrupted);
      const host = await mount(project);
      expect(host.querySelector('.export-progress strong')?.textContent).toBe('Restarting after a server restart');
    }
  });
});
