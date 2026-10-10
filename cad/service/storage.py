"""Object storage (KTD7, KTD9): one handle per bucket, on R2 (any S3-compatible endpoint) when one is configured,
otherwise folders on local disk for development and tests. Both backends keep the same contract
(`tests/test_storage.py`).

Buckets, by role:
- `packages` (`plateway-packages`): private. Prepared packages live under `packages/<owner>/<package id>/` and a
  lifecycle rule deletes them after `PACKAGE_DAYS` (R12). Their files are downloaded through presigned links valid for
  `PRESIGN_SECONDS`, issued only to the owner (`app.py`).
- `library` (`plateway-library`): public-read community library files and index (KTD9). Nothing in it may expire.
  A prepare reads it through `library_reader`: on S3 over its public URL, so the worker holds no token for it.
- `backups` (`plateway-backups`): private; Litestream's replica of the database (U10).

R2 bucket-scoped tokens cannot read lifecycle rules, so the service never reads them: they are checked before each
deploy, from the laptop with Alex's wrangler login (`python -m cad.service.storage check-r2`, docs/operations.md,
"Deploy"). `check_rules` refuses a library bucket with an expiry rule, and a packages bucket without the
`PACKAGE_DAYS` one; anything in wrangler's listing it does not recognise fails the check.

Configuration (environment):
- `PLATEWAY_S3_ENDPOINT` selects S3, with `PLATEWAY_S3_ACCESS_KEY_ID`, `PLATEWAY_S3_SECRET_ACCESS_KEY` and
  `PLATEWAY_S3_REGION` (default `auto`, as R2 expects);
- `PLATEWAY_PACKAGES_BUCKET`, `PLATEWAY_LIBRARY_BUCKET`, `PLATEWAY_BACKUPS_BUCKET` rename the buckets;
- without an endpoint, each bucket is a folder under the local storage root (`db.storage_root`). A local bucket keeps
  its lifecycle in `lifecycle.json` (packages: `PACKAGE_DAYS`, set when the bucket is first made) and applies it each
  time the bucket is opened. The API serves its presigned links itself, at `LOCAL_URL`.
"""
from __future__ import annotations

import argparse
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from typing import BinaryIO, Protocol
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import uuid

PACKAGE_DAYS = 7
PRESIGN_SECONDS = 15 * 60
DAY = 24 * 3600
ROLES = {'packages': 'plateway-packages', 'library': 'plateway-library', 'backups': 'plateway-backups'}
LOCAL_URL = '/api/storage'
# The library bucket's index of its items (KTD9; src/domain/library.ts reads the same file).
INDEX_KEY = 'index.json'
INDEX_FORMAT = 1
SEGMENT = re.compile(r'[A-Za-z0-9_.-]+\Z')


class StorageError(Exception):
    """Storage is configured in a way the service must not run with."""


class MissingObject(Exception):
    """No object under that key (never stored, deleted or expired)."""


@dataclass(frozen=True)
class ExpiryRule:
    """An enabled lifecycle rule that deletes objects: those under `prefix` after `days` (None: on a fixed date)."""
    prefix: str
    days: int | None


def check_key(key: str) -> str:
    """A key is `/`-separated plain segments: no empty, `.` or `..` segment, nothing a path could escape with."""
    segments = key.split('/') if isinstance(key, str) else []
    if not segments or any(not SEGMENT.fullmatch(part) or part in ('.', '..') for part in segments):
        raise ValueError('Invalid object key')
    return key


def check_prefix(prefix: str) -> str:
    if not isinstance(prefix, str) or not prefix.endswith('/'):
        raise ValueError('A prefix ends with /')
    check_key(prefix[:-1])
    return prefix


def content_type(key: str) -> str:
    return mimetypes.guess_type(key)[0] or 'application/octet-stream'


def disposition(filename: str) -> str:
    """`attachment` under a plain file name, so a download keeps its name even from another origin."""
    return f'attachment; filename="{re.sub(r"[^A-Za-z0-9_.-]", "_", filename) or "download"}"'


class Reader(Protocol):
    def open(self, key: str) -> BinaryIO:
        """A readable stream of the object; `MissingObject` when there is none."""


class Bucket(Protocol):
    name: str

    def put_file(self, key: str, path: Path) -> None: ...

    def put_bytes(self, key: str, data: bytes) -> None: ...

    def open(self, key: str) -> BinaryIO:
        """A readable stream of the object; `MissingObject` when there is none."""

    def exists(self, key: str) -> bool: ...

    def delete_prefix(self, prefix: str) -> int:
        """Delete every object under `prefix` (ending in `/`); returns how many."""

    def presign(self, key: str, filename: str, seconds: int = PRESIGN_SECONDS) -> str:
        """A link that downloads the object as `filename` for `seconds`, to whoever holds it."""


