"""The library bot (R18, KTD10): a GitHub App installed only on the public library repository turns approved uploads
into pull requests, and a poll of those pull requests moves each submission on. There is no webhook.

`GitHubApp` is the client. It signs a 9-minute App JWT (RS256), trades it for an installation token restricted to the
library repository and keeps the token until 5 minutes before it expires. Tokens are opaque: nothing here assumes
their length or shape, and neither they, the JWT nor the private key are ever logged. Requests run one at a time (one
lock), at least `MUTATION_GAP` apart when they write, and honour rate limits: a 429, or a 403 for a secondary or
exhausted rate limit, waits for `retry-after` (else until `x-ratelimit-reset`, else a minute, doubling) and retries.

`LibraryBot` runs in the API process, on a thread (`app.py`). Each cycle it
1. commits each approved submission through the Git data API (blobs, a tree on the default branch's head, a commit,
   the `submissions/<id>` ref) and opens its pull request, then records `pr_open`. The commit, the pull request and
   its body name the contributor by display name only;
2. closes the pull request of a submission Alex rejected in Plateway after approving it, with his reason as the
   comment (`closed`), and of one withdrawn by an account deletion (it stays `withdrawn`). A pull request merged
   meanwhile cannot be closed: its files are public, so the submission becomes `merged` and is published like any
   merge, with an audit row (`submission_rejected_after_merge` or `submission_withdrawn_after_merge`); Alex takes it
   down with Remove;
3. deletes removed items' files from the repository's current tree (a direct commit on the default branch);
4. every `every` seconds (5 minutes), polls each `pr_open` pull request with its ETag. A 304 means unchanged and does
   not count against the rate limit. A merge moves the submission to `merged`, and its file, after checking the
   merge commit holds the approved bytes, is published (`library_publish.py`), making the item live. A close without
   merge moves it to `closed`, shown to the contributor as rejected, with the closing comment as its reason. A pull
   request's ETag is stored only with its outcome, so a failure part-way is retried on the next poll. The poll then
   reads the default branch's tree (also with an ETag) and retires live items whose files are gone (a revert).

Approvals, rejections of open pull requests, removals and account deletions wake the bot, so steps 1-3 happen within
seconds; merges and closes on GitHub show within one poll.

Configuration (environment, `github_from_env`): `PLATEWAY_GITHUB_APP_ID`, `PLATEWAY_GITHUB_APP_PRIVATE_KEY` (the
App's PEM private key, as is or base64-encoded on one line) and `PLATEWAY_GITHUB_REPO` (`owner/name`). Without them
there is no bot, and approved uploads wait as `approved`.
"""
from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from cad.service import db
from cad.service.library_publish import FIRST_VERSION, NOUNS, Library, LibraryError, item_folder, repo_files
from cad.service.submissions import REASON_MAX, Submissions

log = logging.getLogger('cad.service.github_app')

API = 'https://api.github.com'
API_VERSION = '2022-11-28'
USER_AGENT = 'plateway-library-bot'
POLL_SECONDS = 5 * 60
JWT_SECONDS = 9 * 60
JWT_SKEW = 60
TOKEN_MARGIN = 5 * 60
# GitHub asks integrations to space out writes; at least a second apart avoids most secondary rate limits.
MUTATION_GAP = 1.0
ATTEMPTS = 5
FIRST_BACKOFF = 60.0
TIMEOUT = 30.0
BRANCH_PREFIX = 'submissions/'
CLOSED_REASON = 'The pull request was closed without merging.'
WITHDRAWN_COMMENT = 'Withdrawn: the contributor deleted their Plateway account.'
COMMENT_WINDOW = 3600
# After a failed cycle, wait at least this long unless something wakes the bot.
RETRY_SECONDS = 60.0


class GitHubError(Exception):
    """GitHub refused a request, or kept rate-limiting it; `status` 0 is a network failure."""

    def __init__(self, status: int, message: str):
        super().__init__(f'GitHub answered {status}: {message}' if status else message)
        self.status = status


