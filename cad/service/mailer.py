"""Outgoing account email: Cloudflare Email Sending when configured, otherwise a file sink for tests and local use.

`from_env` picks the sender. `PLATEWAY_MAILER=cloudflare` needs `CLOUDFLARE_EMAIL_TOKEN` (an account API token with
the Email Sending send permission), `CLOUDFLARE_ACCOUNT_ID` and `PLATEWAY_MAIL_FROM` (optional:
`PLATEWAY_MAIL_FROM_NAME`, default `Plateway`). Anything else writes each message as a JSON file into
`PLATEWAY_MAIL_DIR` (default: the caller's directory).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import itertools
import json
import logging
import os
from pathlib import Path
import time
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid

log = logging.getLogger('cad.service.mailer')
CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    text: str
    # Where a reply goes instead of the sender (feedback: the address its author gave); None replies to the sender.
    reply_to: str | None = None


class MailError(RuntimeError):
    """The message was not accepted for delivery."""


class Mailer(Protocol):
    def send(self, message: Message) -> None: ...


class FileSink:
    """Writes each message to `<directory>/<sequence>.json` (`to`, `subject`, `text`, and `reply_to` when set),
    readable only by the owner."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)

    def send(self, message: Message) -> None:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Wall-clock nanoseconds then a per-process counter, so the files list in sending order.
        name = f'{time.time_ns():020d}-{next(_sent):08d}-{uuid.uuid4().hex[:8]}.json'
        fd = os.open(self.directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump({'to': message.to, 'subject': message.subject, 'text': message.text,
                       **({'reply_to': message.reply_to} if message.reply_to else {})}, target, ensure_ascii=False)
        log.info('Mail "%s" written to the file sink as %s', message.subject, name)


_sent = itertools.count()


class CloudflareEmail:
    """Sends through the Cloudflare Email Sending API, one recipient per message.

    A message counts as sent only when Cloudflare reports its recipient delivered or queued: any non-2xx answer,
    `success: false`, a permanent bounce or a missing recipient raises `MailError`. Errors carry Cloudflare's status
    and error codes, never the API token or the message text.
    """

    def __init__(self, *, api_token: str, account_id: str, sender: str, sender_name: str = 'Plateway',
                 api_base: str = CLOUDFLARE_API):
        self._api_token = api_token
        self.sender = sender
        self.sender_name = sender_name
        self.url = f'{api_base.rstrip("/")}/accounts/{account_id}/email/sending/send'

    def send(self, message: Message) -> None:
        body = json.dumps({'to': message.to, 'from': {'address': self.sender, 'name': self.sender_name},
                           'subject': message.subject, 'text': message.text,
                           **({'reply_to': message.reply_to} if message.reply_to else {})}).encode()
        request = Request(self.url, data=body, method='POST',
                          headers={'Authorization': f'Bearer {self._api_token}', 'Content-Type': 'application/json'})
        refused = f'Cloudflare Email refused "{message.subject}"'
        try:
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                reply = _json(response.read())
        except HTTPError as exc:
            try:
                detail = _errors(_json(exc.read()))
            except OSError:
                detail = ''
            raise MailError(f'{refused}: HTTP {exc.code}{detail}') from None
        except (URLError, OSError) as exc:
            # A socket error never contains the message text or the API token.
            raise MailError(f'{refused}: {exc}') from None
        if not isinstance(reply, dict) or reply.get('success') is not True:
            raise MailError(f'{refused}: not successful{_errors(reply)}')
        result = reply.get('result') if isinstance(reply.get('result'), dict) else {}
        if message.to in (result.get('permanent_bounces') or []):
            raise MailError(f'{refused}: permanent bounce')
        if message.to not in (result.get('delivered') or []) + (result.get('queued') or []):
            raise MailError(f'{refused}: recipient not accepted')
        log.info('Mail "%s" sent through Cloudflare Email', message.subject)


def _json(raw: bytes) -> object:
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _errors(reply: object) -> str:
    """Cloudflare's error codes and messages, e.g. ` (10102 email.sending.error.forbidden)`; empty when it gave none."""
    errors = reply.get('errors') if isinstance(reply, dict) else None
    described = [f'{error.get("code")} {error.get("message")}' for error in errors or [] if isinstance(error, dict)]
    return f' ({"; ".join(described)})' if described else ''


def from_env(environ: Mapping[str, str], default_directory: Path | None) -> Mailer:
    if environ.get('PLATEWAY_MAILER') == 'cloudflare':
        required = ('CLOUDFLARE_EMAIL_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'PLATEWAY_MAIL_FROM')
        missing = [name for name in required if not environ.get(name)]
        if missing:
            raise ValueError(f'PLATEWAY_MAILER=cloudflare needs {", ".join(missing)}')
        return CloudflareEmail(api_token=environ['CLOUDFLARE_EMAIL_TOKEN'], account_id=environ['CLOUDFLARE_ACCOUNT_ID'],
                               sender=environ['PLATEWAY_MAIL_FROM'],
                               sender_name=environ.get('PLATEWAY_MAIL_FROM_NAME') or 'Plateway')
    directory = environ.get('PLATEWAY_MAIL_DIR') or default_directory
    if directory is None:
        raise ValueError('Set PLATEWAY_MAIL_DIR or PLATEWAY_MAILER=cloudflare')
    return FileSink(Path(directory))
