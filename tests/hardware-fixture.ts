import { PIECE_DEFINITIONS, paramValue, type PieceDefinition } from '../src/domain/pieces';
import type { RoutePiece } from '../src/domain/project';
import { createStandardProject } from '../src/editor/setup-defaults';
import { pieceParts } from '../src/fitting/fit';

/** Options that change a piece's bought parts. */
const HARDWARE_KEYS: Record<string, true> = { servo: true, sprung: true, drive: true, motor: true, metal: true, led: true, bracket: true };

export interface FixturePiece { piece: string; variant: string; family: string; parameters: Record<string, number> }

function defaultPiece(definition: PieceDefinition, params?: Record<string, number>): RoutePiece {
  const legacy = definition.legacy ?? {};
  return { id: 'fixture', family: definition.family, x: 0, y: 0, z: 0, heading: 0,
    ...(legacy.sweep !== undefined ? { sweep: legacy.sweep } : {}), ...(legacy.rise !== undefined ? { rise: 8 } : {}),
    ...(params ? { params } : {}) } as RoutePiece;
}

/**
 * The printed parts (as fit makes them, brackets included) of every printed piece at its defaults and with each
 * hardware option at each value it offers there.
 */
export function hardwareFixture(): FixturePiece[] {
  const project = createStandardProject('Hardware fixture');
  const out: FixturePiece[] = [];
  for (const definition of PIECE_DEFINITIONS) {
    if (definition.source !== 'printed') continue;
    const piece = defaultPiece(definition), [main] = definition.cad(piece, project);
    const setting = (key: string) => main?.parameters[key] ??
      (definition.params.some(spec => spec.key === key) ? paramValue(definition, piece, key) : 0);
    const variants: [string, Record<string, number> | undefined][] = [['default', undefined]];
    for (const spec of definition.params) {
      // Only options the piece offers at its defaults (9V rails hide on street track, which is always street).
      if (!HARDWARE_KEYS[spec.key] || !spec.options || spec.when && !spec.when.values.includes(setting(spec.when.key))) continue;
      for (const option of spec.options) if (option.value !== spec.default) variants.push([`${spec.key}=${option.value}`, { [spec.key]: option.value }]);
    }
    for (const [variant, params] of variants) for (const part of pieceParts(defaultPiece(definition, params), project))
      out.push({ piece: definition.family, variant, family: part.family, parameters: part.parameters });
  }
  return out;
}