@dataclass(frozen=True)
class Reply:
    status: int
    headers: Mapping[str, str]  # lowercase names
    body: bytes

    def json(self):
        return json.loads(self.body) if self.body else None

    @property
    def message(self) -> str:
        try:
            data = self.json()
        except ValueError:
            return self.body[:200].decode(errors='replace')
        return str(data.get('message', '')) if isinstance(data, dict) else ''


# (method, url, headers, body) -> reply, for any status; raises OSError when the request can't be made.
Transport = Callable[[str, str, Mapping[str, str], bytes | None], Reply]


def urllib_transport(timeout: float = TIMEOUT) -> Transport:
    def send(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> Reply:
        request = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return Reply(response.status, {k.lower(): v for k, v in response.headers.items()}, response.read())
        except HTTPError as error:
            with error:
                return Reply(error.code, {k.lower(): v for k, v in error.headers.items()}, error.read())
    return send


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def load_private_key(text: str) -> rsa.RSAPrivateKey:
    """The App's private key from its PEM, given as is or base64-encoded on one line."""
    pem = text.strip().encode()
    if not pem.startswith(b'-----BEGIN'):
        pem = base64.b64decode(pem, validate=True)
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError('The GitHub App private key is not an RSA key.')
    return key


def app_jwt(app_id: str, key: rsa.RSAPrivateKey, now: float) -> str:
    """The App's JWT: issued a minute in the past for clock drift, expiring within GitHub's 10-minute limit."""
    header = _b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    claims = _b64url(json.dumps({'iat': int(now) - JWT_SKEW, 'exp': int(now) + JWT_SECONDS, 'iss': str(app_id)}).encode())
    signature = key.sign(f'{header}.{claims}'.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f'{header}.{claims}.{_b64url(signature)}'


def blob_sha(data: bytes) -> str:
    """Git's object id for a file with these bytes."""
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def _expiry(text: str) -> float:
    return datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp()


class GitHubApp:
    def __init__(self, app_id: str, private_key: rsa.RSAPrivateKey, repo: str, *, api: str = API,
                 transport: Transport | None = None, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        owner, _, name = repo.partition('/')
        if not owner or not name or '/' in name:
            raise ValueError('The library repository must be "owner/name".')
        self.app_id = str(app_id)
        self._key = private_key
        self.owner, self.name = owner, name
        self.api = api.rstrip('/')
        self.transport = transport or urllib_transport()
        self.clock = clock
        self.sleep = sleep
        self._lock = threading.Lock()
        self._token: tuple[str, float] | None = None
        self._installation: int | None = None
        self._default_branch: str | None = None
        self._last_write = float('-inf')

    def __repr__(self) -> str:  # never the key or a token
        return f'GitHubApp({self.owner}/{self.name})'

    @property
    def repo_path(self) -> str:
        return f'/repos/{self.owner}/{self.name}'

    # ------------------------------------------------------------------------------------------------ requests

    def _wait(self, reply: Reply, attempt: int) -> float | None:
        """How long to wait before retrying `reply`, or None when it is not a rate limit or a passing failure."""
        headers = reply.headers
        limited = reply.status == 429 or (reply.status == 403 and (
            'retry-after' in headers or headers.get('x-ratelimit-remaining') == '0' or 'rate limit' in reply.message.lower()))
        if limited:
            if 'retry-after' in headers:
                try:
                    return max(0.0, float(headers['retry-after']))
                except ValueError:
                    pass
            if headers.get('x-ratelimit-remaining') == '0' and headers.get('x-ratelimit-reset', '').isdigit():
                return max(0.0, int(headers['x-ratelimit-reset']) - self.clock()) + 1
            return FIRST_BACKOFF * 2 ** attempt
        if reply.status in (502, 503, 504):
            return 2.0 ** attempt
        return None

    def _send(self, method: str, path: str, *, body: object = None, etag: str | None = None) -> Reply:
        """One request with the installation token, retried through rate limits; returns a 2xx or 304 reply, else
        raises `GitHubError`."""
        with self._lock:
            refreshed = False
            for attempt in range(ATTEMPTS):
                headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION,
                           'User-Agent': USER_AGENT, 'Authorization': f'Bearer {self._installation_token()}'}
                data = None
                if body is not None:
                    data = json.dumps(body).encode()
                    headers['Content-Type'] = 'application/json'
                if etag:
                    headers['If-None-Match'] = etag
                if method != 'GET':
                    gap = self._last_write + MUTATION_GAP - self.clock()
                    if gap > 0:
                        self.sleep(gap)
                    self._last_write = self.clock()
                try:
                    reply = self.transport(method, self.api + path, headers, data)
                except OSError as exc:
                    raise GitHubError(0, f'GitHub could not be reached: {type(exc).__name__}') from None
                if 200 <= reply.status < 300 or reply.status == 304:
                    return reply
                if reply.status == 401 and not refreshed:
                    # The token was revoked or expired early: fetch a new one once.
                    self._token, refreshed = None, True
                    continue
                wait = self._wait(reply, attempt)
                if wait is None or attempt == ATTEMPTS - 1:
                    break
                log.warning('GitHub answered %s to %s %s; retrying in %.0f s', reply.status, method, path.split('?')[0], wait)
                self.sleep(wait)
            raise GitHubError(reply.status, f'{method} {path.split("?")[0]}: {reply.message}')

    def _jwt(self) -> str:
        return app_jwt(self.app_id, self._key, self.clock())

    def _installation_token(self) -> str:
        now = self.clock()
        if self._token and self._token[1] - TOKEN_MARGIN > now:
            return self._token[0]
        if self._installation is None:
            self._installation = int(self._as_app('GET', f'{self.repo_path}/installation')['id'])
        granted = self._as_app('POST', f'/app/installations/{self._installation}/access_tokens',
                               {'repositories': [self.name]})
        self._token = (granted['token'], _expiry(granted['expires_at']))
        return self._token[0]

    def _as_app(self, method: str, path: str, body: object = None):
        """A request as the App itself (its JWT), made while `_send` holds the lock; not retried."""
        headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION,
                   'User-Agent': USER_AGENT, 'Authorization': f'Bearer {self._jwt()}'}
        data = None
        if body is not None:
            data, headers['Content-Type'] = json.dumps(body).encode(), 'application/json'
        try:
            reply = self.transport(method, self.api + path, headers, data)
        except OSError as exc:
            raise GitHubError(0, f'GitHub could not be reached: {type(exc).__name__}') from None
        if not 200 <= reply.status < 300:
            raise GitHubError(reply.status, f'{method} {path}: {reply.message}')
        return reply.json()

    def call(self, method: str, path: str, body: object = None):
        return self._send(method, path, body=body).json()

    # ----------------------------------------------------------------------------------------- repository work

    def default_branch(self) -> str:
        if self._default_branch is None:
            self._default_branch = self.call('GET', self.repo_path)['default_branch']
        return self._default_branch

    def _head(self) -> tuple[str, str]:
        """The default branch's head commit and its tree."""
        branch = self.default_branch()
        head = self.call('GET', f'{self.repo_path}/git/ref/heads/{quote(branch)}')['object']['sha']
        return head, self.call('GET', f'{self.repo_path}/git/commits/{head}')['tree']['sha']

    def _commit(self, parent: str, base_tree: str, entries: list[dict], message: str) -> str:
        tree = self.call('POST', f'{self.repo_path}/git/trees', {'base_tree': base_tree, 'tree': entries})['sha']
        return self.call('POST', f'{self.repo_path}/git/commits', {'message': message, 'tree': tree, 'parents': [parent]})['sha']

    def open_pull_request(self, branch: str, files: Mapping[str, bytes], *, message: str, title: str, body: str) -> int:
        """Commit `files` on top of the default branch as `branch` and open its pull request; its number. Repeating it
        after a failure part-way reuses the branch and the pull request."""
        base = self.default_branch()
        head, tree = self._head()
        entries = []
        for path, data in files.items():
            blob = self.call('POST', f'{self.repo_path}/git/blobs',
                             {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})['sha']
            entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob})
        commit = self._commit(head, tree, entries, message)
        try:
            self.call('POST', f'{self.repo_path}/git/refs', {'ref': f'refs/heads/{branch}', 'sha': commit})
        except GitHubError as exc:
            if exc.status != 422:
                raise
            # A previous attempt made the branch; point it at this commit.
            self.call('PATCH', f'{self.repo_path}/git/refs/heads/{quote(branch)}', {'sha': commit, 'force': True})
        try:
            return int(self.call('POST', f'{self.repo_path}/pulls',
                                 {'title': title, 'head': branch, 'base': base, 'body': body,
                                  'maintainer_can_modify': False})['number'])
        except GitHubError as exc:
            if exc.status != 422:
                raise
            existing = self.call('GET', f'{self.repo_path}/pulls?' + urlencode(
                {'head': f'{self.owner}:{branch}', 'state': 'all'}))
            if not existing:
                raise
            return int(existing[0]['number'])

    def pull(self, number: int, etag: str | None = None) -> Reply:
        """The pull request, or a 304 when it hasn't changed since `etag`."""
        return self._send('GET', f'{self.repo_path}/pulls/{number}', etag=etag)

    def closing_comment(self, number: int, closed_at: str | None) -> str | None:
        """The last comment a person (not a bot) left on the pull request around when it was closed."""
        query = {'per_page': 100}
        if closed_at:
            query['since'] = datetime.fromtimestamp(_expiry(closed_at) - COMMENT_WINDOW, timezone.utc).strftime(
                '%Y-%m-%dT%H:%M:%SZ')
        comments = self.call('GET', f'{self.repo_path}/issues/{number}/comments?' + urlencode(query)) or []
        people = [comment for comment in comments
                  if (comment.get('user') or {}).get('type') != 'Bot' and str(comment.get('body', '')).strip()]
        return str(people[-1]['body']).strip() if people else None

    def close_pull_request(self, number: int, comment: str | None) -> bool:
        """Comment on and close the pull request; False when it was merged meanwhile, so its files stay merged."""
        if comment:
            self.call('POST', f'{self.repo_path}/issues/{number}/comments', {'body': comment})
        try:
            self.call('PATCH', f'{self.repo_path}/pulls/{number}', {'state': 'closed'})
        except GitHubError as exc:
            if exc.status != 422:
                raise
            pull = self.call('GET', f'{self.repo_path}/pulls/{number}')
            if pull.get('merged'):
                return False
            if pull.get('state') != 'closed':
                raise
        return True

    def files_at(self, folder: str, ref: str) -> dict[str, str] | None:
        """The files directly in `folder` at `ref`, path to git object id; None when there is no such folder."""
        try:
            listing = self.call('GET', f'{self.repo_path}/contents/{quote(folder.rstrip("/"))}?' + urlencode({'ref': ref}))
        except GitHubError as exc:
            if exc.status == 404:
                return None
            raise
        return {entry['path']: entry['sha'] for entry in listing if entry.get('type') == 'file'} if isinstance(listing, list) else None

    def tree(self, etag: str | None) -> Reply:
        """The default branch's whole tree, or a 304 when it hasn't changed since `etag`."""
        return self._send('GET', f'{self.repo_path}/git/trees/{quote(self.default_branch())}?recursive=1', etag=etag)

    def delete_folder(self, folder: str, message: str) -> bool:
        """Delete every file under `folder` from the default branch's current tree, in one commit; False when there
        was nothing to delete."""
        head, tree = self._head()
        listing = self.call('GET', f'{self.repo_path}/git/trees/{tree}?recursive=1')
        paths = [entry['path'] for entry in listing['tree'] if entry['type'] == 'blob' and entry['path'].startswith(folder)]
        if listing.get('truncated'):
            raise GitHubError(0, 'The repository tree is too large to list in one request.')
        if not paths:
            return False
        commit = self._commit(head, tree, [{'path': path, 'mode': '100644', 'type': 'blob', 'sha': None} for path in paths],
                              message)
        self.call('PATCH', f'{self.repo_path}/git/refs/heads/{quote(self.default_branch())}', {'sha': commit, 'force': False})
        return True


