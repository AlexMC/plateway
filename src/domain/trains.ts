import type { Car, Community } from './project';

/**
 * Official brick train sets measured from their LDraw models (scripts/trains → public/trains/index.json).
 * Car frame: x forward (front coupler +x), y left, z up, mm; origin midway between the outer bogie pivots on the
 * track centreline at railhead top. Each car's `asset` is a glTF in that frame.
 */
export type TrainPower = 'none' | '4.5V' | '12V' | '9V' | 'RC' | 'IR' | 'BT' | 'monorail';
export interface TrainCatalogue { version: 1; sets: TrainSet[] }
export interface TrainSet {
  id: string; name: string; year: number; theme: string; power: TrainPower; gauge: 'standard' | 'monorail';
  /** `library`: a community train from the library index (src/domain/library.ts); `authors` holds its credit. */
  source: { kind: 'omr' | 'ldraw-unofficial' | 'procedural' | 'library'; url?: string; authors?: string[]; license?: string; evidence?: string };
  /** A community train: its provenance, for its Community mark. */
  community?: Community;
  cars: TrainCar[];
}
export interface TrainCar {
  id: string; name: string; kind: 'loco' | 'tender' | 'wagon' | 'coach' | 'caboose' | 'other'; motorised: boolean; asset: string;
  length: number; width: number; height: number; bogies: number[]; wheelbase: number;
  couplers: { front: number; rear: number }; outline: [number, number][]; triangles: number; bytes: number;
}

export const TRAIN_CATALOGUE_PATH = 'trains/index.json';

/** How each era's train is powered, and what that means for a layout with printed track and Bluetooth-hub mechanisms. */
export const POWER_NOTES: Record<TrainPower, { label: string; note: string | null }> = {
  none: { label: 'Unpowered', note: null },
  '4.5V': { label: '4.5 V battery', note: '4.5 V battery train: runs on any track, but its motor and battery are long out of production.' },
  '12V': { label: '12 V', note: '12 V train: takes power from a centre conductor rail that printed and modern brick track don’t have.' },
  '9V': { label: 'Metal-rail 9 V', note: '9 V train: takes power from metal rails; it stalls on printed or plastic track.' },
  RC: { label: 'Radio control', note: 'Radio-control train: its own battery and remote; it can’t drive Bluetooth mechanisms.' },
  IR: { label: 'Infrared remote', note: 'Infrared train: its IR receiver can’t drive Bluetooth motors; layout mechanisms need a Bluetooth hub.' },
  BT: { label: 'Bluetooth hub', note: null },
  monorail: { label: 'Monorail motor', note: 'Monorail: runs only on monorail beam.' }
};

let loading: Promise<TrainCatalogue> | null = null;
/** Community trains offered in the picker (live in the library index), each a one-car set, in index order. */
const LIBRARY_SETS: TrainSet[] = [];
/** The digest-checked model of every community train the index lists, live or retired, by its `library:` asset. */
const LIBRARY_MODELS = new Map<string, ArrayBuffer>();

/**
 * Adds a community train once its file has downloaded (KTD9), possibly after projects that use it were parsed: their cars
 * keep the reference and show the model from then on. `model` is its glTF, already checked against the index's digest.
 * A retired one (`offered` false) is not in the picker, but cars that use it still show it.
 */
export function registerLibraryTrain(set: TrainSet, model: ArrayBuffer, offered: boolean): void {
  for (const car of set.cars) LIBRARY_MODELS.set(car.asset, model);
  if (offered) LIBRARY_SETS.push(set);
}
/** A community train's checked model by its asset reference; undefined when the index doesn't list that id and digest. */
export function libraryModel(asset: string): ArrayBuffer | undefined {
  return LIBRARY_MODELS.get(asset);
}

/** The bundled catalogue, fetched once, followed by the community trains on offer. */
export function loadTrainCatalogue(): Promise<TrainCatalogue> {
  loading ??= fetch(`${import.meta.env.BASE_URL}${TRAIN_CATALOGUE_PATH}`).then(async response => {
    if (!response.ok) throw new Error(`Train catalogue unavailable (${response.status})`);
    const catalogue = await response.json() as TrainCatalogue;
    if (catalogue?.version !== 1 || !Array.isArray(catalogue.sets)) throw new Error('Train catalogue has an unknown format');
    return catalogue;
  }).catch(error => { loading = null; throw error; });
  return loading.then(catalogue => ({ ...catalogue, sets: [...catalogue.sets, ...LIBRARY_SETS] }));
}

/** Sets whose number, name, theme, power or year contain every word of `query`, newest first. */
export function searchTrainSets(catalogue: TrainCatalogue, query: string): TrainSet[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalogue.sets.filter(set => {
    const text = `${set.id} ${set.name} ${set.theme} ${set.power} ${POWER_NOTES[set.power]?.label ?? ''} ${set.year} ${set.gauge}`.toLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => b.year - a.year || a.id.localeCompare(b.id));
}

/** A project car carrying a catalogue car's measurements; coupling faces touch, so there is no extra gap. */
export function catalogueCar(set: TrainSet, car: TrainCar, id: string = crypto.randomUUID()): Car {
  return {
    id, name: car.name, length: car.length, width: car.width, height: car.height, wheelbase: car.wheelbase, couplerGap: 0,
    ...(set.gauge === 'monorail' ? { gauge: 'monorail' as const } : {}),
    model: { set: set.id, car: car.id, asset: car.asset },
    bogies: [...car.bogies], couplers: { ...car.couplers }, outline: car.outline.map(([x, y]) => [x, y] as [number, number])
  };
}
