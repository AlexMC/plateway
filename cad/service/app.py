"""Accounts, projects (`projects.py`) and the geometry API for signed-in members (KTD3), the landing site at `/` and the
app at `/app/`. Local development runs on loopback; hosted (U10, `PLATEWAY_PUBLIC_ORIGIN`), the service sits behind
the Cloudflare tunnel (`deploy/compose.yml`, `docs/operations.md`)."""

from __future__ import annotations
from contextlib import asynccontextmanager

from datetime import datetime, timezone
import logging
import json
import os
from pathlib import Path
import secrets
import threading
import re
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from shutil import copyfileobj
from tempfile import SpooledTemporaryFile
from typing import BinaryIO
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo
from urllib.parse import quote, urlsplit
from cad.service import db, ops
from cad.service.accounts import SESSION_TTL, AccountError, Accounts, Deletion, Session, SignedIn
from cad.service.errors import UserError
from cad.service.mailer import Mailer, from_env as mailer_from_env
from cad.service.jobs import JobError, Jobs, Limits
from cad.service.package import public_receipt
from cad.service.calibration import list_calibrations, record_calibration
from cad.service.plates import print_presets
from cad.service.projects import Projects, register as register_projects
from cad.service.gallery import Gallery, register as register_gallery
from cad.service.feedback import FEEDBACK_PER_HOUR, HOUR, Feedback, register as register_feedback
from cad.service.submissions import Submissions, register as register_submissions
from cad.service.github_app import POLL_SECONDS, GitHubApp, LibraryBot, github_from_env
from cad.service.library_publish import Library, register as register_library
from cad.service.receipts import Receipt, Receipts
from cad.service.storage import (LOCAL_URL, PACKAGE_DAYS, LocalBucket, MissingObject, Storage, check_key,
                                 content_type, disposition, open_storage)
from cad.service.usage import (ERRORS_PER_MINUTE, EVENTS_PER_MINUTE, MAX_BODY_BYTES as MAX_REPORT_BYTES, RateLimit,
                                Usage, UsageError)
from cad.service.hardware import shopping_list, validate_request as validate_hardware_request

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

MAX_PROJECT_BYTES = 2_000_000
MAX_ACCOUNT_BYTES = 4096
EXPIRED = (f"These files have expired: prepared files are kept for {PACKAGE_DAYS} days. Prepare them again to "
           "download them.")
log = logging.getLogger("cad.service")
REPOSITORY = Path(__file__).resolve().parents[2]
# The landing site's public parts; `site/tools` (its build scripts) is never served. The icons sit at the root, where
# browsers ask for `/favicon.ico` and the app's page links them.
SITE_DIRECTORIES = ("fonts", "hero", "img", "js", "legal")
SITE_FILES = ("styles.css", "favicon.svg", "favicon.ico", "apple-touch-icon.png", "site.webmanifest",
              "library.html", "gallery.html", "gallery.css", "library.css", "feedback.html")
# Anonymous reports the app sends with `navigator.sendBeacon` (`usage.py`): it carries the session cookie but cannot set
# the CSRF header, so these two never read the session; the Origin check still applies.
ANONYMOUS_REPORTS = ("/api/events", "/api/client-errors")
OPS_STYLESHEET = Path(__file__).resolve().parent / "ops.css"
ANTHROPIC_API = "https://api.anthropic.com"
# Cloudflare Web Analytics: Cloudflare injects the beacon script into HTML responses; it reports to its RUM endpoint.
ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com"
ANALYTICS_REPORTS = "https://cloudflareinsights.com"