def github_from_env(environ: Mapping[str, str]) -> GitHubApp | None:
    names = ('PLATEWAY_GITHUB_APP_ID', 'PLATEWAY_GITHUB_APP_PRIVATE_KEY', 'PLATEWAY_GITHUB_REPO')
    given = [name for name in names if environ.get(name)]
    if not given:
        return None
    if len(given) != len(names):
        raise ValueError(f'The library bot needs {", ".join(names)}; missing {", ".join(n for n in names if n not in given)}.')
    return GitHubApp(environ['PLATEWAY_GITHUB_APP_ID'], load_private_key(environ['PLATEWAY_GITHUB_APP_PRIVATE_KEY']),
                     environ['PLATEWAY_GITHUB_REPO'])


# ------------------------------------------------------------------------------------------------------- the bot


def _clip(text: str) -> str:
    return text if len(text) <= REASON_MAX else text[:REASON_MAX - 1].rstrip() + '…'


def _quiet(text: str) -> str:
    """Contributor text as GitHub shows it, without turning `@name` into a mention that notifies someone."""
    return text.replace('@', '@\u2060')


def pull_request_text(submission: dict) -> tuple[str, str, str]:
    """The commit message, title and body for an approved submission: the contributor's display name, never an
    email address."""
    metadata, kind, author = submission['metadata'], submission['kind'], submission['author']
    noun, name, item_id = NOUNS[kind], _quiet(metadata['name']), metadata['id']
    source = metadata.get('source')
    adapted = (_quiet(f'\n\nAdapted from {source["url"]} by {", ".join(source["authors"])}.')
               if isinstance(source, dict) else '')
    folder = item_folder(kind, item_id, FIRST_VERSION)
    message = f'Add {noun} “{name}” ({item_id})\n\nContributed by {author} under {submission["licence"]}.{adapted}'
    title = f'Add {noun} “{name}” by {author}'
    body = (f'**{name}** (`{item_id}`), a {noun} contributed through Plateway by **{author}** under '
            f'{submission["licence"]}.{adapted}\n\nFiles: `{folder}`. It passed Plateway\'s automatic check and Alex\'s '
            f'quick look; the `check` workflow runs the same check here.\n\nMerging adds it to the Plateway library, '
            f'credited to {author}. Closing rejects it: leave a comment saying why before closing, and the contributor '
            f'sees it in Plateway.')
    return message, title, body


