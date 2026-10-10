"""A recorded fake of the GitHub REST API calls the library bot makes (`cad/service/github_app.py`), with GitHub's
response shapes, status codes, ETag and rate-limit behaviour: a 304 to a conditional request does not count against
the rate limit. Git objects are kept flat (a tree is a path → blob map). Use it as the bot's transport, or serve it on
loopback (`python tests/fake_github.py PORT`) for an end-to-end run, where `POST /_fake/pulls/<n>/merge` and
`/close` stand in for Alex on github.com.

It never talks to GitHub."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import itertools
import json
import re
import secrets
import sys
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from cad.service.github_app import Reply

BOT = {'login': 'plateway-library[bot]', 'type': 'Bot'}
ALEX = {'login': 'AlexMC', 'type': 'User'}
TOKEN_LENGTH = 520
RATE_LIMIT = 5000


def _sha(kind: str, data: bytes) -> str:
    return hashlib.sha1(f'{kind} {len(data)}\0'.encode() + data).hexdigest()


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


class FakeGitHub:
    def __init__(self, *, owner: str = 'plateway', repo: str = 'plateway-library', app_id: str = '424242',
                 installation: int = 777, clock=time.time, seed: dict[str, bytes] | None = None):
        self.owner, self.repo, self.app_id, self.installation = owner, repo, app_id, installation
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_pem = self.private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                          serialization.NoEncryption()).decode()
        self.clock = clock
        self.lock = threading.RLock()
        self.blobs: dict[str, bytes] = {}
        self.trees: dict[str, dict[str, str]] = {}
        self.commits: dict[str, dict] = {}
        self.refs: dict[str, str] = {}
        self.pulls: dict[int, dict] = {}
        self.comments: dict[int, list[dict]] = {}
        self.numbers = itertools.count(1)
        self.comment_ids = itertools.count(1000)
        self.tokens: dict[str, float] = {}
        self.issued: list[str] = []
        self.requests: list[tuple[str, str, int]] = []
        self.rate_used = 0
        self.failures: list[tuple[str, str, Reply]] = []
        self.in_flight = 0
        self.most_in_flight = 0
        self.delay = 0.0
        files = seed or {'README.md': b'# Plateway library\n', 'pieces/.gitkeep': b'', 'trains/.gitkeep': b'',
                         'furniture/.gitkeep': b''}
        tree = self._tree({path: self._blob(data) for path, data in files.items()})
        self.refs['heads/main'] = self._commit(tree, [], 'Start the library', ALEX)

    # --------------------------------------------------------------------------------------------- git objects

    def _blob(self, data: bytes) -> str:
        sha = _sha('blob', data)
        self.blobs[sha] = data
        return sha

    def _tree(self, files: dict[str, str]) -> str:
        sha = _sha('tree', json.dumps(sorted(files.items())).encode())
        self.trees[sha] = dict(files)
        return sha

    def _commit(self, tree: str, parents: list[str], message: str, author: dict) -> str:
        sha = _sha('commit', json.dumps([tree, parents, message, len(self.commits)]).encode())
        self.commits[sha] = {'tree': tree, 'parents': parents, 'message': message, 'author': author}
        return sha

    def resolve(self, ref: str) -> str:
        """A branch name or a commit sha → the commit sha."""
        return self.refs.get(f'heads/{ref}', ref)

    def files(self, ref: str = 'main') -> dict[str, bytes]:
        """The files at a branch or commit."""
        return {path: self.blobs[sha] for path, sha in self.trees[self.commits[self.resolve(ref)]['tree']].items()}

    # ------------------------------------------------------------------------------------- what Alex does there

    def merge(self, number: int) -> str:
        with self.lock:
            pull = self.pulls[number]
            head = self.commits[pull['head']['sha']]
            parent_files = self.trees[self.commits[head['parents'][0]]['tree']]
            head_files = self.trees[head['tree']]
            main = self.commits[self.refs['heads/main']]
            files = dict(self.trees[main['tree']])
            files.update({path: sha for path, sha in head_files.items() if parent_files.get(path) != sha})
            for path in set(parent_files) - set(head_files):
                files.pop(path, None)
            merge = self._commit(self._tree(files), [self.refs['heads/main'], pull['head']['sha']],
                                 f'Merge pull request #{number}', ALEX)
            self.refs['heads/main'] = merge
            pull.update(state='closed', merged=True, merge_commit_sha=merge, merged_at=_iso(self.clock()),
                        closed_at=_iso(self.clock()), updated_at=_iso(self.clock()))
            return merge

    def close(self, number: int, comment: str | None = None, by: dict = ALEX) -> None:
        with self.lock:
            if comment:
                self._comment(number, comment, by)
            self.pulls[number].update(state='closed', closed_at=_iso(self.clock()), updated_at=_iso(self.clock()))

    def revert(self, folder: str) -> None:
        """A commit on main deleting everything under `folder`."""
        with self.lock:
            main = self.refs['heads/main']
            files = {path: sha for path, sha in self.trees[self.commits[main]['tree']].items() if not path.startswith(folder)}
            self.refs['heads/main'] = self._commit(self._tree(files), [main], f'Revert {folder}', ALEX)

    def fail_next(self, method: str, path: str, status: int, headers: dict | None = None, message: str = '') -> None:
        """The next `method` request whose path ends with `path` gets this answer instead."""
        self.failures.append((method, path, Reply(status, headers or {}, json.dumps({'message': message}).encode())))

    def _comment(self, number: int, body: str, user: dict) -> dict:
        comment = {'id': next(self.comment_ids), 'body': body, 'user': user, 'created_at': _iso(self.clock()),
                   'updated_at': _iso(self.clock())}
        self.comments.setdefault(number, []).append(comment)
        return comment

    # ----------------------------------------------------------------------------------------------- transport

    def __call__(self, method: str, url: str, headers, body: bytes | None) -> Reply:
        with self.lock:
            self.in_flight += 1
            self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            if self.delay:
                time.sleep(self.delay)
            with self.lock:
                reply = self._handle(method, url, {k.lower(): v for k, v in headers.items()}, body)
                self.requests.append((method, urlsplit(url).path, reply.status))
                return reply
        finally:
            with self.lock:
                self.in_flight -= 1

    def _reply(self, status: int, data=None, headers: dict | None = None, *, request_headers=None, counted=True) -> Reply:
        payload = b'' if data is None else json.dumps(data).encode()
        out = {'content-type': 'application/json; charset=utf-8', **(headers or {})}
        if status == 200 and request_headers is not None:
            etag = f'W/"{hashlib.sha256(payload).hexdigest()}"'
            out['etag'] = etag
            if request_headers.get('if-none-match') == etag:
                counted = False
                status, payload = 304, b''
        if counted:
            self.rate_used += 1
        out['x-ratelimit-limit'] = str(RATE_LIMIT)
        out['x-ratelimit-remaining'] = str(RATE_LIMIT - self.rate_used)
        return Reply(status, out, payload)

    def _error(self, status: int, message: str) -> Reply:
        return self._reply(status, {'message': message, 'documentation_url': 'https://docs.github.com/rest'})

    def _app_authorised(self, headers) -> bool:
        token = headers.get('authorization', '').removeprefix('Bearer ')
        try:
            header, claims, signature = token.split('.')
            self.private_key.public_key().verify(_unb64(signature), f'{header}.{claims}'.encode(), padding.PKCS1v15(),
                                                 hashes.SHA256())
            payload = json.loads(_unb64(claims))
        except (ValueError, InvalidSignature):
            return False
        now = self.clock()
        return (json.loads(_unb64(header)).get('alg') == 'RS256' and payload.get('iss') == self.app_id and
                payload['iat'] <= now < payload['exp'] and payload['exp'] - payload['iat'] <= 600)

    def _handle(self, method: str, url: str, headers, body: bytes | None) -> Reply:
        parts = urlsplit(url)
        path, query = unquote(parts.path), {k: v[-1] for k, v in parse_qs(parts.query).items()}
        for n, (fail_method, suffix, reply) in enumerate(self.failures):
            if fail_method == method and path.endswith(suffix):
                del self.failures[n]
                return reply
        data = json.loads(body) if body else None
        repo = f'/repos/{self.owner}/{self.repo}'
        if path == f'{repo}/installation' or path.startswith('/app/'):
            if not self._app_authorised(headers):
                return self._error(401, 'A JSON web token could not be decoded')
            if path == f'{repo}/installation':
                return self._reply(200, {'id': self.installation, 'app_id': int(self.app_id)})
            if method == 'POST' and path == f'/app/installations/{self.installation}/access_tokens':
                token = 'ghs_' + secrets.token_urlsafe(TOKEN_LENGTH)[:TOKEN_LENGTH - 4]
                expires = self.clock() + 3600
                self.tokens[token] = expires
                self.issued.append(token)
                return self._reply(201, {'token': token, 'expires_at': _iso(expires),
                                         'permissions': {'contents': 'write', 'pull_requests': 'write'},
                                         'repository_selection': 'selected'})
            return self._error(404, 'Not Found')
        token = headers.get('authorization', '').removeprefix('Bearer ')
        if self.tokens.get(token, 0) <= self.clock():
            return self._error(401, 'Bad credentials')
        if not path.startswith(repo):
            return self._error(404, 'Not Found')
        rest = path[len(repo):]
        get = dict(request_headers=headers)

        if method == 'GET' and rest == '':
            return self._reply(200, {'full_name': f'{self.owner}/{self.repo}', 'default_branch': 'main', 'private': False}, **get)
        if method == 'GET' and (match := re.fullmatch(r'/git/ref/(heads/.+)', rest)):
            if match[1] not in self.refs:
                return self._error(404, 'Not Found')
            return self._reply(200, {'ref': f'refs/{match[1]}', 'object': {'sha': self.refs[match[1]], 'type': 'commit'}}, **get)
        if method == 'GET' and (match := re.fullmatch(r'/git/commits/([0-9a-f]{40})', rest)):
            commit = self.commits.get(match[1])
            if commit is None:
                return self._error(404, 'Not Found')
            return self._reply(200, {'sha': match[1], 'tree': {'sha': commit['tree']}, 'message': commit['message'],
                                     'parents': [{'sha': sha} for sha in commit['parents']]}, **get)
        if method == 'POST' and rest == '/git/blobs':
            return self._reply(201, {'sha': self._blob(base64.b64decode(data['content']))})
        if method == 'POST' and rest == '/git/trees':
            files = dict(self.trees[data['base_tree']]) if data.get('base_tree') else {}
            for entry in data['tree']:
                if entry['sha'] is None:
                    files.pop(entry['path'], None)
                elif entry['sha'] not in self.blobs:
                    return self._error(422, 'Invalid tree info')
                else:
                    files[entry['path']] = entry['sha']
            return self._reply(201, {'sha': self._tree(files)})
        if method == 'POST' and rest == '/git/commits':
            if 'author' in data or 'committer' in data:
                return self._error(422, 'This fake expects the App identity as author')
            return self._reply(201, {'sha': self._commit(data['tree'], data['parents'], data['message'], BOT)})
        if method == 'POST' and rest == '/git/refs':
            name = data['ref'].removeprefix('refs/')
            if name in self.refs:
                return self._error(422, 'Reference already exists')
            self.refs[name] = data['sha']
            return self._reply(201, {'ref': data['ref'], 'object': {'sha': data['sha'], 'type': 'commit'}})
        if method == 'PATCH' and (match := re.fullmatch(r'/git/refs/(heads/.+)', rest)):
            if match[1] not in self.refs:
                return self._error(422, 'Reference does not exist')
            if not data.get('force') and self.refs[match[1]] not in self.commits[data['sha']]['parents']:
                return self._error(422, 'Update is not a fast forward')
            self.refs[match[1]] = data['sha']
            return self._reply(200, {'ref': f'refs/{match[1]}', 'object': {'sha': data['sha'], 'type': 'commit'}})
        if method == 'GET' and (match := re.fullmatch(r'/git/trees/(.+)', rest)):
            commit = self.commits.get(self.resolve(match[1]))
            tree_sha = commit['tree'] if commit else match[1]
            if tree_sha not in self.trees:
                return self._error(404, 'Not Found')
            files = self.trees[tree_sha]
            folders = sorted({'/'.join(path.split('/')[:n]) for path in files for n in range(1, path.count('/') + 1)})
            entries = [{'path': folder, 'mode': '040000', 'type': 'tree'} for folder in folders]
            entries += [{'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha, 'size': len(self.blobs[sha])}
                        for path, sha in sorted(files.items())]
            return self._reply(200, {'sha': tree_sha, 'tree': entries, 'truncated': False}, **get)
        if method == 'GET' and (match := re.fullmatch(r'/contents/(.+)', rest)):
            files = self.trees[self.commits[self.resolve(query.get('ref', 'main'))]['tree']]
            folder = match[1].rstrip('/') + '/'
            inside = {path: sha for path, sha in files.items() if path.startswith(folder) and '/' not in path[len(folder):]}
            if not inside:
                return self._error(404, 'Not Found')
            return self._reply(200, [{'type': 'file', 'name': path.rsplit('/', 1)[-1], 'path': path, 'sha': sha,
                                      'size': len(self.blobs[sha])} for path, sha in sorted(inside.items())], **get)
        if method == 'POST' and rest == '/pulls':
            if f'heads/{data["head"]}' not in self.refs:
                return self._error(422, 'Validation Failed')
            if any(pull['head']['ref'] == data['head'] and pull['state'] == 'open' for pull in self.pulls.values()):
                return self._error(422, 'A pull request already exists')
            number = next(self.numbers)
            self.pulls[number] = {
                'number': number, 'state': 'open', 'merged': False, 'merge_commit_sha': None, 'merged_at': None,
                'closed_at': None, 'title': data['title'], 'body': data['body'], 'user': BOT,
                'head': {'ref': data['head'], 'sha': self.refs[f'heads/{data["head"]}']}, 'base': {'ref': data['base']},
                'html_url': f'https://github.com/{self.owner}/{self.repo}/pull/{number}',
                'created_at': _iso(self.clock()), 'updated_at': _iso(self.clock())}
            return self._reply(201, self.pulls[number])
        if method == 'GET' and rest == '/pulls':
            head = query.get('head', '').split(':', 1)[-1]
            return self._reply(200, [pull for pull in self.pulls.values() if pull['head']['ref'] == head], **get)
        if (match := re.fullmatch(r'/pulls/(\d+)', rest)):
            pull = self.pulls.get(int(match[1]))
            if pull is None:
                return self._error(404, 'Not Found')
            if method == 'GET':
                return self._reply(200, pull, **get)
            if method == 'PATCH':
                if pull['merged']:
                    return self._error(422, 'Cannot close a merged pull request')
                if data.get('state') == 'closed' and pull['state'] == 'open':
                    pull.update(state='closed', closed_at=_iso(self.clock()), updated_at=_iso(self.clock()))
                return self._reply(200, pull)
        if (match := re.fullmatch(r'/issues/(\d+)/comments', rest)):
            number = int(match[1])
            if method == 'POST':
                return self._reply(201, self._comment(number, data['body'], BOT))
            since = query.get('since')
            return self._reply(200, [comment for comment in self.comments.get(number, [])
                                     if not since or comment['updated_at'] >= since], **get)
        return self._error(404, 'Not Found')

    # -------------------------------------------------------------------------------------------- HTTP server

    def server(self, port: int) -> ThreadingHTTPServer:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _answer(self, reply: Reply) -> None:
                self.send_response(reply.status)
                for name, value in reply.headers.items():
                    self.send_header(name, value)
                self.send_header('content-length', str(len(reply.body)))
                self.end_headers()
                self.wfile.write(reply.body)

            def _any(self):
                body = self.rfile.read(int(self.headers.get('content-length') or 0)) or None
                if (match := re.fullmatch(r'/_fake/pulls/(\d+)/(merge|close)', self.path)):
                    comment = json.loads(body).get('comment') if body else None
                    fake.merge(int(match[1])) if match[2] == 'merge' else fake.close(int(match[1]), comment)
                    return self._answer(Reply(200, {}, json.dumps(fake.pulls[int(match[1])]).encode()))
                if self.path == '/_fake/state':
                    with fake.lock:
                        state = {'pulls': list(fake.pulls.values()), 'refs': fake.refs, 'main': sorted(fake.files()),
                                 'requests': fake.requests[-50:], 'rateUsed': fake.rate_used}
                    return self._answer(Reply(200, {}, json.dumps(state).encode()))
                self._answer(fake(self.command, f'http://fake{self.path}', dict(self.headers.items()), body))

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _any

        return ThreadingHTTPServer(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    # Serve on loopback and print the App's private key path for the service under test.
    port, key_path = int(sys.argv[1]), sys.argv[2]
    fake = FakeGitHub()
    with open(key_path, 'w') as key_file:
        key_file.write(fake.private_pem)
    print(f'fake GitHub on http://127.0.0.1:{port}', flush=True)
    fake.server(port).serve_forever()
