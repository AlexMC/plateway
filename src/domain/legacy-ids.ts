/**
 * The one place the client names the identifiers saves used before the neutral `brick` ids: older drafts and gallery
 * bodies are rewritten to the current ids when parsed (cad/service/migrations/010_brick_ids.sql does the same on the
 * server). Nothing else in the app accepts the old ids.
 */

const FAMILIES: Readonly<Record<string, string>> = {
  lego_straight_nominal: 'brick_straight_nominal', lego_curve_r40: 'brick_curve_r40', lego_flex: 'brick_flex',
  lego_switch_left: 'brick_switch_left', lego_switch_right: 'brick_switch_right', lego_crossing90: 'brick_crossing90',
  lego_double_crossover: 'brick_double_crossover', printed_lego_straight: 'printed_brick_straight',
  lego_end_coupon: 'brick_end_coupon'
};
const TRACK_SYSTEM = { from: 'lego-compatible-v1', to: 'brick-v1' } as const;
/** An inventory key older still than the families above, folded into the R40 curve count. */
const NOMINAL_CURVES = 'lego_curve_r40_nominal';
/** Part-design keys the app stopped offering. */
const RETIRED_PART_DESIGN = ['lego_straight_length', 'lego_curve_radius'] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The current id of a piece family, renamed or not. */
const currentFamily = (family: string): string => FAMILIES[family] ?? family;

/** `saved` with the old track system, families, inventory keys and calibration key replaced by the current ones. */
export function migrateLegacyIds(saved: Record<string, unknown>): Record<string, unknown> {
  const value = { ...saved };
  if (value.trackSystem === TRACK_SYSTEM.from) value.trackSystem = TRACK_SYSTEM.to;
  // The calibration key embeds the track system as a JSON string; the fit adjustment keeps applying under the new id.
  if (record(value.connectorFit) && typeof value.connectorFit.settingsKey === 'string') value.connectorFit = {
    ...value.connectorFit,
    settingsKey: value.connectorFit.settingsKey.replaceAll(JSON.stringify(TRACK_SYSTEM.from), JSON.stringify(TRACK_SYSTEM.to))
  };
  if (Array.isArray(value.routes)) value.routes = value.routes.map(route => record(route) && Array.isArray(route.pieces)
    ? { ...route, pieces: route.pieces.map(piece => record(piece) && typeof piece.family === 'string'
      ? { ...piece, family: currentFamily(piece.family) } : piece) }
    : route);
  if (record(value.inventory)) {
    const inventory: Record<string, unknown> = {};
    for (const [key, count] of Object.entries(value.inventory)) if (key !== NOMINAL_CURVES) inventory[currentFamily(key)] = count;
    if (value.inventory[NOMINAL_CURVES] !== undefined) inventory[FAMILIES.lego_curve_r40] ??= value.inventory[NOMINAL_CURVES];
    value.inventory = inventory;
  }
  if (record(value.partDesign)) {
    const partDesign = { ...value.partDesign };
    for (const key of RETIRED_PART_DESIGN) delete partDesign[key];
    value.partDesign = partDesign;
  }
  return value;
}