class LibraryBot:
    def __init__(self, database: Path, github: GitHubApp, library: Library, submissions: Submissions, *,
                 every: float = POLL_SECONDS, clock: Callable[[], float] = time.time):
        self.database = database
        self.github = github
        self.library = library
        self.submissions = submissions
        self.every = every
        self.clock = clock
        self._wake = threading.Event()
        self._polled_at: float | None = None
        self._tree_etag: str | None = None

    def _connect(self):
        return closing(db.connect(self.database))

    def wake(self) -> None:
        self._wake.set()

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self._wake.clear()
            pause = 1.0
            try:
                self.cycle()
            except Exception as exc:  # GitHub or the bucket failing never takes the API down; a later cycle retries
                log.error('The library bot cycle failed: %s', exc, exc_info=not isinstance(exc, GitHubError))
                pause = RETRY_SECONDS
            due = self.every if self._polled_at is None else self._polled_at + self.every - self.clock()
            self._wake.wait(max(pause, due))

    def cycle(self) -> dict:
        """One pass: open, close and remove what is owed, then poll when due; what it did. Each step runs even when
        an earlier one fails, and the first failure is raised at the end."""
        done: dict = {}
        failures = []
        steps = [('opened', self.open_pull_requests), ('closed', self.close_requested), ('withdrawn', self.close_withdrawn),
                 ('removed', self.remove_from_repo)]
        now = self.clock()
        if self._polled_at is None or now - self._polled_at >= self.every:
            # Counted from the start, so a failing poll waits a whole interval before the next.
            self._polled_at = now
            steps.append(('poll', self.poll))
        for name, step in steps:
            try:
                done[name] = step()
            except Exception as exc:
                failures.append(exc)
        if failures:
            raise failures[0]
        return done

    # --------------------------------------------------------------------------------------------- owed work

    def open_pull_requests(self) -> list[int]:
        opened = []
        for submission in self.submissions.awaiting_pull_request():
            message, title, body = pull_request_text(submission)
            number = self.github.open_pull_request(f'{BRANCH_PREFIX}{submission["id"]}', repo_files(submission),
                                                   message=message, title=title, body=body)
            now = int(self.clock())
            with self._connect() as conn, db.transaction(conn):
                # Withdrawn meanwhile: keep the number, so the pull request is closed on the next pass.
                conn.execute("UPDATE submissions SET pr_number = ?, state = CASE state WHEN 'approved' THEN 'pr_open' "
                             'ELSE state END, updated_at = ? WHERE id = ?', (number, now, submission['id']))
            log.info('Opened pull request #%d for submission %s', number, submission['id'])
            opened.append(number)
        return opened

    def close_requested(self) -> list[int]:
        """Alex rejected these in Plateway after approving them: his reason goes on the pull request, which closes."""
        with self._connect() as conn:
            rows = conn.execute("SELECT id, pr_number, reason FROM submissions WHERE state = 'pr_open' "
                                'AND pr_number IS NOT NULL AND reason IS NOT NULL ORDER BY updated_at, id').fetchall()
        for row in rows:
            if self.github.close_pull_request(row['pr_number'], f'Rejected in Plateway: {row["reason"]}'):
                self._finish(row['id'], 'closed', row['reason'])
            else:
                self._merged_meanwhile(row['id'], row['pr_number'], 'pr_open', 'submission_rejected_after_merge')
        return [row['pr_number'] for row in rows]

    def close_withdrawn(self) -> list[int]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id, pr_number FROM submissions WHERE state = 'withdrawn' AND pr_number IS NOT NULL "
                                'AND pr_closed_at IS NULL ORDER BY updated_at, id').fetchall()
        for row in rows:
            if not self.github.close_pull_request(row['pr_number'], WITHDRAWN_COMMENT):
                self._merged_meanwhile(row['id'], row['pr_number'], 'withdrawn', 'submission_withdrawn_after_merge')
                continue
            now = int(self.clock())
            with self._connect() as conn, db.transaction(conn):
                conn.execute('UPDATE submissions SET pr_closed_at = ?, updated_at = ? WHERE id = ?', (now, now, row['id']))
                conn.execute('DELETE FROM submission_files WHERE submission_id = ?', (row['id'],))
            log.info('Closed pull request #%d of withdrawn submission %s', row['pr_number'], row['id'])
        return [row['pr_number'] for row in rows]

    def remove_from_repo(self) -> list[str]:
        removed = []
        for item_id, folder in self.library.owed_repo_removals():
            self.github.delete_folder(folder, f'Remove {item_id} from the library\n\nTaken down by the Plateway admin.')
            self.library.repo_removed(item_id)
            log.info('Deleted library item %s from the repository', item_id)
            removed.append(item_id)
        return removed

    def _finish(self, submission_id: str, state: str, reason: str | None = None, *, etag: str | None = None) -> None:
        """Move a `pr_open` submission to `merged` or `closed`, with the pull request's `etag` when the poll saw it;
        a closed one keeps no file."""
        now = int(self.clock())
        with self._connect() as conn, db.transaction(conn):
            conn.execute("UPDATE submissions SET state = ?, reason = ?, pr_etag = coalesce(?, pr_etag), updated_at = ? "
                         "WHERE id = ? AND state = 'pr_open'", (state, reason, etag, now, submission_id))
            if state == 'closed':
                conn.execute('DELETE FROM submission_files WHERE submission_id = ?', (submission_id,))

    def _merged_meanwhile(self, submission_id: str, number: int, state: str, kind: str) -> None:
        """The pull request was merged on GitHub before the bot could close it: its files are public, so the
        submission is `merged`, published like any merge, and Alex takes it down with Remove."""
        now = int(self.clock())
        with self._connect() as conn, db.transaction(conn):
            conn.execute("UPDATE submissions SET state = 'merged', reason = NULL, updated_at = ? WHERE id = ? AND state = ?",
                         (now, submission_id, state))
            conn.execute('INSERT INTO audit_events (at, kind, detail) VALUES (?, ?, ?)',
                         (now, kind, json.dumps({'submission': submission_id, 'pullRequest': number})))
        log.warning('Pull request #%d was merged before it could be closed: submission %s is merged', number, submission_id)

    # -------------------------------------------------------------------------------------------------- polling

    def poll(self) -> dict:
        """Each open submission pull request, conditionally on its ETag, then merged items' publication and the
        default branch's tree for reverts."""
        with self._connect() as conn:
            rows = conn.execute("SELECT id, pr_number, pr_etag FROM submissions WHERE state = 'pr_open' "
                                'AND pr_number IS NOT NULL AND reason IS NULL ORDER BY pr_number').fetchall()
        result = {'checked': len(rows), 'unchanged': 0, 'merged': [], 'closed': [], 'published': [], 'retired': []}
        for row in rows:
            reply = self.github.pull(row['pr_number'], row['pr_etag'])
            if reply.status == 304:
                result['unchanged'] += 1
                continue
            pull = reply.json()
            etag = reply.headers.get('etag')
            if pull['state'] != 'closed':
                with self._connect() as conn, db.transaction(conn):
                    conn.execute('UPDATE submissions SET pr_etag = ? WHERE id = ?', (etag, row['id']))
                continue
            # The ETag is stored with the outcome: a failure before it leaves the old one, so the next poll retries.
            if pull.get('merged'):
                self._finish(row['id'], 'merged', etag=etag)
                result['merged'].append(row['pr_number'])
                log.info('Pull request #%d merged: submission %s', row['pr_number'], row['id'])
            else:
                comment = self.github.closing_comment(row['pr_number'], pull.get('closed_at'))
                self._finish(row['id'], 'closed', _clip(comment) if comment else CLOSED_REASON, etag=etag)
                result['closed'].append(row['pr_number'])
                log.info('Pull request #%d closed unmerged: submission %s', row['pr_number'], row['id'])
        result['published'] = self.publish_merged()
        result['retired'] = self.retire_reverted()
        return result

    def publish_merged(self) -> list[str]:
        published = []
        for submission_id in self.library.unpublished():
            with self._connect() as conn:
                row = conn.execute('SELECT s.kind, s.metadata, s.pr_number, f.data FROM submissions s '
                                   'LEFT JOIN submission_files f ON f.submission_id = s.id WHERE s.id = ?',
                                   (submission_id,)).fetchone()
            if row['data'] is None or row['pr_number'] is None:
                log.error('Merged submission %s has no file or pull request to publish from', submission_id)
                continue
            pull = self.github.pull(row['pr_number']).json()
            item_id = json.loads(row['metadata'])['id']
            folder = item_folder(row['kind'], item_id, FIRST_VERSION)
            merged = self.github.files_at(folder, pull['merge_commit_sha']) or {}
            if blob_sha(bytes(row['data'])) not in merged.values():
                log.error('Pull request #%d merged files that differ from the approved upload %s; not published',
                          row['pr_number'], submission_id)
                continue
            try:
                self.library.publish(submission_id)
            except LibraryError as exc:
                log.error('Publishing submission %s failed: %s', submission_id, exc.detail)
                continue
            published.append(item_id)
        return published

    def retire_reverted(self) -> list[str]:
        reply = self.github.tree(self._tree_etag)
        if reply.status == 304:
            return []
        listing = reply.json()
        if listing.get('truncated'):
            log.warning('The library repository tree is truncated; reverted items are not detected')
            return []
        retired = self.library.retire_missing({entry['path'] for entry in listing['tree'] if entry['type'] == 'blob'})
        self._tree_etag = reply.headers.get('etag')  # only once handled, so a failure is retried on the next poll
        return retired
