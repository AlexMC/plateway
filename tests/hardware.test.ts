import { describe, expect, it } from 'vitest';
import { hardwareCsv, hardwareText, type HardwareResult } from '../src/export/hardware';

const result: HardwareResult = {
  lines: [{ category: 'electronics', name: 'SG90 micro servo', quantity: 3, pieces: ['Turnout ×3'] }],
  control: [
    { category: 'electronics', name: 'Servo extension lead', quantity: 3, scope: 'per servo', note: 'from the servo to the driver board' },
    { category: 'brick', name: 'Bluetooth 4-port hub (88012)', quantity: 1, scope: 'shared, up to 4 motors per hub', note: '' }],
  notes: [], warnings: []
};

describe('shopping list export', () => {
  it('says how each piece of control gear is shared instead of calling it once per layout', () => {
    const text = hardwareText(result, 'Layout');
    expect(text).toContain('Control gear\n  3 × Servo extension lead — per servo; from the servo to the driver board\n'
      + '  1 × Bluetooth 4-port hub (88012) — shared, up to 4 motors per hub');
    expect(text).not.toMatch(/once per layout/i);
    expect(hardwareCsv(result).split('\n').slice(1, 4)).toEqual([
      'Electronics,SG90 micro servo,3,Turnout ×3',
      'Electronics,Servo extension lead,3,per servo; from the servo to the driver board',
      'Brick parts,Bluetooth 4-port hub (88012),1,"shared, up to 4 motors per hub"']);
  });
});
