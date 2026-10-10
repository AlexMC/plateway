"""Prepare jobs (U7): the queue's limits and splitting, and the worker's state transitions against fake prepare
processes that report through the job row as `prepare_job` does."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import uuid

import pytest

from cad.service import db, prepare_job
from cad.service.calibration import BRICK_PROFILE
from cad.service.errors import UserError
from cad.service.jobs import BASE_MB, BUILD_MB, PART_MB, Jobs, Limits
from cad.service.receipts import Receipts
from cad.service.storage import library_reader, open_storage
from cad.service.worker import Worker
from cad.tests.test_package import community_only, sample_curve
from signed_in import session_headers, signed_in_client

ORIGIN = 'http://127.0.0.1:8765'
REPO = Path(__file__).resolve().parents[1]
# A section's share of the estimate in `layout()`: each is one printed part and its own CAD build.
SECTION_MB = BUILD_MB + PART_MB
# Room for three sections in one prepare.
THREE_SECTIONS = Limits(part_mb=BASE_MB + 3 * SECTION_MB)

FAKE_PREPARE = f'''
import os, signal, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, {str(REPO)!r})
from cad.service.jobs import Jobs

database, job_id, behaviour, log = Path(sys.argv[1]), sys.argv[2], sys.argv[3], Path(sys.argv[4])
exports = Path(sys.argv[5])
jobs = Jobs(database)
work = jobs.work(job_id)
name = 'combined' if work.combine else f"part-{{work.part['index']}}" if work.part else 'whole'
with log.open('a') as out:
    out.write(name + '\\n')
if behaviour.startswith('wait:'):
    while not Path(behaviour[5:]).exists():
        time.sleep(.05)
    behaviour = 'succeed'
if behaviour == 'succeed':
    # A combine step reads its parts' packages, which stay in the export root until then.
    if work.combine and not all((exports / package).is_dir() for package in work.combine):
        sys.exit('a part package is missing')
    for stage, total in (('cad', 2), ('arrange', 1), ('slice', 2), ('guide', 1)):
        for done in range(total):
            jobs.progress(job_id, stage, done, total)
    if work.part:
        (exports / f'package-{{name}}').mkdir(parents=True, exist_ok=True)
    jobs.record_package(job_id, f'package-{{name}}')
elif behaviour == 'member-error':
    jobs.record_error(job_id, 'Give the project a name before preparing plates.')
    sys.exit(3)
elif behaviour == 'crash':
    raise RuntimeError('prepare crashed')
elif behaviour == 'oom':
    os.kill(os.getpid(), signal.SIGKILL)
elif behaviour == 'hang':
    # A slicer stands in for the child's own child; a half-built package stands in for its staging folder.
    slicer = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
    (exports / '.incomplete-fake').mkdir(parents=True)
    jobs.progress(job_id, 'cad', 0, 4)
    log.with_suffix('.slicer').write_text(str(slicer.pid))
    time.sleep(600)
'''


class Clock:
    def __init__(self):
        self.now = 1_900_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


def straight(index: int, x: float, run: float, section: str) -> dict:
    def pose(at):
        return {'x': at, 'y': 0, 'z': 0, 'heading': 0, 'pitch': 0}

    def port(at):
        return {'pose': pose(at), 'profile': 'brick', 'railGauge': 40, 'interfaceWidth': 2.4}
    ident = f'main:{index}:printed_straight:0'
    return {'id': ident, 'routeId': 'main', 'sectionId': section, 'family': 'printed_straight',
            'parameters': {'run': run, 'body_width': 63.8, 'base_thickness': 3.2, 'rail_gauge': 40,
                           'rail_interface_width': 2.4, 'rail_height': 6.4, 'connector_version': 1,
                           'fit_adjustment': 0},
            'pose': pose(x), 'interfaceKind': 'rail', 'startPort': port(x), 'endPort': port(x + run),
            'source': 'printed', 'status': 'unverified', 'geometryAvailable': True, 'quantity': 1}


def layout(pieces: list[int]) -> dict:
    """One route of printed straights, a layout piece per entry of `pieces`, printed in that many sections (a long
    piece prints in several). Every section has its own length, so its own CAD build."""
    instances, tiles, x = [], [], 0.
    for number, sections in enumerate(pieces):
        tile = f'piece-{number}'
        tiles.append({'id': tile})
        for section in range(sections):
            run = 40. + 4 * len(instances)
            instances.append(straight(len(instances), x, run, tile if sections == 1 else f'{tile}:{section + 1}'))
            x += run
    ids = [instance['id'] for instance in instances]
    return {'version': 1, 'units': 'mm',
            'project': {'id': str(uuid.uuid4()), 'revision': str(uuid.uuid4()), 'layoutRevision': str(uuid.uuid4()),
                        'name': 'Shelf line'},
            'printer': {'name': 'A1 mini', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL A1M',
                        'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}},
            'mounting': 'reversible',
            'routes': [{'id': 'main', 'name': 'Main', 'points': [{'id': 'a'}, {'id': 'b'}], 'pieces': tiles}],
            'crossings': [], 'cars': [], 'instances': instances, 'requiredPrintedInstanceIds': ids,
            'billOfMaterials': [{'source': 'printed', 'family': 'printed_straight', 'count': len(ids),
                                 'instanceIds': ids}],
            'mountingSiteChecks': [], 'warnings': []}


def coupon() -> dict:
    profile = json.loads(BRICK_PROFILE.read_text())
    return {'kind': 'coupon', 'parts': [{'id': 'brick-end-coupon', 'family': 'brick_end_coupon',
                                         'parameters': {'body_length': profile['sampleLength'],
                                                        'connector_version': profile['version'], 'fit_adjustment': 0},
                                         'part_revision': 'r1', 'layout_revision': 'l1'}],
            'printer': layout([1])['printer']}


def member(root: Path, name: str = 'Ada', **options):
    return signed_in_client(root, ORIGIN, email=f'{name.lower()}@example.com', display_name=name, **options)


def prepare(app, body: dict):
    return app.post('/api/jobs', json=body, headers=session_headers(app, ORIGIN))


def prepare_layout(app, manifest: dict):
    return prepare(app, {'kind': 'layout', 'manifest': manifest})


class Fakes:
    """A worker on `root` whose prepare processes behave as `behaviours` says, by step: 'whole', 'part-<n>' or
    'combined'; 'succeed' otherwise. `ran` lists the steps in the order they started."""

    def __init__(self, root: Path, clock=time.time, oom_kills=lambda: None, **behaviours: str):
        self.root, self.log = root, root / 'prepares.log'
        script = root / 'fake_prepare.py'
        script.write_text(FAKE_PREPARE)
        database = root / 'plateway.db'
        lookup = Jobs(database)

        def command(job_id: str) -> list[str]:
            work = lookup.work(job_id)
            step = 'combined' if work.combine else f"part-{work.part['index']}" if work.part else 'whole'
            return [sys.executable, str(script), str(database), job_id, behaviours.get(step, 'succeed'),
                    str(self.log), str(root / 'exports')]
        self.worker = Worker(database, root / 'exports', root / 'storage', command=command, oom_kills=oom_kills, poll=.05, clock=clock)

    def drain(self) -> None:
        while self.worker.run_once():
            pass

    @property
    def ran(self) -> list[str]:
        return self.log.read_text().split() if self.log.exists() else []


def wait_for(condition, timeout: float = 20.) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, 'timed out'
        time.sleep(.05)


def test_a_second_members_prepare_waits_its_turn_then_runs(tmp_path):
    release = tmp_path / 'release'
    with member(tmp_path, 'Ada') as ada, member(tmp_path, 'Bea') as bea:
        first = prepare_layout(ada, layout([1])).json()
        fakes = Fakes(tmp_path, whole=f'wait:{release}')
        running = threading.Thread(target=fakes.worker.run_once)
        running.start()
        wait_for(lambda: ada.get(f"/api/jobs/{first['id']}").json()['state'] == 'running')
        second = prepare_layout(bea, layout([1]))
        assert second.status_code == 202
        assert second.json()['state'] == 'queued' and second.json()['position'] == 1
        release.touch()
        running.join()
        assert ada.get(f"/api/jobs/{first['id']}").json()['state'] == 'succeeded'
        assert bea.get(f"/api/jobs/{second.json()['id']}").json()['position'] == 0
        fakes.drain()
        done = bea.get(f"/api/jobs/{second.json()['id']}").json()
    assert done['state'] == 'succeeded' and done['packageId'] == 'package-whole'
    assert fakes.ran == ['whole', 'whole']


def test_a_layout_above_the_limit_is_queued_as_parts_split_at_track_joints(tmp_path):
    manifest = layout([1, 2, 1, 1, 2, 1])
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        reply = prepare_layout(app, manifest)
        job = reply.json()
        works = [Jobs(tmp_path / 'plateway.db').work(child) for (child,) in db.connect(tmp_path / 'plateway.db').execute(
            'SELECT id FROM jobs WHERE parent_id = ? ORDER BY part_index', (job['id'],))]
    assert reply.status_code == 202
    assert [part['index'] for part in job['parts']] == [1, 2, 3]
    assert all(part['state'] == 'queued' for part in job['parts'])
    assert job['estimate']['memoryMb'] > THREE_SECTIONS.part_mb and job['estimate']['parts'] == 3
    ids = [instance['id'] for instance in manifest['instances']]
    by_id = {instance['id']: instance for instance in manifest['instances']}
    parts = [work.part['instanceIds'] for work in works]
    # Runs of the route in track order, together the whole layout, each within the limit.
    assert [ident for part in parts for ident in part] == ids
    assert all(BASE_MB + len(part) * SECTION_MB <= THREE_SECTIONS.part_mb for part in parts)
    for before, after in zip(parts, parts[1:]):
        end, start = by_id[before[-1]], by_id[after[0]]
        assert end['endPort']['pose'] == start['startPort']['pose']  # a track joint
        assert end['sectionId'].split(':')[0] != start['sectionId'].split(':')[0]  # between two pieces
    assert all(work.manifest == manifest for work in works)


def test_a_piece_above_the_limit_is_refused_with_the_numbers_and_nothing_is_queued(tmp_path):
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        reply = prepare_layout(app, layout([1, 4, 1]))
    assert reply.status_code == 422
    body = reply.json()
    assert body['limitMb'] == THREE_SECTIONS.part_mb
    assert body['group']['printedParts'] == 4 and body['group']['cadBuilds'] == 4
    assert body['group']['memoryMb'] == BASE_MB + 4 * SECTION_MB
    assert '4 printed parts' in body['detail'] and f'{THREE_SECTIONS.part_mb / 1000:.1f} GB' in body['detail']
    assert db.connect(tmp_path / 'plateway.db').execute('SELECT count(*) FROM jobs').fetchone()[0] == 0


def test_a_layout_prepared_in_three_parts_counts_once_towards_the_daily_limit(tmp_path):
    limits = Limits(part_mb=THREE_SECTIONS.part_mb, layouts_per_day=2)
    with member(tmp_path, job_limits=limits) as app:
        fakes = Fakes(tmp_path)
        assert len(prepare_layout(app, layout([1] * 7)).json()['parts']) == 3
        fakes.drain()
        assert prepare_layout(app, layout([1])).status_code == 202
        fakes.drain()
        third = prepare_layout(app, layout([1]))
    assert third.status_code == 429
    assert 'prepared 2 layouts in the last 24 hours' in third.json()['detail']


def test_parts_run_in_order_and_a_failed_part_fails_the_layout_and_cancels_the_rest(tmp_path):
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        job = prepare_layout(app, layout([1] * 7)).json()
        fakes = Fakes(tmp_path, **{'part-2': 'member-error'})
        fakes.drain()
        done = app.get(f"/api/jobs/{job['id']}").json()
    assert fakes.ran == ['part-1', 'part-2']
    assert [part['state'] for part in done['parts']] == ['succeeded', 'failed', 'cancelled']
    assert done['state'] == 'failed'
    assert done['error'] == 'Part 2 of 3: Give the project a name before preparing plates.'
    assert not (tmp_path / 'exports' / 'package-part-1').exists()  # only a combine step would have used it


def test_a_layout_in_parts_succeeds_only_once_every_part_and_the_combine_step_succeed(tmp_path):
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        failing = prepare_layout(app, layout([1] * 4)).json()
        fakes = Fakes(tmp_path, combined='crash')
        fakes.drain()
        ran = fakes.ran
        failed = app.get(f"/api/jobs/{failing['id']}").json()
        left = [package for package in ('package-part-1', 'package-part-2') if (tmp_path / 'exports' / package).exists()]
        combining = prepare_layout(app, layout([1] * 4)).json()
        Fakes(tmp_path).drain()
        combined = app.get(f"/api/jobs/{combining['id']}").json()
    assert ran == ['part-1', 'part-2', 'combined']
    assert [part['state'] for part in failed['parts']] == ['succeeded', 'succeeded']
    assert [part['packageId'] for part in failed['parts']] == ['package-part-1', 'package-part-2']
    assert failed['state'] == 'failed_system' and failed['packageId'] is None
    # The failed layout's part packages are removed, but never the same-named ones of the layout combining after it.
    assert left == []
    assert combined['state'] == 'succeeded' and combined['packageId'] == 'package-combined'
    assert combined['progress'] == 1


def test_a_second_request_returns_the_members_active_job(tmp_path):
    manifest = layout([1])
    with member(tmp_path) as app:
        first = prepare_layout(app, manifest)
        again = prepare_layout(app, manifest)
        other = prepare(app, coupon())
    assert first.status_code == 202 and again.status_code == 200 and other.status_code == 200
    assert again.json()['id'] == first.json()['id'] == other.json()['id']


def test_the_eleventh_layout_prepare_in_a_day_is_refused_and_system_failures_do_not_count(tmp_path, clock):
    with member(tmp_path, clock=clock) as app:
        crashing = Fakes(tmp_path, whole='crash')
        assert prepare_layout(app, layout([1])).status_code == 202
        crashing.drain()
        fakes = Fakes(tmp_path)
        for _ in range(10):
            assert prepare_layout(app, layout([1])).status_code == 202
            fakes.drain()
            clock.now += 60
        refused = prepare_layout(app, layout([1]))
        samples = prepare(app, coupon())
        fakes.drain()
        clock.now += 24 * 3600 - 10 * 60 + 1
        later = prepare_layout(app, layout([1]))
    assert refused.status_code == 429
    assert refused.json()['detail'] == ('You’ve prepared 10 layouts in the last 24 hours, the daily limit. '
                                        'Try again in about 24 hours.')
    assert samples.status_code == 202  # calibration samples and grade rigs have their own limit
    assert later.status_code == 202


def test_the_print_step_finds_the_active_job_by_project_and_the_prepares_left_until_the_limit_resets(tmp_path, clock):
    with member(tmp_path, clock=clock, job_limits=Limits(layouts_per_day=2)) as app:
        body = {'version': 5, 'id': str(uuid.uuid4()), 'revision': str(uuid.uuid4()), 'name': 'Harbour loop',
                'parentRevision': None, 'provenance': {'account': None}, 'routes': [], 'measurements': {},
                'furniture': [], 'trackSystem': 'brick-v1',
                'connectorFit': {'adjustmentMm': 0, 'settingsKey': None, 'calibrationId': None}}
        saved = app.post('/api/projects', json=body, headers=session_headers(app, ORIGIN)).json()
        manifest = layout([1])
        manifest['project'] = {**manifest['project'], 'id': saved['id'], 'revision': saved['revision']}
        idle = app.get('/api/jobs').json()
        first = prepare_layout(app, manifest).json()
        busy = app.get('/api/jobs').json()
        fakes = Fakes(tmp_path)
        fakes.drain()
        clock.now += 3600
        assert prepare_layout(app, layout([1])).status_code == 202
        fakes.drain()
        spent = app.get('/api/jobs').json()
        refused = prepare_layout(app, layout([1]))
        clock.now += 23 * 3600
        freed = app.get('/api/jobs').json()
    assert idle == {'active': None, 'limits': {'layout': {'limit': 2, 'remaining': 2, 'resetsAt': None},
                                               'sample': {'limit': 20, 'remaining': 20, 'resetsAt': None}}}
    assert busy['active']['id'] == first['id']
    assert (busy['active']['projectId'], busy['active']['projectName']) == (saved['id'], 'Harbour loop')
    assert busy['limits']['layout']['remaining'] == 1
    # The first prepare leaves the rolling 24 hours a day after it was queued.
    assert spent['active'] is None and spent['limits']['layout'] == {'limit': 2, 'remaining': 0,
                                                                     'resetsAt': '2030-03-18T17:46:40+00:00'}
    assert refused.status_code == 429 and refused.json()['resetsAt'] == '2030-03-18T17:46:40+00:00'
    assert freed['limits']['layout']['remaining'] == 1


def test_cancelling_a_queued_job_and_a_running_one_whose_processes_end_without_a_package(tmp_path):
    with member(tmp_path) as app:
        queued = prepare_layout(app, layout([1])).json()
        cancelled = app.delete(f"/api/jobs/{queued['id']}", headers=session_headers(app, ORIGIN)).json()
        assert cancelled['state'] == 'cancelled'
        running = prepare_layout(app, layout([1])).json()
        fakes = Fakes(tmp_path, whole='hang')
        worker = threading.Thread(target=fakes.worker.run_once)
        worker.start()
        slicer = fakes.log.with_suffix('.slicer')
        wait_for(slicer.exists)
        assert app.get(f"/api/jobs/{running['id']}").json()['stage'] == 'cad'
        stopping = app.delete(f"/api/jobs/{running['id']}", headers=session_headers(app, ORIGIN)).json()
        assert stopping['state'] == 'running' and stopping['cancelling']
        worker.join()
        done = app.get(f"/api/jobs/{running['id']}").json()
    assert fakes.ran == ['whole']
    assert done['state'] == 'cancelled' and done['packageId'] is None and not done['cancelling']
    wait_for(lambda: not alive(int(slicer.read_text())))
    assert not list((tmp_path / 'exports').iterdir())


def alive(pid: int) -> bool:
    try:
        finished, _ = os.waitpid(pid, os.WNOHANG)
        return finished == 0
    except ChildProcessError:  # not ours to reap: ask the kernel
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True


def test_cancelling_a_layout_in_parts_cancels_every_part(tmp_path):
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        job = prepare_layout(app, layout([1] * 7)).json()
        fakes = Fakes(tmp_path, **{'part-1': 'hang'})
        worker = threading.Thread(target=fakes.drain)
        worker.start()
        wait_for(fakes.log.with_suffix('.slicer').exists)
        app.delete(f"/api/jobs/{job['id']}", headers=session_headers(app, ORIGIN))
        worker.join()
        done = app.get(f"/api/jobs/{job['id']}").json()
    assert fakes.ran == ['part-1']
    assert done['state'] == 'cancelled'
    assert [part['state'] for part in done['parts']] == ['cancelled'] * 3


def test_a_prepare_killed_while_the_cgroup_counts_an_oom_kill_failed_for_size(tmp_path):
    kills = iter([4, 5])
    with member(tmp_path) as app:
        job = prepare_layout(app, layout([1])).json()
        Fakes(tmp_path, oom_kills=lambda: next(kills), whole='oom').drain()
        done = app.get(f"/api/jobs/{job['id']}").json()
    assert done['state'] == 'failed_too_large'
    assert 'too large' in done['error'] and 'memory' in done['error']


def test_a_stale_running_job_is_requeued_once_then_fails_as_a_system_failure(tmp_path, clock):
    with member(tmp_path, clock=clock) as app:
        job = prepare_layout(app, layout([1])).json()
        jobs = Jobs(tmp_path / 'plateway.db', clock)
        assert jobs.claim() == job['id']  # a worker took it, then died
        clock.now += 119
        jobs.recover()
        assert app.get(f"/api/jobs/{job['id']}").json()['state'] == 'running'
        clock.now += 2
        jobs.recover()
        requeued = app.get(f"/api/jobs/{job['id']}").json()
        assert jobs.claim() == job['id']
        clock.now += 121
        jobs.recover()
        failed = app.get(f"/api/jobs/{job['id']}").json()
        # A system failure is not held against the daily limit.
        again = prepare_layout(app, layout([1]))
    assert requeued['state'] == 'queued' and requeued['position'] == 0
    assert failed['state'] == 'failed_system'
    assert again.status_code == 202


def test_progress_from_the_package_pipeline_shows_in_stage_order(tmp_path):
    with member(tmp_path) as app:
        job = prepare_layout(app, layout([1])).json()
        Fakes(tmp_path).drain()
        done = app.get(f"/api/jobs/{job['id']}").json()
    assert [stage['stage'] for stage in done['stages']] == ['cad', 'arrange', 'slice', 'guide']
    assert done['progress'] == 1


def test_a_member_cannot_read_or_cancel_another_members_job(tmp_path):
    with member(tmp_path, 'Ada') as ada, member(tmp_path, 'Bea') as bea:
        job = prepare_layout(ada, layout([1])).json()
        assert bea.get(f"/api/jobs/{job['id']}").status_code == 404
        assert bea.delete(f"/api/jobs/{job['id']}", headers=session_headers(bea, ORIGIN)).status_code == 404
        assert ada.get(f"/api/jobs/{job['id']}").json()['state'] == 'queued'


def test_a_coupon_cannot_be_queued_as_a_grade_rig(tmp_path):
    with member(tmp_path) as app:
        refused = prepare(app, {**coupon(), 'kind': 'grade'})
        queued = prepare(app, coupon())
    assert refused.status_code == 422 and queued.status_code == 202


def test_a_layout_with_a_community_piece_is_queued_and_prepared_from_the_library_and_a_forged_one_is_refused(tmp_path):
    curve, data = sample_curve()
    storage = open_storage({}, db.storage_root(tmp_path))
    storage.library.put_bytes(curve['file'], data)
    storage.library.put_bytes('index.json', json.dumps({'format': 1, 'items': [curve]}).encode())
    forged = community_only(curve)
    forged['library'][0]['digest'] = 'not-a-sha256'
    database = db.database_path(tmp_path)
    with member(tmp_path) as app:
        assert prepare_layout(app, forged).status_code == 422
        reply = prepare_layout(app, community_only(curve))
        assert reply.status_code == 202, reply.text
        job = reply.json()
        jobs = Jobs(database)
        assert jobs.claim() == job['id']
        # The prepare process reads the library as the worker does (`library_reader`), then publishes the package.
        assert prepare_job.run(jobs, Receipts(database, storage.packages), db.export_root(tmp_path), job['id'],
                               library_reader({}, storage)) == 0
        jobs.finish(job['id'], 'succeeded')
        package_id = app.get(f"/api/jobs/{job['id']}").json()['packageId']
        receipt = app.get(f'/api/packages/{package_id}').json()
    [part] = receipt['parts']
    assert part['library']['credit'] == 'Plateway sample' and part['printDigest'] == curve['digest']
    assert receipt['notes'] == ['Community pieces print as uploaded: print style and fit adjustment don’t apply to them.']


class FailingBucket:
    """A package bucket that is unavailable for uploads."""

    def __init__(self, bucket):
        self.bucket = bucket

    def put_file(self, key, path):
        raise OSError('The bucket is unavailable')

    def delete_prefix(self, prefix):
        self.bucket.delete_prefix(prefix)


def fake_combine(root: Path, manifest: dict, part_packages: list[str], progress, *, taken) -> dict:
    """`combine_parts` without CAD: installs a package folder from the installed part packages."""
    assert all((root / package).is_dir() for package in part_packages)
    package_id = f'combined-{uuid.uuid4().hex}'
    receipt = {'id': package_id, 'status': 'prepared-digital-only', 'plates': [], 'parts': []}
    (root / package_id).mkdir()
    (root / package_id / 'receipt.json').write_text(json.dumps(receipt))
    return receipt


def built_parts(database: Path, exports: Path) -> tuple[Jobs, str, list[str]]:
    """Run every part of the queued layout in parts as a prepare would; returns its combine step, now claimed."""
    jobs = Jobs(database)
    while (job_id := jobs.claim()) is not None and jobs.work(job_id).combine is None:
        package_id = f"package-part-{jobs.work(job_id).part['index']}"
        (exports / package_id).mkdir(parents=True)
        jobs.record_package(job_id, package_id)
        jobs.finish(job_id, 'succeeded')
    return jobs, job_id, jobs.work(job_id).combine


def test_a_combine_keeps_its_parts_until_its_package_is_published(tmp_path, monkeypatch):
    database, exports = db.database_path(tmp_path), db.export_root(tmp_path)
    storage = open_storage({}, db.storage_root(tmp_path))
    monkeypatch.setattr('cad.service.combine.combine_parts', fake_combine)
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        prepare_layout(app, layout([1] * 4))
        jobs, job_id, parts = built_parts(database, exports)
        # The upload fails (a worker restart would do the same): a system failure, and the parts stay for a rerun.
        with pytest.raises(OSError):
            prepare_job.run(jobs, Receipts(database, FailingBucket(storage.packages)), exports, job_id)
        assert all((exports / package).is_dir() for package in parts)
        assert jobs.package(job_id) is None
        assert prepare_job.run(jobs, Receipts(database, storage.packages), exports, job_id) == 0
        package_id = jobs.package(job_id)
        owner = app.get('/api/auth/me').json()['user']['id']
    assert storage.packages.exists(f'packages/{owner}/{package_id}/receipt.json')
    assert parts == ['package-part-1', 'package-part-2'] and not list(exports.iterdir())


@pytest.mark.parametrize('split', [True, False], ids=['combine', 'whole layout'])
def test_a_prepare_that_stops_after_publishing_records_that_package_when_run_again(tmp_path, monkeypatch, split):
    database, exports = db.database_path(tmp_path), db.export_root(tmp_path)
    storage = open_storage({}, db.storage_root(tmp_path))
    monkeypatch.setattr('cad.service.combine.combine_parts', fake_combine)
    monkeypatch.setattr(prepare_job, 'export_package',
                        lambda root, manifest, **_options: (fake_combine(root, manifest, [], None, taken=None), None))
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        prepare_layout(app, layout([1] * 4 if split else [1]))
        if split:
            jobs, job_id, parts = built_parts(database, exports)
        else:
            jobs, parts = Jobs(database), []
            job_id = jobs.claim()
            exports.mkdir(parents=True)
        record = jobs.record_package

        def stopped(*_args):
            raise OSError('The worker restarted')
        # The package is published, then the process stops before its job records it.
        monkeypatch.setattr(jobs, 'record_package', stopped)
        with pytest.raises(OSError):
            prepare_job.run(jobs, Receipts(database, storage.packages), exports, job_id)
        monkeypatch.setattr(jobs, 'record_package', record)
        assert prepare_job.run(jobs, Receipts(database, storage.packages), exports, job_id) == 0
        package_id = jobs.package(job_id)
        owner = app.get('/api/auth/me').json()['user']['id']
        published = [receipt.package_id for receipt in Receipts(database, storage.packages).listed(owner)]
    stored = {path.relative_to(storage.packages.objects).parts[:3] for path in storage.packages.objects.rglob('*')
              if path.is_file()}
    assert published == [package_id] and stored == {('packages', owner, package_id)}
    assert len(parts) == (2 if split else 0) and not list(exports.iterdir())


def test_only_a_members_mistake_fails_a_prepare_as_theirs_and_a_service_fault_fails_as_the_services(tmp_path,
                                                                                                    monkeypatch):
    database, exports = db.database_path(tmp_path), db.export_root(tmp_path)
    receipts = Receipts(database, open_storage({}, db.storage_root(tmp_path)).packages)

    def broken_combine(*_args, **_options):
        raise ValueError('The parts’ plates and pieces do not reconcile')
    monkeypatch.setattr('cad.service.combine.combine_parts', broken_combine)
    with member(tmp_path, job_limits=THREE_SECTIONS) as app:
        prepare_layout(app, layout([1] * 4))
        jobs, job_id, _ = built_parts(database, exports)
        # A combine that does not reconcile is the service's fault: the process fails, so the job is failed_system.
        with pytest.raises(ValueError, match='reconcile'):
            prepare_job.run(jobs, receipts, exports, job_id)
        assert app.get(f'/api/jobs/{job_id}').json()['error'] is None

        def mistaken(*_args, **_options):
            raise UserError('Add at least one printed piece before preparing plates.')
        monkeypatch.setattr('cad.service.combine.combine_parts', mistaken)
        assert prepare_job.run(jobs, receipts, exports, job_id) == prepare_job.MEMBER_ERROR
        mistake = app.get(f'/api/jobs/{job_id}').json()['error']
        # A stored request that no longer validates is refused as the member's.
        with db.connect(database) as conn:
            conn.execute("UPDATE jobs SET manifest = json_set(manifest, '$.mounting', 'glued') WHERE id = ?",
                         (job_id,))
        assert prepare_job.run(jobs, receipts, exports, job_id) == prepare_job.MEMBER_ERROR
        invalid = app.get(f'/api/jobs/{job_id}').json()['error']
    assert mistake == 'Add at least one printed piece before preparing plates.'
    assert invalid == prepare_job.INVALID_REQUEST


class Stop(BaseException):
    pass


def test_the_worker_carries_on_after_a_failing_cycle(tmp_path, monkeypatch):
    with member(tmp_path) as app:
        job = prepare_layout(app, layout([1])).json()
        fakes = Fakes(tmp_path)
        real, calls = fakes.worker.jobs.recover, []

        def recover():
            calls.append(len(calls))
            if len(calls) == 1:
                raise sqlite3.OperationalError('database is locked')
            if len(calls) == 3:
                raise Stop
            real()
        monkeypatch.setattr(fakes.worker.jobs, 'recover', recover)
        with pytest.raises(Stop):
            fakes.worker.run_forever(idle=0)
        done = app.get(f"/api/jobs/{job['id']}").json()
    assert fakes.ran == ['whole'] and done['state'] == 'succeeded'


def test_a_worker_error_while_a_prepare_runs_stops_the_prepare_and_its_slicer(tmp_path, monkeypatch):
    with member(tmp_path) as app:
        prepare_layout(app, layout([1]))
        fakes = Fakes(tmp_path, whole='hang')
        slicer = fakes.log.with_suffix('.slicer')
        real = fakes.worker.jobs.cancel_requested

        def cancel_requested(job_id):
            if slicer.exists():
                raise sqlite3.OperationalError('database is locked')
            return real(job_id)
        monkeypatch.setattr(fakes.worker.jobs, 'cancel_requested', cancel_requested)
        with pytest.raises(sqlite3.OperationalError):
            fakes.worker.run_once()
    wait_for(lambda: not alive(int(slicer.read_text())), timeout=10.)
