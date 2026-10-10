import { describe, expect, it } from 'vitest';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placePiece } from '../src/editor/operations';
import { checkStatus, recordCheck } from '../src/domain/trials';

describe('after-you-print checks', () => {
  it('records outcomes without changing the layout, and the latest report wins', () => {
    const [project] = placePiece(createStandardProject('Ramp'), 'vertical_transition', { x: 100, y: 100, rise: 6 });
    expect(checkStatus(project, 'grade')).toBe('pending');
    expect(() => recordCheck(project, 'grade', true, '', false)).toThrow();
    const worked = recordCheck(project, 'grade', true, 'Climbs both ways', true);
    expect(worked.layoutRevision).toBe(project.layoutRevision);
    expect(worked.revision).not.toBe(project.revision);
    expect(project.observations).toEqual([]);
    expect(checkStatus(worked, 'grade')).toBe('worked');
    expect(checkStatus(worked, 'under-run')).toBe('pending');
    const failed = recordCheck(worked, 'grade', false, 'Slipped when loaded', true);
    expect(checkStatus(failed, 'grade')).toBe('failed');
    expect(checkStatus(recordCheck(failed, 'grade', true, 'Longer ramp', true), 'grade')).toBe('worked');
  });

  it('starts unchecked again after the layout changes', () => {
    const [project] = placePiece(createStandardProject('Ramp'), 'vertical_transition', { x: 100, y: 100, rise: 6 });
    const worked = recordCheck(project, 'grade', true, '', true);
    const edited = placePiece(worked, 'printed_straight', { x: 900, y: 900 })[0];
    expect(checkStatus(edited, 'grade')).toBe('pending');
  });
});
