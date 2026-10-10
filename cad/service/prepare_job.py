"""`python -m cad.service.prepare_job --database <db> --exports <root> --storage <local storage> <job id>`: run one
claimed job (KTD5).

The worker (`worker.py`) starts this in a fresh process and session per job, so a prepare's memory is returned when it
ends and the worker can kill it with its slicer. It builds the package in the export root, publishes it to storage
with its receipt (`receipts.py`; a part of a layout in parts stays local for its layout's combine step, which removes
the parts once their combined package is published), reports progress, then the package id, to the job row. A job
publishes one package: run again after it published but before it recorded the id (a worker restart), it records the
package it published and builds nothing. The worker records the outcome from the exit status:

- 0: the package is published and its id recorded;
- `MEMBER_ERROR` (3): a problem the member can fix (a `UserError`, or a request that fails validation), its message
  recorded;
- anything else: a system failure, logged here; it does not count towards the member's daily limit.
"""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import resource
import shutil
import signal
import sys

from cad.service.errors import UserError
from cad.service.jobs import INVALID_REQUEST, MEMBER_ERROR, Jobs
from cad.service.package import export_package, export_trial, validate_manifest, validate_trial
from cad.service.receipts import Receipts
from cad.service.storage import Reader, library_reader, open_storage

log = logging.getLogger('cad.service.prepare_job')


def run(jobs: Jobs, receipts: Receipts, root: Path, job_id: str, library: Reader | None = None) -> int:
    """`library`: where a layout's community pieces are read from (`storage.library_reader`)."""
    work = jobs.work(job_id)

    def progress(stage: str, done: int, total: int) -> None:
        jobs.progress(job_id, stage, done, total)

    try:
        if work.owner is None:
            raise ValueError('The account that queued this prepare is gone')
        if work.kind == 'layout':
            validate_manifest(work.manifest)
        else:
            validate_trial(work.payload['parts'], work.payload['printer'])
    except UserError as exc:
        jobs.record_error(job_id, str(exc))
        return MEMBER_ERROR
    except (ValueError, KeyError, TypeError) as exc:
        log.warning('Prepare job %s rejected', job_id, exc_info=exc)
        jobs.record_error(job_id, INVALID_REQUEST)
        return MEMBER_ERROR
    # The request is valid: from here only a `UserError` is the member's to fix. Any other error (a combine that does
    # not reconcile, a publish that fails) is the service's: it ends the process as a system failure.
    try:
        # A run that stopped after publishing, before recording its package below, publishes nothing again.
        package_id = receipts.published(job_id)
        if package_id is None:
            if work.combine is not None:
                # U8: one package from the parts' packages, plate numbers continuous across them.
                from cad.service.combine import combine_parts
                receipt = combine_parts(root, work.manifest, work.combine, progress, taken=receipts.taken)
            elif work.kind == 'layout':
                receipt, _ = export_package(root, work.manifest, part=work.part, progress=progress,
                                            taken=receipts.taken, library=library)
            else:
                receipt, _ = export_trial(root, work.payload['parts'], work.payload['printer'], progress,
                                          taken=receipts.taken)
            if work.part is None:
                receipts.publish(work.owner, job_id, work.kind, root / receipt['id'])
            package_id = receipt['id']
    except UserError as exc:
        jobs.record_error(job_id, str(exc))
        return MEMBER_ERROR
    jobs.record_package(job_id, package_id)
    # Only now are the parts no longer needed: a combine interrupted before this runs again from them.
    for part_package in work.combine or ():
        shutil.rmtree(root / part_package, ignore_errors=True)
    return 0


def _peak_mb(who: int) -> int:
    """Peak resident memory of this process (`RUSAGE_SELF`) or its largest finished child (the slicer), in MB."""
    peak = resource.getrusage(who).ru_maxrss
    return peak // (1 << 20) if sys.platform == 'darwin' else peak // 1024


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    parser = argparse.ArgumentParser(prog='python -m cad.service.prepare_job')
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--exports', type=Path, required=True)
    parser.add_argument('--storage', type=Path, required=True)
    parser.add_argument('job')
    args = parser.parse_args(argv)
    # A cancel arrives as SIGTERM: unwind, so the package build removes its staging folder.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(128 + signal.SIGTERM))
    try:
        storage = open_storage(os.environ, args.storage)
        receipts = Receipts(args.database, storage.packages)
        return run(Jobs(args.database), receipts, args.exports, args.job, library_reader(os.environ, storage))
    finally:
        log.info('Job %s peak memory: %d MB, slicer %d MB', args.job, _peak_mb(resource.RUSAGE_SELF),
                 _peak_mb(resource.RUSAGE_CHILDREN))


if __name__ == '__main__':
    sys.exit(main())
