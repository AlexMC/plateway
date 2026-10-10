import { describe, expect, it } from 'vitest';
import saved from '../cad/tests/fixtures/hardware-pieces.json';
import { hardwareFixture } from './hardware-fixture';

describe('hardware fixture', () => {
  it('matches the piece catalogue the CAD hardware test walks (regenerate: npx vite-node scripts/hardware-fixture.ts)', () => {
    expect(saved).toEqual(hardwareFixture());
  });
});
