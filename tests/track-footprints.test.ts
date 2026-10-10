import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece } from '../src/domain/project';
import { checkAssemblyFootprints } from '../src/domain/track-footprints';
import { rebuildPiecePoints } from '../src/editor/operations';

function layout(pieces:RoutePiece[]) {
  const project=createProject('Mechanism clearance');
  project.measurements.roomWidth={value:2000,source:'Measured test room',measuredAt:'2026-01-01'};
  project.measurements.roomDepth={value:2000,source:'Measured test room',measuredAt:'2026-01-01'};
  project.routes=pieces.map((piece,index)=>{
    const route={id:`route-${index}`,name:'Track',pieces:[piece],points:[]};
    rebuildPiecePoints(project,route);return route;
  });
  return project;
}
const turnout:RoutePiece={id:'turnout',family:'printed_switch_left',x:500,y:500,z:0,heading:0};
const nearby:RoutePiece={id:'nearby',family:'printed_brick_straight',x:520,y:600,z:0,heading:0};

describe('physical assembly operating clearance',()=>{
  it('rejects selector travel beyond a room even with every route centreline inside',()=>{
    const issues=checkAssemblyFootprints(layout([{...turnout,x:200,y:50}]));
    expect(issues.map(issue=>issue.code)).toContain('assembly-envelope-outside-room');
  });
  it('reserves both selector states while allowing standard parallel spacing and vertical separation',()=>{
    for(const state of ['straight','diverging'] as const) {
      expect(checkAssemblyFootprints(layout([{...turnout,state},nearby])).map(issue=>issue.code)).toContain('assembly-track-collision');
      expect(checkAssemblyFootprints(layout([{...turnout,state},{...nearby,y:628}]))).toEqual([]);
      expect(checkAssemblyFootprints(layout([{...turnout,state},{...nearby,z:20}]))).toEqual([]);
    }
  });
  it('allows only matching end contact bands, not unrelated overlapping track',()=>{
    expect(checkAssemblyFootprints(layout([turnout,{...nearby,x:372,y:500}]))).toEqual([]);
    expect(checkAssemblyFootprints(layout([turnout,{...nearby,x:380,y:500}])).map(issue=>issue.code)).toContain('assembly-track-collision');
  });
  it('checks actual shelf panels without treating open-through bays as solid furniture',()=>{
    const flex:RoutePiece={id:'flex',family:'printed_flex',x:200,y:1000,z:100,heading:0};
    const project=layout([flex]);
    project.furniture=[{id:'shelf',family:'kallax_5x5',x:1000,y:1000,quarterTurns:0}];
    expect(checkAssemblyFootprints(project)).toEqual([]);
    project.routes[0].pieces![0].x=125;
    rebuildPiecePoints(project,project.routes[0]);
    expect(checkAssemblyFootprints(project).map(issue=>issue.code)).toContain('assembly-furniture-collision');
  });
});
