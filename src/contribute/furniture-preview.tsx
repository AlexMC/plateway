import { useEffect, useMemo } from 'react';
import { registerFurnitureType, unregisterFurnitureType, type FurnitureType } from '../domain/furniture';
import { createProject } from '../domain/project';
import { BuilderScene } from '../editor/builder-scene';
import { fitProject } from '../fitting/fit';

/** The family a preview registers under (U13's registry) while it shows; never saved in a project or the library. */
export const PREVIEW_FAMILY = 'community_preview';
const ROOM = 4000;
const nothing = () => {};

/**
 * A furniture preset as the Build step's 3D scene draws it: registered under `PREVIEW_FAMILY` through the furniture
 * registry and placed alone in an empty room, so what shows here is what Build will show. Each change of `type` registers
 * it again and redraws; unmounting removes it from the registry.
 */
export function FurniturePreview({ type }: { type: FurnitureType }) {
  // Registered during render, before the scene's effect draws the room from the registry.
  const project = useMemo(() => {
    registerFurnitureType({ ...type, family: PREVIEW_FAMILY });
    const room = createProject('Furniture preview');
    room.measurements.roomWidth = { value: ROOM, source: 'Preview', status: 'estimate' };
    room.measurements.roomDepth = { value: ROOM, source: 'Preview', status: 'estimate' };
    room.furniture = [{ id: 'preview', family: PREVIEW_FAMILY, x: ROOM / 2, y: ROOM / 2, quarterTurns: 0 }];
    return room;
  }, [type]);
  useEffect(() => () => unregisterFurnitureType(PREVIEW_FAMILY), []);
  const fit = useMemo(() => fitProject(project), [project]);
  return <div className="contribute-furniture-preview">
    <BuilderScene project={project} fit={fit} selectedId={null} selectedFurnitureId={null} highlight={null} armedFurniture={false}
      previewFurniture={null} preview={[]} snapTarget={null} armed={false} onHover={nothing} onDrag={nothing} onDeselect={nothing}
      onPlace={nothing} onSelect={nothing} onMove={nothing} onFurniturePlace={nothing} onFurnitureSelect={nothing} onFurnitureMove={nothing} />
  </div>;
}
