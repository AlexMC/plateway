import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { placePiece } from '../src/editor/operations';
import { SelectedPiecePanel, driveNote, driveSpec, driveSummary } from '../src/editor/piece-panel';

/** Every family worked by hand or by a motor, servo or lead screw. */
const DRIVEN = ['turntable', 'bridge_bascule', 'bridge_lift', 'train_elevator', 'rotary_dumper', 'funicular', 'uncoupler_track',
  'turnout_radius', 'turnout_curved', 'turnout_wye', 'turnout_three_way'];

function selected(family: string, params?: Record<string, number>): { project: WorkshopProject; markup: string } {
  const [project, id] = placePiece(createProject('Drive'), family, { x: 1000, y: 1000, ...(params ? { params } : {}) });
  const piece = project.routes.flatMap(route => route.pieces).find(item => item.id === id)!;
  const none = () => {};
  const markup = renderToStaticMarkup(createElement(SelectedPiecePanel, { project, piece, committed: piece, fit: fitProject(project), account: { status: 'offline' },
    fastAvailable: true, stock: () => undefined, actions: [], onChange: none, onDraft: none, onCommitDraft: none, onClose: none }));
  return { project, markup };
}

describe('the Drive section', () => {
  it('shows every driven family its own Drive choices, and not again among the shape settings', () => {
    for (const family of DRIVEN) {
      const spec = driveSpec(pieceDefinition(family))!;
      expect(spec, family).toBeDefined();
      const { markup } = selected(family);
      expect(markup, family).toContain('aria-label="Drive"');
      for (const option of spec.options!) expect(markup, family).toContain(`>${option.label}</button>`);
      expect(markup, family).not.toContain(`id="selected-param-${spec.key}"`);
    }
  });

  it('leaves it out where it does not apply: sprung points have no servo', () => {
    expect(selected('turnout_radius').markup).toContain('aria-label="Drive"');
    expect(selected('turnout_radius', { sprung: 1 }).markup).not.toContain('aria-label="Drive"');
  });

  it('says what a motor takes, naming an infrared 60052 train that cannot run a Bluetooth hub', () => {
    const project = createProject('With 60052');
    project.cars.push({ id: 'loco', name: 'Locomotive', length: 200, width: 60, height: 90, wheelbase: 120, couplerGap: 8,
      model: { set: '60052-1', car: 'loco', asset: 'trains/60052-1/loco.glb' } });
    expect(driveNote('Bluetooth motor', project)).toMatch(/Bluetooth hub.*your 60052 can’t drive it/);
    expect(driveNote('Infrared L motor (88003)', project)).toMatch(/IR receiver 8884.*battery box 88000/);
    expect(driveNote('Bluetooth motor', createProject('No train'))).not.toContain('60052');
    const turntable = driveSpec(pieceDefinition('turntable'))!;
    expect(driveSummary(turntable, 0)).toBe('by hand or motor');
    expect(driveSummary(turntable, 1)).toBe('Bluetooth motor');
    expect(driveSummary(driveSpec(pieceDefinition('turnout_radius'))!, 0)).toBe('by hand or servo');
  });

});
