"""Narrow and dual gauge (gauge.py) and their junctions (gauge_junctions.py): one configuration each of the running,
mating, junction and bed probes; digital geometry only (wheel acceptance and clip retention are physical trials)."""

import math

import pytest

from cad.models import composite, gauge
from cad.models import gauge_junctions as G
from cad.service import assemblies
from cad.service.generate import source_dependencies

SHARED = {'rail_gauge': 40, 'rail_interface_width': 2.4, 'body_width': 63.8, 'base_thickness': 3.2,
          'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}
CONNECTOR = {'connector_version': 1, 'fit_adjustment': 0}


def track(segments, **changes):
    p = {**SHARED, 'segments': len(segments), 'z0': 0, 'z1': 0, 'grade0': 0, 'grade1': 0,
         'vcurve': 0, 'cant0': 0, 'cant1': 0, 'ends': 3}
    for index, (length, k0, k1) in enumerate(segments):
        p.update({f's{index}_len': length, f's{index}_k0': k0, f's{index}_k1': k1})
    return {**p, **changes}


COMPOSITES = {'narrow-R24': track([(192 * math.pi / 8, 1 / 192, 1 / 192)], gauge=gauge.NARROW),
              'dual-128': track([(128, 0, 0)], gauge=gauge.DUAL)}


@pytest.mark.parametrize('case', COMPOSITES)
def test_composite_runs_clear_mates_and_rebuilds_when_the_gauge_sources_change(case):
    p = COMPOSITES[case]
    mesh = composite.track_mesh(p)
    assert mesh.is_watertight and mesh.body_count == 1
    running = gauge.probe_running(p)
    assert {rail['lateralMm'] for rail in running['rails']} == ({-12., 12.} if p['gauge'] == gauge.NARROW else {-20., -12., 12., 20.})
    assert all(rail['corridorHits'] == 0 and rail['headMissingSamples'] == 0 for rail in running['rails'])
    assert gauge.probe_mating(p)['interferenceMm3'] <= .001
    dependencies = source_dependencies({'family': composite.FAMILY, 'parameters': p})
    assert {gauge.NARROW_PROFILE_PATH.name, 'gauge.py'} <= {path.name for path in dependencies}
    assert 'gauge.py' not in {path.name for path in source_dependencies({'family': composite.FAMILY, 'parameters': track([(128, 0, 0)])})}


def test_dual_divergence_runs_both_gauges_keeps_its_ends_and_fits_the_mini_bed():
    p = {**CONNECTOR, 'hand': 1}
    running = G.probe_running(p)
    assert {row['route'] for row in running['rails']} == {'main', 'branch'}
    assert max(row['headGapMm'] for row in running['rails']) <= 4
    # Every frog gap long enough to drop a flange is guarded by a check rail.
    assert running['checkRails']
    assert all(max(row['lostMm3'], row['addedMm3']) <= .005 for row in G.probe_contacts(p))
    bed = G.probe_bed(p)
    assert bed['watertight'] and bed['bodies'] == 1 and max(bed['planSizeMm']) <= G.BED
    # Both routes are always open: the train's gauge picks one.
    pairs = G.route_pairs('dual_divergence', p)
    assert all(pairs.values()) and set(pairs) == {frozenset(('in', 'out')), frozenset(('in', 'branch'))}
    ports = {row['id']: row for row in G.ports('dual_divergence', {**CONNECTOR, 'hand': -1})}
    assert ports['branch']['position'][:2] == pytest.approx([192 * math.sin(math.pi / 4), -192 * (1 - math.cos(math.pi / 4))])
    assert ports['branch']['heading'] == pytest.approx(-math.pi / 4)


def test_narrow_stub_switch_lines_up_each_stub_and_only_offers_the_deck_that_does():
    p = {**CONNECTOR, 'deck': 192, 'switch_state': 1}
    tables, sector = G._tables(), G._sector(p)
    rows = tables.probe_alignment('sector_plate', sector)
    assert rows and not any(row.get('missing') for row in rows)
    assert max(row['lateral'] for row in rows) <= .3 and max(row['angle'] for row in rows) <= .5
    assert all(.75 <= row['gap'] <= 1.5 for row in rows)
    assert tables.probe_play('sector_plate', sector)['lateral'] <= .3
    assert tables.probe_motion('sector_plate', sector, steps=8)['worst_overlap_mm3'] < 1e-3
    assert tables.probe_envelopes('sector_plate', sector)['outside_mm2'] < 1e-3
    for role, mesh, yaw in G.parts('narrow_stub_switch', p):
        assert max(tables.plan_size(mesh, yaw)) <= G.BED, role
    pairs = G.route_pairs('narrow_stub_switch', p)
    assert [sorted(pair) for pair, enabled in pairs.items() if enabled] == [['in', 'out']]
    assert assemblies.module_for('narrow_stub_switch') is G
    # A 16-stud deck leaves the far stubs 0.84 mm / 2.1° off a deck rail.
    with pytest.raises(ValueError, match='192 mm'):
        G.validate('narrow_stub_switch', {**p, 'deck': 128})
