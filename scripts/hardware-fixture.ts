/**
 * Writes cad/tests/fixtures/hardware-pieces.json: the CAD family and parameters of every printed piece the editor
 * offers, at its default options and with each hardware-changing option (servo, drive, motor, 9V metal, LED,
 * brackets, sprung) set to each of its values. cad/tests/test_hardware.py checks every one's hardware rows.
 * Run: npx vite-node scripts/hardware-fixture.ts (tests/hardware-fixture.test.ts fails when it is stale).
 */
import { writeFileSync } from 'node:fs';
import { hardwareFixture } from '../tests/hardware-fixture';

writeFileSync(new URL('../cad/tests/fixtures/hardware-pieces.json', import.meta.url), `${JSON.stringify(hardwareFixture(), null, 1)}\n`);
