"""Service test helpers: a client signed in as a verified member through the real sign-up flow and the mail file sink,
and packages published for that member."""
from contextlib import contextmanager
import json
from pathlib import Path
import re
import time

from fastapi.testclient import TestClient

from cad.service import db
from cad.service.app import create_app
from cad.service.mailer import FileSink
from cad.service.receipts import Receipt, Receipts
from cad.service.storage import open_storage

EMAIL = 'member@example.com'
PASSWORD = 'correct horse battery'


@contextmanager
def signed_in_client(root: Path, origin: str, *, email: str = EMAIL, display_name: str = 'Member', **options):
    """Signs up and verifies on a fresh root; on a root that already has the member (its name is taken), signs in.
    Another `email` and `display_name` sign in a second member on the same root."""
    mail = root / 'mail'
    app = create_app(root, allowed_origin=origin, mailer=FileSink(mail), **options)
    with TestClient(app, base_url=origin) as client:
        headers = {'Origin': origin}
        account = {'email': email, 'password': PASSWORD}
        created = client.post('/api/auth/signup', json={**account, 'displayName': display_name}, headers=headers)
        assert created.status_code in (202, 409), created.text
        verify = created.status_code == 202 and re.search(
            r'#verify=([\w-]+)', json.loads(sorted(mail.glob('*.json'))[-1].read_text())['text'])
        signed = client.post('/api/auth/login', json=account, headers=headers)
        assert signed.status_code == 200, signed.text
        if verify:  # a verify link verifies only; the browser's own session stays signed in
            verified = client.post('/api/auth/verify-email', json={'token': verify.group(1)},
                                   headers={**headers, 'X-Workshop-Session': signed.json()['csrf']})
            assert verified.status_code == 200 and verified.json()['signedIn'] is True, verified.text
        yield client


def session_headers(client: TestClient, origin: str) -> dict[str, str]:
    """What the browser app sends on a mutation: its Origin and the session's CSRF token."""
    return {'Origin': origin, 'X-Workshop-Session': client.get('/api/auth/me').json()['csrf']}


def publish_package(client: TestClient, root: Path, receipt: dict, files: dict[str, bytes] | None = None, *,
                    kind: str = 'layout', job_id: str | None = None, clock=time.time) -> Receipt:
    """Publish a package for the signed-in member as `prepare_job` does: its folder (`receipt.json` and `files`) is
    uploaded to the root's local storage, its receipt stored and the folder removed."""
    owner = client.get('/api/auth/me').json()['user']['id']
    folder = root / 'built' / receipt['id']
    for name, data in {**(files or {}), 'receipt.json': json.dumps(receipt).encode()}.items():
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
    receipts = Receipts(db.database_path(root), open_storage({}, db.storage_root(root)).packages, clock)
    return receipts.publish(owner, job_id, kind, folder)
