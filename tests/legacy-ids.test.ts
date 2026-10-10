import { describe, expect, it } from 'vitest';
import { calibrationKey, effectiveFitAdjustment, setFitAdjustment } from '../src/domain/calibration';
import { createProject, parseProject, serializeProject } from '../src/domain/project';
import { placePiece } from '../src/editor/operations';

/** A save from before the neutral ids, as drafts in this browser and older gallery bodies still hold it. */
function oldFormatSave() {
  let project = createProject('Before brick ids');
  project.inventory.brick_straight_nominal = 8;
  project.inventory.brick_switch_left = 1;
  project = placePiece(project, 'brick_straight_nominal', { x: 300, y: 300 })[0];
  project = placePiece(project, 'printed_brick_straight', { x: 300, y: 900 })[0];
  project = placePiece(project, 'brick_switch_left', { x: 1200, y: 900 })[0];
  project = setFitAdjustment(project, 0.05);
  const saved = JSON.parse(serializeProject(project));
  saved.trackSystem = 'lego-compatible-v1';
  saved.connectorFit.settingsKey = saved.connectorFit.settingsKey.replace('"brick-v1"', '"lego-compatible-v1"');
  const old = ['lego_straight_nominal', 'printed_lego_straight', 'lego_switch_left'];
  saved.routes.flatMap((route: { pieces: { family: string }[] }) => route.pieces).forEach((piece: { family: string }, index: number) => {
    piece.family = old[index];
  });
  saved.inventory = { lego_straight_nominal: 8, lego_switch_left: 1, lego_curve_r40_nominal: 16 };
  saved.partDesign = { lego_straight_length: 128, lego_curve_radius: 320, deck_width: 60 };
  return { project, saved };
}

describe('saves from before the neutral brick ids', () => {
  it('open with the current ids and keep their fit adjustment', () => {
    const { project, saved } = oldFormatSave();
    expect(saved.connectorFit.settingsKey).toContain('"lego-compatible-v1"');
    const reopened = parseProject(JSON.stringify(saved));
    expect(reopened.trackSystem).toBe('brick-v1');
    expect(reopened.routes.flatMap(route => route.pieces).map(piece => piece.family))
      .toEqual(['brick_straight_nominal', 'printed_brick_straight', 'brick_switch_left']);
    expect(reopened.inventory).toEqual({ brick_straight_nominal: 8, brick_switch_left: 1, brick_curve_r40: 16 });
    expect(reopened.partDesign).toEqual({ deck_width: 60 });
    expect(reopened.connectorFit.settingsKey).toBe(calibrationKey(reopened));
    expect(reopened.connectorFit.settingsKey).toBe(project.connectorFit.settingsKey);
    expect(effectiveFitAdjustment(reopened)).toBe(0.05);
    expect(reopened.layoutRevision).toBe(project.layoutRevision);
  });

  it('keep a current R40 count over the older nominal-curve key', () => {
    const { saved } = oldFormatSave();
    saved.inventory = { lego_curve_r40: 4, lego_curve_r40_nominal: 16 };
    expect(parseProject(JSON.stringify(saved)).inventory).toEqual({ brick_curve_r40: 4 });
  });
});