def content_security_policy(download_origins: Sequence[str] = ()) -> str:
    """No inline script or style anywhere, and no JavaScript `eval`; `'wasm-unsafe-eval'` lets the landing hero compile
    its meshopt decoder (WebAssembly) only. Scripts come from this origin and Cloudflare's analytics beacon. The browser
    fetches from this origin, Anthropic (Describe track runs on the member's own key, U11), Cloudflare's analytics
    endpoint, the packages bucket's presigned links and the public library (`download_origins`)."""
    extra = "".join(f" {origin}" for origin in download_origins)
    return "; ".join([
        "default-src 'self'", f"script-src 'self' 'wasm-unsafe-eval' {ANALYTICS_SCRIPT}", "style-src 'self'",
        f"img-src 'self' data: blob:{extra}", f"connect-src 'self' {ANTHROPIC_API} {ANALYTICS_REPORTS}{extra}",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"])


def origin_of(url: str | None) -> str | None:
    """`scheme://host[:port]` of a configured URL, or None when unset."""
    if not url:
        return None
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError(f"Not an http(s) URL: {url}")
    return f"{parts.scheme}://{parts.netloc}"


def _loopback_aliases(authority: str) -> set[str]:
    host, separator, port = authority.partition(":")
    if host in {"127.0.0.1", "localhost"}:
        return {f"{name}{separator}{port}" for name in ("127.0.0.1", "localhost")}
    return {authority}


def _client_ip(request: Request) -> str:
    """Cloudflare's `CF-Connecting-IP` when hosted (U10); the socket peer on loopback. Never `X-Forwarded-For`
    (uvicorn runs with `proxy_headers=False`, so it never rewrites the peer either)."""
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")


def create_app(
    project_root: Path,
    *,
    expected_host: str = "127.0.0.1:8765",
    allowed_origin: str = "http://127.0.0.1:8765",
    mailer: Mailer | None = None,
    clock: Callable[[], float] = time.time,
    local_member: bool = False,
    account_cleanup: Callable[[Deletion], None] | None = None,
    job_limits: Limits = Limits(),
    storage: Storage | None = None,
    download_origins: Sequence[str] = (),
    library_url: str | None = None,
    github: GitHubApp | None = None,
    github_poll_seconds: float = POLL_SECONDS,
    ui_root: Path = REPOSITORY / "dist",
    site_root: Path = REPOSITORY / "site",
) -> FastAPI:
    """`local_member` (loopback only) keeps `GET /api/session` for local scripts (`scripts/plan.ts --save`):
    it signs the caller in as one verified local member. The browser app never calls it; it
    signs in through `/api/auth/*`. A deleted account's package files are deleted from storage, then
    `account_cleanup` receives the deletion (its open pull requests: U16); the `account_deleted` audit row keeps the
    same list for 90 days, as every audit row. Prepares are queued (`jobs.py`) for the worker (`worker.py`);
    `job_limits` sets the per-part size and daily limits. `storage` defaults to the environment's (`storage.py`).
    `download_origins` are the storage hosts the browser loads from (the packages bucket's presigned links, the public
    library), allowed by the Content-Security-Policy. `library_url` is the public library bucket's base URL
    (`PLATEWAY_LIBRARY_URL`), where `/api/library/` redirects on S3. With `github` (the library repository's App,
    `github_app.py`), the library bot runs on a thread: approved uploads become pull requests, and a poll every
    `github_poll_seconds` publishes merges and records closes.
    `site_root` (the landing site, at `/`) and `ui_root` (the built app, at `/app/`) are served when present."""
    if local_member and expected_host.partition(":")[0] not in {"127.0.0.1", "localhost"}:
        raise ValueError("The local member is for loopback development only")
    project_root.mkdir(parents=True, exist_ok=True)
    database = db.database_path(project_root)
    db.migrate(database)
    storage = storage or open_storage(os.environ, db.storage_root(project_root))
    packages = storage.packages
    receipts = Receipts(database, packages, clock)
    accounts = Accounts(database, mailer or mailer_from_env(os.environ, project_root / "mail"), allowed_origin, clock)
    jobs = Jobs(database, clock, job_limits)
    library = Library(database, storage.library, clock)
    submissions = Submissions(database, accounts.mailer, allowed_origin, clock)
    bot = (LibraryBot(database, github, library, submissions, every=github_poll_seconds, clock=clock)
           if github is not None else None)
    library_changed = bot.wake if bot is not None else (lambda: None)
    submissions.changed = library_changed
    usage = Usage(database, clock)
    event_limit = RateLimit(EVENTS_PER_MINUTE, clock=clock)
    error_limit = RateLimit(ERRORS_PER_MINUTE, clock=clock)
    feedback = Feedback(database, accounts.mailer, clock, allowed_origin)
    allowed_hosts = _loopback_aliases(expected_host)
    origin_parts = urlsplit(allowed_origin)
    allowed_origins = {
        origin_parts._replace(netloc=host).geturl()
        for host in _loopback_aliases(origin_parts.netloc)
    }
    # `__Host-` needs Secure, which a plain-http loopback origin cannot carry; local development uses a plain name.
    secure_cookie = origin_parts.scheme == "https"
    cookie_name = "__Host-plateway" if secure_cookie else "plateway"
    security_headers = {
        "Content-Security-Policy": content_security_policy(download_origins),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        **({"Strict-Transport-Security": "max-age=31536000"} if secure_cookie else {}),
    }

    def clean_up(deletions: list[Deletion]) -> None:
        # The account is gone either way; on a failure the audit row still lists what is owed.
        for deletion in deletions:
            for prefix in deletion.storage_prefixes:
                try:
                    packages.delete_prefix(prefix)
                except Exception as exc:
                    log.error("Deleting the files of deleted account %s failed", deletion.user_id, exc_info=exc)
            if deletion.pull_requests:
                library_changed()  # the bot closes the withdrawn uploads' pull requests
            if account_cleanup is None:
                continue
            try:
                account_cleanup(deletion)
            except Exception as exc:
                log.error("Clean-up after deleting account %s failed", deletion.user_id, exc_info=exc)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        clean_up(await run_in_threadpool(accounts.purge))
        await run_in_threadpool(feedback.purge)
        stop = threading.Event()
        threading.Thread(target=feedback.run, args=(stop,), name="feedback-purge", daemon=True).start()
        if bot is not None:
            threading.Thread(target=bot.run, args=(stop,), name="library-bot", daemon=True).start()
        try:
            yield
        finally:
            stop.set()
            library_changed()

    app = FastAPI(title="Plateway", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        log.error("Unexpected error on %s %s", request.method, request.url.path, exc_info=exc)
        return JSONResponse({"detail": "Something went wrong. See the service log."}, status_code=500)

    @app.exception_handler(AccountError)
    async def account_error(_request: Request, exc: AccountError):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    @app.exception_handler(JobError)
    async def job_error(_request: Request, exc: JobError):
        return JSONResponse({"detail": exc.detail, **exc.extra}, status_code=exc.status)

    @app.middleware("http")
    async def guard_api(request: Request, call_next):
        """Host and Origin allowlists on every `/api` (and `/admin`) request; unsafe ones need an allowed Origin even
        without a session, and with a session cookie also that session's CSRF token in `X-Workshop-Session`."""
        request.state.session = None
        if request.url.path.startswith(("/api/", "/admin/")):
            if request.headers.get("host") not in allowed_hosts:
                return JSONResponse({"detail": "Unexpected host"}, status_code=403)
            origin = request.headers.get("origin")
            unsafe = request.method not in {"GET", "HEAD"}
            if (origin is not None or unsafe) and origin not in allowed_origins:
                return JSONResponse({"detail": "Unexpected origin"}, status_code=403)
            raw = request.cookies.get(cookie_name)
            anonymous = request.url.path in ANONYMOUS_REPORTS
            session = (await run_in_threadpool(accounts.session, raw)
                       if raw and len(raw) <= 128 and not anonymous else None)
            if session is not None and unsafe and not secrets.compare_digest(
                    request.headers.get("x-workshop-session", "").encode(), session.csrf.encode()):
                return JSONResponse({"detail": "Session required"}, status_code=403)
            request.state.session = session
        return await call_next(request)

    @app.middleware("http")
    async def add_security_headers(request: Request, call_next):
        """Every response, pages, files and API answers alike, carries the security headers (CSP: no inline script)."""
        response = await call_next(request)
        for name, value in security_headers.items():
            response.headers.setdefault(name, value)
        return response

    def member(request: Request) -> Session:
        session = request.state.session
        if session is None:
            raise HTTPException(status_code=401, detail="Sign in first")
        return session

    def verified_member(session: Session = Depends(member)) -> Session:
        if not session.member.verified:
            raise HTTPException(status_code=403, detail="Verify your email first")
        return session

    def admin(request: Request) -> Session:
        """An admin's session (`set_admin.py`); anyone else, signed in or not, finds nothing here (404)."""
        session = request.state.session
        if session is None or not ops.is_admin(database, session.member.id):
            raise HTTPException(status_code=404, detail="Not Found")
        return session

    def me(session: Session) -> dict:
        return {"user": session.member.public(), "csrf": session.csrf}

    def with_session_cookie(response: Response, signed: SignedIn) -> Response:
        response.set_cookie(cookie_name, signed.token, max_age=SESSION_TTL, path="/", secure=secure_cookie,
                            httponly=True, samesite="lax")
        return response

    def start_session(request: Request, signed: SignedIn) -> Response:
        """Reply with the new session's cookie, ending the one the request came with (a new token per sign-in)."""
        if request.state.session is not None:
            accounts.logout(request.state.session)
        return with_session_cookie(JSONResponse(me(signed.session)), signed)

    def end_session(body: dict) -> JSONResponse:
        """Clear the cookie, and the stored draft and AI key in the browser (ASVS 14.3.1)."""
        response = JSONResponse(body)
        response.delete_cookie(cookie_name, path="/", secure=secure_cookie, httponly=True, samesite="lax")
        response.headers["Clear-Site-Data"] = '"storage"'
        return response

    async def account_body(request: Request) -> dict:
        return await _json_body(request, MAX_ACCOUNT_BYTES, "account")

    @app.post("/api/auth/signup", status_code=202)
    async def sign_up(request: Request):
        body = await account_body(request)
        await run_in_threadpool(accounts.signup, body.get("email"), body.get("password"), body.get("displayName"),
                                _client_ip(request))
        return {"status": "check-email"}

    @app.post("/api/auth/verify-email")
    async def verify_email(request: Request):
        """Never signs a browser in, so a link someone else sends cannot put it in their account (login CSRF). The
        member's own session stays signed in and gets the verified account; any other browser is told to sign in."""
        body = await account_body(request)
        verified = await run_in_threadpool(accounts.verify_email, body.get("token"))
        session = request.state.session
        if session is None or session.member.id != verified.id:
            return {"verified": True, "signedIn": False}
        return {"verified": True, "signedIn": True, "user": verified.public(), "csrf": session.csrf}

    @app.post("/api/auth/resend-verification", status_code=202)
    async def resend_verification(session: Session = Depends(member)):
        await run_in_threadpool(accounts.resend_verification, session)
        return {"status": "check-email"}

    @app.post("/api/auth/login")
    async def sign_in(request: Request):
        body = await account_body(request)
        signed = await run_in_threadpool(accounts.login, body.get("email"), body.get("password"), _client_ip(request))
        return start_session(request, signed)

    @app.post("/api/auth/logout")
    def sign_out(request: Request):
        if request.state.session is not None:
            accounts.logout(request.state.session)
        return end_session({"status": "signed-out"})

    @app.get("/api/auth/me")
    def who_am_i(session: Session = Depends(member)):
        return me(session)

    @app.post("/api/auth/password/forgot", status_code=202)
    async def forgot_password(request: Request):
        body = await account_body(request)
        await run_in_threadpool(accounts.forgot_password, body.get("email"), _client_ip(request))
        return {"status": "check-email"}

    @app.post("/api/auth/password/reset")
    async def reset_password(request: Request):
        body = await account_body(request)
        return start_session(request, await run_in_threadpool(accounts.reset_password, body.get("token"), body.get("password")))

    @app.post("/api/auth/email/confirm")
    async def confirm_email(request: Request):
        body = await account_body(request)
        member_now = await run_in_threadpool(accounts.confirm_email_change, body.get("token"))
        return {"user": member_now.public()}

    @app.patch("/api/account")
    async def update_account(request: Request, session: Session = Depends(member)):
        body = await account_body(request)
        renamed = await run_in_threadpool(accounts.rename, session, body.get("displayName"))
        return {"user": renamed.public(), "csrf": session.csrf}

    @app.post("/api/account/password")
    async def change_password(request: Request, session: Session = Depends(member)):
        body = await account_body(request)
        await run_in_threadpool(accounts.change_password, session, body.get("current"), body.get("password"),
                                _client_ip(request))
        return {"status": "changed"}

    @app.post("/api/account/email", status_code=202)
    async def change_email(request: Request, session: Session = Depends(member)):
        body = await account_body(request)
        await run_in_threadpool(accounts.request_email_change, session, body.get("password"), body.get("newEmail"),
                                _client_ip(request))
        return {"status": "check-email"}

    @app.get("/api/account/export")
    def export_account(session: Session = Depends(member)):
        return Response(accounts.export(session), media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="plateway-export.zip"',
                                 "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.delete("/api/account")
    async def delete_account(request: Request, session: Session = Depends(member)):
        body = await account_body(request)
        deletion = await run_in_threadpool(accounts.delete, session, body.get("password"), _client_ip(request))
        await run_in_threadpool(clean_up, [deletion])
        return end_session({"status": "deleted"})

    if local_member:
        @app.get("/api/session")
        def local_session(request: Request):
            """Development bridge for local scripts; the browser app uses the account routes above."""
            session = request.state.session
            if session is not None:
                return {"token": session.csrf}
            signed = accounts.local_member()
            return with_session_cookie(JSONResponse({"token": signed.session.csrf}), signed)

    register_projects(app, Projects(db.database_path(project_root), clock), member,
                      lambda request: _json_body(request, MAX_PROJECT_BYTES, "project"))
    register_gallery(app, Gallery(database, accounts.mailer, allowed_origin, clock), verified_member=verified_member,
                     member=member, admin=admin, client_ip=_client_ip,
                     read_body=lambda request: _json_body(request, MAX_PROJECT_BYTES, "layout"))
    register_submissions(app, submissions, verified_member=verified_member, member=member, admin=admin,
                         read_body=lambda request, limit: _json_body(request, limit, "upload"))
    register_library(app, library, admin=admin, changed=library_changed)
    register_feedback(app, feedback, client_ip=_client_ip, limit=RateLimit(FEEDBACK_PER_HOUR, HOUR, clock),
                      read_body=lambda request, limit: _json_body(request, limit, "feedback"))

    async def _json_body(request: Request, limit: int = MAX_PROJECT_BYTES, kind: str = "export") -> dict:
        label = kind[0].upper() + kind[1:]
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > limit:
                raise HTTPException(status_code=413, detail=f"{label} request is too large")
        try:
            value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite number")))
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(status_code=422, detail=f"Invalid {kind} JSON") from exc
        if not isinstance(value, dict):
            raise HTTPException(status_code=422, detail=f"{label} request must be an object")
        return value

    async def anonymous_report(request: Request, limit: RateLimit, record: Callable[[dict], object]) -> Response:
        """204 once counted; 429 past the client IP's per-minute limit (held in memory only), 422 when malformed."""
        if not limit.allow(_client_ip(request)):
            raise HTTPException(status_code=429, detail="Too many reports")
        body = await _json_body(request, MAX_REPORT_BYTES, "report")
        try:
            await run_in_threadpool(record, body)
        except UsageError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return Response(status_code=204)

    @app.post("/api/events", status_code=204)
    async def count_events(request: Request):
        """`{"events": [name, ...]}`: in-app features used on this page load, counted as today's totals only."""
        return await anonymous_report(request, event_limit, usage.record_events)

    @app.post("/api/client-errors", status_code=204)
    async def count_client_error(request: Request):
        """`{"message", "where", "version"}`: a browser error, counted under its fingerprint as today's total only."""
        return await anonymous_report(request, error_limit, usage.record_error)

    @app.get("/api/calibrations")
    def get_calibrations(session: Session = Depends(member)):
        return list_calibrations(database, session.member.id)

    @app.post("/api/calibrations", status_code=201)
    async def save_calibration(request: Request, session: Session = Depends(member)):
        body = await _json_body(request)
        try:
            return await run_in_threadpool(record_calibration, database, receipts, session.member.id, body, clock())
        except UserError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (ValueError, KeyError, TypeError, OSError) as exc:
            log.warning("Calibration result rejected", exc_info=exc)
            raise HTTPException(status_code=422, detail="This result couldn’t be saved. Reload the project and try again.") from exc

    @app.post("/api/jobs", status_code=202)
    async def create_job(request: Request, response: Response, session: Session = Depends(verified_member)):
        """Queue a prepare: `{"kind": "layout", "manifest": …}` or `{"kind": "coupon" | "grade", "parts": …,
        "printer": …}`. 202 with the new job; 200 with the member's active job, which a second request returns."""
        body = await _json_body(request)
        job, created = await run_in_threadpool(jobs.enqueue, session.member.id, body)
        if not created:
            response.status_code = 200
        return job

    @app.get("/api/jobs")
    def job_status(session: Session = Depends(member)):
        """The member's active job, if any, and each daily limit's prepares left (the Print step resumes and shows
        them)."""
        return jobs.status(session.member.id)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str, session: Session = Depends(member)):
        return jobs.get(session.member.id, job_id)

    @app.delete("/api/jobs/{job_id}")
    def cancel_job(job_id: str, session: Session = Depends(member)):
        return jobs.cancel(session.member.id, job_id)

    @app.post("/api/hardware")
    async def hardware_list(request: Request):
        """The layout's (or one piece's) shopping list; no plates needed."""
        body = await _json_body(request, kind="hardware")
        try:
            pieces = validate_hardware_request(body)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return await run_in_threadpool(shopping_list, pieces)

    @app.get("/api/print-presets")
    def get_print_presets():
        try:
            return print_presets()
        except UserError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    def expiry(stored: Receipt) -> dict:
        return {"expired": stored.expired(clock()),
                "expiresAt": datetime.fromtimestamp(stored.expires_at, timezone.utc).isoformat(timespec="seconds")}

    @app.get("/api/packages")
    def list_packages(session: Session = Depends(member)):
        """The member's own packages by id; an expired one is still listed (R12)."""
        return [{"id": stored.package_id, "kind": stored.kind, "partRevision": stored.body.get("partRevision"),
                 "layoutRevision": stored.body.get("layoutRevision"), "status": stored.body.get("status"),
                 "calibrationSample": stored.kind == "coupon", **expiry(stored)}
                for stored in receipts.listed(session.member.id)]

    def owned(session: Session, package_id: str) -> Receipt:
        """The member's own package; another member's is indistinguishable from a missing one."""
        stored = receipts.get(session.member.id, package_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="Package not found")
        return stored

    def downloadable(session: Session, package_id: str) -> tuple[Receipt, dict]:
        """The member's own package and its receipt, while its files are kept; 410 once they have expired."""
        stored = owned(session, package_id)
        if stored.expired(clock()):
            raise HTTPException(status_code=410, detail=EXPIRED)
        return stored, stored.body

    @app.get("/api/packages/{package_id}")
    def get_package(package_id: str, session: Session = Depends(member)):
        stored = owned(session, package_id)
        return {**public_receipt(stored.body), **expiry(stored)}

    @app.post("/api/packages/{package_id}/prepare", status_code=202)
    async def prepare_again(package_id: str, response: Response, session: Session = Depends(verified_member)):
        """Prepare the package again (its files expired, R12): a new job for the same request, as `POST /api/jobs`."""
        job, created = await run_in_threadpool(jobs.again, session.member.id, package_id)
        if not created:
            response.status_code = 200
        return job

    def stored_object(stored: Receipt, artifact: object) -> BinaryIO:
        """An artefact of the package from storage; `ValueError` for a path that is not a plain key."""
        if not isinstance(artifact, str):
            raise ValueError("Invalid artifact")
        return packages.open(stored.key(check_key(artifact)))

    def print_meshes(parts: object) -> list[tuple[str, str]]:
        """(file name, artifact) of every part's print-oriented STL."""
        if not isinstance(parts, list) or not parts:
            raise ValueError("Missing parts")
        meshes, names = [], set()
        for part in parts:
            if not isinstance(part, dict):
                raise ValueError("Invalid part receipt")
            path = part.get("printMesh")
            if not isinstance(path, str) or not path.endswith(".stl"):
                raise ValueError("Missing print-oriented STL")
            name = path.rsplit("/", 1)[-1]
            if name in names:
                raise ValueError("Duplicate print-oriented STL name")
            names.add(name)
            meshes.append((name, path))
        return meshes

    @app.get("/api/packages/{package_id}/assembly-guide.pdf")
    def download_guide(package_id: str, session: Session = Depends(member)):
        stored, receipt = downloadable(session, package_id)
        try:
            with stored_object(stored, receipt.get("assemblyGuidePdf")) as source:
                data = source.read()
        except (MissingObject, ValueError) as exc:
            raise HTTPException(status_code=404, detail="This package has no printable guide") from exc
        usage.record_download(stored.owner_id, stored.package_id, "file")
        return Response(data, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{package_id}-assembly-guide.pdf"',
                                 "X-Content-Type-Options": "nosniff"})

    def zip_response(stored: Receipt, suffix: str, entries, missing: str) -> StreamingResponse:
        """Stream (archive name, artifact path, compression) entries, read from storage, as one ZIP; any missing or
        unsafe artefact fails it. A built archive counts as the member's download (`usage.py`)."""
        archive = SpooledTemporaryFile(max_size=4 * 1024 * 1024)
        try:
            with ZipFile(archive, "w") as target:
                for name, path, compression in entries():
                    info = ZipInfo(name)
                    info.compress_type = compression
                    with stored_object(stored, path) as source, target.open(info, "w", force_zip64=True) as output:
                        copyfileobj(source, output, 65536)
            length = archive.tell()
            archive.seek(0)
        except (MissingObject, OSError, ValueError, KeyError, TypeError):
            archive.close()
            raise HTTPException(status_code=404, detail=missing) from None
        usage.record_download(stored.owner_id, stored.package_id, "zip")

        def stream():
            try:
                while chunk := archive.read(65536):
                    yield chunk
            finally:
                archive.close()

        return StreamingResponse(stream(), media_type="application/zip",
                                 headers={"Content-Length": str(length),
                                          "Content-Disposition": f'attachment; filename="{stored.package_id}-{suffix}.zip"',
                                          "X-Content-Type-Options": "nosniff"})

    @app.get("/api/packages/{package_id}/plates.zip")
    def download_plates(package_id: str, session: Session = Depends(member)):
        """Everything to print: plain 3MF plates for any slicer, the guide and the STLs at the top;
        the Bambu Studio projects and G-code for the chosen Bambu printer in their own folder."""
        stored, receipt = downloadable(session, package_id)
        plates = receipt.get("plates")
        if not receipt.get("manifest") or not isinstance(plates, list) or not plates:
            raise HTTPException(status_code=404, detail="Complete layout plates not found")

        def entries():
            if not all(isinstance(plate, dict) for plate in plates):
                raise ValueError("Invalid plate receipt")
            printer = receipt.get("printer")
            slug = re.sub(r"[^a-z0-9]+", "-", str(printer.get("name", "")).lower()).strip("-") if isinstance(printer, dict) else ""
            bambu = f"bambu-studio-{slug}" if slug else "bambu-studio"
            for index, plate in enumerate(plates, start=1):
                if "model" in plate:  # packages prepared before plain 3MFs carry only the Bambu project
                    yield f"plate-{index:02d}.3mf", plate["model"], ZIP_STORED
            yield "assembly-guide.md", receipt.get("assemblyGuide"), ZIP_DEFLATED
            yield "assembly-guide.pdf", receipt.get("assemblyGuidePdf"), ZIP_DEFLATED
            parts = receipt.get("parts")
            if isinstance(parts, list) and parts and all(isinstance(part, dict) and "printMesh" in part for part in parts):
                for name, path in print_meshes(parts):
                    yield f"stl/{name}", path, ZIP_DEFLATED
            for index, plate in enumerate(plates, start=1):
                yield f"{bambu}/plate-{index:02d}-bambu-project.3mf", plate["project"], ZIP_STORED
                yield f"{bambu}/plate-{index:02d}.gcode", plate["gcode"], ZIP_DEFLATED

        return zip_response(stored, "plates", entries, "Package plates are incomplete or unsafe")

    @app.get("/api/packages/{package_id}/stls.zip")
    def download_print_meshes(package_id: str, session: Session = Depends(member)):
        stored, receipt = downloadable(session, package_id)
        parts = receipt.get("parts")
        if not receipt.get("manifest") or not isinstance(parts, list) or not parts:
            raise HTTPException(status_code=404, detail="Complete layout print meshes not found")

        def entries():
            for name, path in print_meshes(parts):
                yield name, path, ZIP_DEFLATED

        return zip_response(stored, "stls", entries, "Package print meshes are incomplete or unsafe")

    @app.get("/api/packages/{package_id}/files/{artifact_path:path}")
    def get_artifact(package_id: str, artifact_path: str, session: Session = Depends(member)):
        """One artefact of the member's own package, through a short-lived presigned link (KTD7)."""
        stored, _ = downloadable(session, package_id)
        try:
            key = stored.key(check_key(artifact_path))
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Artifact not found or unsafe") from exc
        usage.record_download(stored.owner_id, stored.package_id, "file")
        return RedirectResponse(packages.presign(key, artifact_path.rsplit("/", 1)[-1]), status_code=307,
                                headers={"Cache-Control": "no-store"})

    @app.get(LOCAL_URL + "/{bucket}/{key:path}")
    def local_object(bucket: str, key: str, expires: int, filename: str, signature: str):
        """A local-disk bucket's presigned link (`storage.LocalBucket.presign`), as R2 serves its own when hosted."""
        local = storage.local(bucket)
        try:
            if local is None:
                raise MissingObject(key)
            source = local.open_signed(key, expires, filename, signature)
        except MissingObject as exc:
            raise HTTPException(status_code=404, detail="Not found or link expired") from exc

        def stream() -> Iterator[bytes]:
            with source:
                while chunk := source.read(65536):
                    yield chunk

        return StreamingResponse(stream(), media_type=content_type(key), headers={
            "Content-Length": str(os.fstat(source.fileno()).st_size), "Content-Disposition": disposition(filename),
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})

    @app.get("/api/library/{key:path}")
    def library_object(key: str):
        """The public library (KTD9): `index.json` and the files it names, at one fixed URL for the app. A local-disk
        library bucket is served here, public-read as R2 serves it; on S3 this redirects to the bucket's public URL, so
        the app resolves the index's files against the bucket itself."""
        try:
            check_key(key)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Not in the library") from exc
        if not isinstance(storage.library, LocalBucket):
            if not library_url:
                raise HTTPException(status_code=404, detail="No library is configured")
            return RedirectResponse(f"{library_url.rstrip('/')}/{quote(key)}", status_code=302,
                                    headers={"Cache-Control": "no-store"})
        try:
            source = storage.library.open(key)
        except MissingObject as exc:
            raise HTTPException(status_code=404, detail="Not in the library") from exc

        def stream() -> Iterator[bytes]:
            with source:
                while chunk := source.read(65536):
                    yield chunk

        return StreamingResponse(stream(), media_type=content_type(key), headers={
            "Content-Length": str(os.fstat(source.fileno()).st_size), "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff"})

    @app.get("/api/admin/ops")
    def ops_report(_session: Session = Depends(admin)):
        """The R24 upsize trigger, whether it has fired, and aggregate usage (`ops.py`)."""
        return ops.report(database, clock())

    @app.get("/admin/ops")
    def ops_page(_session: Session = Depends(admin)):
        return HTMLResponse(ops.render(ops.report(database, clock())), headers={"Cache-Control": "no-store"})

    @app.get("/admin/ops.css")
    def ops_stylesheet(_session: Session = Depends(admin)):
        return FileResponse(OPS_STYLESHEET, media_type="text/css", headers={"Cache-Control": REVALIDATE})

    def page(path: Path) -> FileResponse:
        # A page names the current build's hashed files; without this the browser reuses an old page and old code.
        return FileResponse(path, headers={"Cache-Control": "no-cache"})

    def site_file(path: Path) -> Callable[[], FileResponse]:
        return lambda: FileResponse(path, headers={"Cache-Control": REVALIDATE})

    if (site_root / "index.html").is_file():
        @app.get("/")
        def landing():
            return page(site_root / "index.html")

        for name in SITE_FILES:
            if (site_root / name).is_file():
                app.add_api_route(f"/{name}", site_file(site_root / name), methods=["GET"])
        for name in SITE_DIRECTORIES:
            if (site_root / name).is_dir():
                app.mount(f"/{name}", CachedFiles(directory=site_root / name), name=f"site-{name}")

    if (ui_root / "index.html").is_file():
        @app.get("/app/")
        def app_page():
            # Account email links land here (`/app/#verify=…`); Vite's `base: '/app/'` puts every asset under `/app/`.
            return page(ui_root / "index.html")

        # The hashed bundles (`assets/`) and the brick train models and their catalogue (`public/trains`).
        app.mount("/app", CachedFiles(directory=ui_root), name="app")

    return app


REVALIDATE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"


class CachedFiles(StaticFiles):
    """Static files with an explicit cache policy. Without one Cloudflare keeps a file for 4 hours, so a new page
    would render with an old stylesheet: only Vite's hashed bundles (`assets/`) may be kept, everything else (the
    site, the train catalogue) revalidates against its ETag."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        hashed = Path(self.get_path(scope)).parts[:1] == ("assets",)
        response.headers["Cache-Control"] = IMMUTABLE if hashed else REVALIDATE
        return response


def main(environ: Mapping[str, str] = os.environ) -> None:
    """Hosted when `PLATEWAY_PUBLIC_ORIGIN` names the public origin (`deploy/compose.yml`): host and origin come from
    it, the prepare worker is its own container, and there is no local member. Otherwise local development on
    loopback, with the worker in a thread and `/api/session` for local scripts."""
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = Path(environ.get("TRAIN_PROJECT_DIR", ".projects"))
    # Never trust `X-Forwarded-*`: hosted, the client IP comes only from `CF-Connecting-IP` (`_client_ip`).
    serve = dict(proxy_headers=False, server_header=False)
    public_origin = environ.get("PLATEWAY_PUBLIC_ORIGIN")
    if public_origin:
        origin = origin_of(public_origin)
        downloads = [found for found in (origin_of(environ.get("PLATEWAY_S3_ENDPOINT")),
                                         origin_of(environ.get("PLATEWAY_LIBRARY_URL"))) if found]
        hosted = create_app(root, expected_host=urlsplit(origin).netloc, allowed_origin=origin,
                            download_origins=list(dict.fromkeys(downloads)),
                            library_url=environ.get("PLATEWAY_LIBRARY_URL") or None,
                            github=github_from_env(environ))
        # Inside its container only; `deploy/compose.yml` publishes no host port, cloudflared is the only way in.
        uvicorn.run(hosted, host=environ.get("PLATEWAY_BIND_HOST", "127.0.0.1"),
                    port=int(environ.get("PLATEWAY_PORT", "8765")), **serve)
        return

    from cad.service.worker import Worker

    local_app = create_app(
        root,
        allowed_origin=environ.get("TRAIN_ALLOWED_ORIGIN", "http://127.0.0.1:8765"),
        # The local runner binds loopback only; `/api/session` stays for local scripts, never the browser app.
        local_member=True,
        github=github_from_env(environ),
    )
    # Locally the prepare worker runs beside the service; hosted, it is its own container (`python -m cad.service.worker`).
    threading.Thread(target=Worker(db.database_path(root), db.export_root(root), db.storage_root(root)).run_forever,
                     name="prepare-worker", daemon=True).start()
    uvicorn.run(local_app, host="127.0.0.1", port=8765, **serve)


if __name__ == "__main__":
    main()