# ------------------------------------------------------------------------------------------------------- local disk


class LocalBucket:
    """A bucket as a folder: objects under `objects/`, the lifecycle in `lifecycle.json`. Objects are opened through
    no-follow descriptors, segment by segment, so a link planted in the folder is never followed."""

    def __init__(self, folder: Path, name: str, secret: bytes, default_days: int | None = None):
        self.name = name
        self.folder = folder
        self.objects = folder / 'objects'
        self.secret = secret
        self.objects.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not (folder / 'lifecycle.json').exists():
            self.set_expiry(default_days)
        self._expire()

    def _expire(self) -> None:
        """What the provider's lifecycle does on R2: delete objects older than the bucket's rule."""
        rules = self.expiry_rules()
        if not rules:
            return
        cutoff = time.time() - min(rule.days or 0 for rule in rules) * DAY
        for path in list(self._files(self.objects)):
            if path.lstat().st_mtime < cutoff:
                path.unlink(missing_ok=True)

    @staticmethod
    def _files(folder: Path) -> Iterator[Path]:
        for directory, _, names in os.walk(folder):
            for name in names:
                yield Path(directory) / name

    def _write(self, key: str, write) -> None:
        segments = check_key(key).split('/')
        directory = self.objects.joinpath(*segments[:-1])
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        staged = directory / f'.upload-{uuid.uuid4().hex}'
        try:
            with open(staged, 'xb') as target:
                write(target)
            os.replace(staged, directory / segments[-1])
        finally:
            staged.unlink(missing_ok=True)

    def put_file(self, key: str, path: Path) -> None:
        with open(path, 'rb') as source:
            self._write(key, lambda target: shutil.copyfileobj(source, target, 1 << 20))

    def put_bytes(self, key: str, data: bytes) -> None:
        self._write(key, lambda target: target.write(data))

    def _open_fd(self, key: str) -> int:
        segments = check_key(key).split('/')
        opened = [os.open(self.objects, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
        try:
            for segment in segments[:-1]:
                opened.append(os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=opened[-1]))
            fd = os.open(segments[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=opened[-1])
        except OSError as exc:
            raise MissingObject(key) from exc
        finally:
            for directory in reversed(opened):
                os.close(directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise MissingObject(key)
        return fd

    def open(self, key: str) -> BinaryIO:
        return os.fdopen(self._open_fd(key), 'rb')

    def exists(self, key: str) -> bool:
        try:
            os.close(self._open_fd(key))
        except MissingObject:
            return False
        return True

    def delete_prefix(self, prefix: str) -> int:
        target = self.objects.joinpath(*check_prefix(prefix)[:-1].split('/'))
        if target.is_symlink() or not target.is_dir():
            return 0
        count = sum(1 for _ in self._files(target))
        shutil.rmtree(target)
        return count

    def _signature(self, key: str, expires: int, filename: str) -> str:
        message = '\n'.join((self.name, key, str(expires), filename)).encode()
        return hmac.new(self.secret, message, hashlib.sha256).hexdigest()

    def presign(self, key: str, filename: str, seconds: int = PRESIGN_SECONDS) -> str:
        expires = int(time.time()) + seconds
        query = urlencode({'expires': expires, 'filename': filename,
                           'signature': self._signature(check_key(key), expires, filename)})
        return f'{LOCAL_URL}/{quote(self.name)}/{quote(key)}?{query}'

    def open_signed(self, key: str, expires: int, filename: str, signature: str) -> BinaryIO:
        """The object behind a link `presign` made, while it is valid; `MissingObject` for anything else."""
        try:
            expected = self._signature(check_key(key), expires, filename)
        except ValueError as exc:
            raise MissingObject(key) from exc
        if not hmac.compare_digest(expected, signature) or expires < time.time():
            raise MissingObject(key)
        return self.open(key)

    def expiry_rules(self) -> list[ExpiryRule]:
        days = json.loads((self.folder / 'lifecycle.json').read_text()).get('expireDays')
        return [ExpiryRule('', days)] if days is not None else []

    def set_expiry(self, days: int | None) -> None:
        (self.folder / 'lifecycle.json').write_text(json.dumps({} if days is None else {'expireDays': days}))


# ----------------------------------------------------------------------------------------------- S3 (R2, MinIO)


class S3Bucket:
    def __init__(self, client, name: str):
        self.client = client
        self.name = name

    @staticmethod
    def _missing(exc: Exception) -> bool:
        code = getattr(exc, 'response', {}).get('Error', {}).get('Code')
        return code in ('NoSuchKey', '404', 'NotFound')

    def put_file(self, key: str, path: Path) -> None:
        self.client.upload_file(str(path), self.name, check_key(key), ExtraArgs={'ContentType': content_type(key)})

    def put_bytes(self, key: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.name, Key=check_key(key), Body=data, ContentType=content_type(key))

    def open(self, key: str) -> BinaryIO:
        from botocore.exceptions import ClientError
        try:
            return self.client.get_object(Bucket=self.name, Key=check_key(key))['Body']
        except ClientError as exc:
            if self._missing(exc):
                raise MissingObject(key) from exc
            raise

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.head_object(Bucket=self.name, Key=check_key(key))
        except ClientError as exc:
            if self._missing(exc):
                return False
            raise
        return True

    def delete_prefix(self, prefix: str) -> int:
        count = 0
        pages = self.client.get_paginator('list_objects_v2').paginate(Bucket=self.name, Prefix=check_prefix(prefix))
        for page in pages:
            keys = [{'Key': item['Key']} for item in page.get('Contents', [])]
            if keys:  # a page holds at most 1000 keys, the most one delete takes
                self.client.delete_objects(Bucket=self.name, Delete={'Objects': keys, 'Quiet': True})
                count += len(keys)
        return count

    def presign(self, key: str, filename: str, seconds: int = PRESIGN_SECONDS) -> str:
        return self.client.generate_presigned_url(
            'get_object', ExpiresIn=seconds,
            Params={'Bucket': self.name, 'Key': check_key(key), 'ResponseContentDisposition': disposition(filename)})


# ------------------------------------------------------------------------------------------- public, read-only


class PublicBucket:
    """A public-read bucket read over HTTP(S) at its public URL, with no token: how a hosted prepare reads the
    community library (`library_reader`). A missing object (404, or the 403 a public bucket may answer) is
    `MissingObject`."""

    def __init__(self, url: str, timeout: float = 60.):
        self.name = url
        self.url = url.rstrip('/') + '/'
        self.timeout = timeout

    def open(self, key: str) -> BinaryIO:
        try:
            return urlopen(Request(self.url + quote(check_key(key)), headers={'User-Agent': 'plateway-worker'}),
                           timeout=self.timeout)
        except HTTPError as exc:
            if exc.code in (403, 404):
                raise MissingObject(key) from exc
            raise


# ------------------------------------------------------------------------------------------------------- storage


@dataclass(frozen=True)
class Storage:
    packages: Bucket
    library: Bucket
    backups: Bucket

    def local(self, name: str) -> LocalBucket | None:
        """The local bucket called `name`, whose presigned links the API serves; None on S3."""
        return next((bucket for bucket in (self.packages, self.library, self.backups)
                     if isinstance(bucket, LocalBucket) and bucket.name == name), None)


def open_storage(environ: Mapping[str, str], local_root: Path) -> Storage:
    names = {role: environ.get(f'PLATEWAY_{role.upper()}_BUCKET', default) for role, default in ROLES.items()}
    endpoint = environ.get('PLATEWAY_S3_ENDPOINT')
    if endpoint:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            's3', endpoint_url=endpoint, region_name=environ.get('PLATEWAY_S3_REGION', 'auto'),
            aws_access_key_id=environ.get('PLATEWAY_S3_ACCESS_KEY_ID'),
            aws_secret_access_key=environ.get('PLATEWAY_S3_SECRET_ACCESS_KEY'),
            config=Config(signature_version='s3v4', s3={'addressing_style': 'path'},
                          retries={'max_attempts': 5, 'mode': 'standard'}))
        return Storage(**{role: S3Bucket(client, name) for role, name in names.items()})
    secret = secrets.token_bytes(32)
    local_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return Storage(**{role: LocalBucket(local_root / name, name, secret, PACKAGE_DAYS if role == 'packages' else None)
                      for role, name in names.items()})


def library_reader(environ: Mapping[str, str], storage: Storage) -> Reader:
    """Where a prepare reads the community library (KTD9): the library bucket itself when it is a local folder; on
    S3, its public URL `PLATEWAY_LIBRARY_URL`, since the worker's token covers only the packages bucket."""
    if isinstance(storage.library, LocalBucket):
        return storage.library
    url = environ.get('PLATEWAY_LIBRARY_URL')
    if not url:
        raise StorageError('Set PLATEWAY_LIBRARY_URL: a prepare reads the community library from its public URL.')
    return PublicBucket(url)


def check_rules(library: list[ExpiryRule], packages: list[ExpiryRule], library_name: str = ROLES['library'],
                packages_name: str = ROLES['packages']) -> None:
    """Refuse a library bucket that expires anything, or a packages bucket that keeps packages for any other time
    than `PACKAGE_DAYS` (R12)."""
    if library:
        raise StorageError(f'The library bucket {library_name} has an expiry rule; library files must never '
                           'expire. Remove its lifecycle rule.')
    if not any(rule.days == PACKAGE_DAYS and 'packages/'.startswith(rule.prefix) for rule in packages) or any(
            rule.days != PACKAGE_DAYS for rule in packages):
        raise StorageError(f'The packages bucket {packages_name} needs one lifecycle rule deleting every '
                           f'object after {PACKAGE_DAYS} days.')


# ------------------------------------------------------------------------------------- deploy-time check (wrangler)

ANSI = re.compile(r'\x1b\[[0-9;]*m')
FIELDS = ('name', 'enabled', 'prefix', 'action')
NOT_EXPIRING = re.compile(r'(Abort incomplete multipart uploads|Transition to Infrequent Access) (after \d+ days|on '
                          r'\d{4}-\d{2}-\d{2})|\(none\)')


def parse_wrangler_lifecycle(output: str, bucket: str) -> list[ExpiryRule]:
    """The expiry rules in what `wrangler r2 bucket lifecycle list <bucket>` prints (it has no JSON output): blocks
    of `name:`, `enabled:`, `prefix:` and `action:` lines, an action being comma-separated `Expire objects after N
    days` / `on <date>`, `Abort incomplete multipart uploads …` or `Transition to Infrequent Access …`. Anything else
    raises `StorageError`, so a listing this does not understand never passes."""
    def refuse(why: str) -> StorageError:
        return StorageError(f"Cannot read the lifecycle rules wrangler listed for bucket '{bucket}': {why}")

    lines = ANSI.sub('', output).splitlines()
    heading = f"Listing lifecycle rules for bucket '{bucket}'..."
    if heading not in lines:
        raise refuse(f'no line "{heading}".')
    lines = [line.strip() for line in lines[lines.index(heading) + 1:] if line.strip()]
    if lines == [f"There are no lifecycle rules for bucket '{bucket}'."]:
        return []
    found = []
    for start in range(0, len(lines), len(FIELDS)):
        rule = {}
        for field, line in zip(FIELDS, lines[start:start + len(FIELDS)]):
            label, colon, value = line.partition(':')
            if label != field or not colon:
                raise refuse(f'expected a "{field}:" line, got "{line}".')
            rule[field] = value.strip()
        if len(rule) != len(FIELDS):
            raise refuse(f'rule "{rule.get("name")}" has no {FIELDS[len(rule)]} line.')
        if rule['enabled'] not in ('Yes', 'No'):
            raise refuse(f'rule "{rule["name"]}" is enabled "{rule["enabled"]}".')
        prefix = '' if rule['prefix'] == '(all prefixes)' else rule['prefix']
        for action in rule['action'].split(', '):
            expiry = re.fullmatch(r'Expire objects (?:after (\d+) days|on \d{4}-\d{2}-\d{2})', action)
            if expiry is None and not NOT_EXPIRING.fullmatch(action):
                raise refuse(f'rule "{rule["name"]}" has the unknown action "{action}".')
            if expiry is not None and rule['enabled'] == 'Yes':
                found.append(ExpiryRule(prefix, int(expiry[1]) if expiry[1] else None))
    return found


def wrangler_expiry_rules(bucket: str) -> list[ExpiryRule]:
    """The bucket's expiry rules as wrangler lists them, with the laptop's wrangler login."""
    try:
        listed = subprocess.run(['npx', 'wrangler', 'r2', 'bucket', 'lifecycle', 'list', bucket],
                                capture_output=True, text=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StorageError(f'Cannot run npx wrangler for bucket {bucket}: {exc}') from exc
    if listed.returncode != 0:
        raise StorageError(f'wrangler failed listing the lifecycle rules of bucket {bucket} (exit '
                           f'{listed.returncode}):\n{ANSI.sub("", listed.stderr or listed.stdout).strip()}')
    return parse_wrangler_lifecycle(listed.stdout, bucket)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='python -m cad.service.storage')
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check-r2', help="check the R2 buckets' lifecycle rules with wrangler (before a deploy)")
    check.add_argument('--library', default=ROLES['library'])
    check.add_argument('--packages', default=ROLES['packages'])
    args = parser.parse_args(argv)
    try:
        check_rules(wrangler_expiry_rules(args.library), wrangler_expiry_rules(args.packages),
                    library_name=args.library, packages_name=args.packages)
    except StorageError as exc:
        print(exc, file=sys.stderr)
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
