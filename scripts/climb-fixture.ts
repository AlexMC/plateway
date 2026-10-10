/**
 * Writes cad/tests/fixtures/climb-parts.json: the printed parts fit cuts each Go up or down climb into (+38, +64 and
 * −64 mm at 4 %, for the X1 Carbon and the A1 mini). cad/tests/test_climb.py builds every part, checks the joints between
 * them are continuous in height and grade, and slices them.
 * Run: npx vite-node scripts/climb-fixture.ts (tests/climb.test.ts fails when it is stale).
 */
import { writeFileSync } from 'node:fs';
import { climbFixture } from '../tests/climb-fixture';

writeFileSync(new URL('../cad/tests/fixtures/climb-parts.json', import.meta.url), `${JSON.stringify(climbFixture(), null, 1)}\n`);
