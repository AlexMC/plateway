"""Members' projects (R5, KTD2): owner-scoped rows in SQLite, one revision per save; the service mints every id.

A project's JSON stays a validated document blob. A save names the revision it was based on (`parentRevision`); a save
based on anything but the latest revision is refused with that revision, so a second tab or device never overwrites
newer work. Another member's project is indistinguishable from a missing one (404).
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from cad.service import db
from cad.service.accounts import Session
from cad.service.calibration import PROJECT_VERSION, validate_connector_settings

NAME_MAX = 120
NOT_FOUND = "Project not found"
REVISION_NOT_FOUND = "Project revision not found"
CONFLICT = "A newer save of this project exists."


class NotFound(Exception):
    pass


class Invalid(ValueError):
    """A request the member can fix; the message says how."""


class Conflict(Exception):
    """The save was based on an older revision; `latest` was saved since."""

    def __init__(self, latest: dict):
        super().__init__(CONFLICT)
        self.latest = latest


def canonical_id(value: object) -> str:
    """A canonical UUID string, or ValueError: ids reach SQL as values only, but noncanonical ones never match."""
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Noncanonical id")
    return value


def validate_project(project: dict) -> str:
    """The current format with a name and valid connector settings; returns the name as stored (trimmed)."""
    name = project.get("name")
    if project.get("version") != PROJECT_VERSION or not isinstance(name, str) or len(name.strip()) > NAME_MAX:
        raise ValueError("Invalid project")
    validate_connector_settings(project)
    canonical_id(project.get("id"))
    return name.strip()


def saved_at(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds")


def _row(row) -> dict:
    return {"id": row["project_id"], "revision": row["revision_id"], "name": row["name"], "savedAt": saved_at(row["created_at"])}


_LISTING = ("SELECT p.id AS project_id, r.id AS revision_id, p.name, r.created_at FROM revisions r "
            "JOIN projects p ON p.id = r.project_id AND p.owner_id = r.owner_id ")


class Projects:
    def __init__(self, database: Path, clock: Callable[[], float] = time.time):
        self.database = database
        self.clock = clock

    def _connect(self):
        return db.connect(self.database)

    def list(self, owner: str) -> list[dict]:
        """Every save of the owner's projects, newest first."""
        conn = self._connect()
        try:
            return [_row(row) for row in conn.execute(
                _LISTING + "WHERE r.owner_id = ? ORDER BY r.created_at DESC, r.number DESC", (owner,))]
        finally:
            conn.close()

    def revision(self, owner: str, project_id: str, revision_id: str) -> dict:
        """The saved document as the owner reopens it: the project's current name, and the ids the service minted."""
        conn = self._connect()
        try:
            row = conn.execute("SELECT r.body, p.name FROM revisions r JOIN projects p ON p.id = r.project_id AND "
                               "p.owner_id = r.owner_id WHERE r.id = ? AND r.project_id = ? AND r.owner_id = ?",
                               (revision_id, project_id, owner)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise NotFound(REVISION_NOT_FOUND)
        return {**json.loads(row["body"]), "id": project_id, "revision": revision_id, "name": row["name"]}

    @staticmethod
    def _latest(conn, owner: str, project_id: str):
        return conn.execute(_LISTING + "WHERE r.project_id = ? AND r.owner_id = ? ORDER BY r.number DESC LIMIT 1",
                            (project_id, owner)).fetchone()

    @staticmethod
    def _insert_revision(conn, owner: str, project_id: str, number: int, parent: str | None, project: dict,
                         name: str, now: int) -> None:
        revision_id = str(uuid.uuid4())
        body = {**project, "id": project_id, "revision": revision_id, "name": name, "parentRevision": parent}
        conn.execute("INSERT INTO revisions (id, project_id, owner_id, number, parent_revision, body, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (revision_id, project_id, owner, number, parent,
                      json.dumps(body, ensure_ascii=False, allow_nan=False), now))

    def create(self, owner: str, project: dict) -> tuple[dict, bool]:
        """A new project from a browser draft; `True` when created. The draft's own id is kept as `legacy_id`, so posting
        the same draft again (a second tab, signing in again) returns the project it already made, unchanged."""
        name = validate_project(project)
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                existing = conn.execute("SELECT id FROM projects WHERE owner_id = ? AND legacy_id = ?",
                                        (owner, project["id"])).fetchone()
                if existing is not None:
                    return _row(self._latest(conn, owner, existing["id"])), False
                project_id = str(uuid.uuid4())
                conn.execute("INSERT INTO projects (id, owner_id, name, legacy_id, created_at, updated_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)", (project_id, owner, name, project["id"], now, now))
                self._insert_revision(conn, owner, project_id, 1, None, project, name, now)
                return _row(self._latest(conn, owner, project_id)), True
        finally:
            conn.close()

    def save(self, owner: str, project_id: str, project: dict) -> dict:
        """A new revision on top of `parentRevision`, which must be the latest; its name becomes the project's."""
        name = validate_project(project)
        parent = canonical_id(project.get("parentRevision"))
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                latest = self._latest(conn, owner, project_id)
                if latest is None:
                    raise NotFound(NOT_FOUND)
                if latest["revision_id"] != parent:
                    raise Conflict(_row(latest))
                number = conn.execute("SELECT max(number) FROM revisions WHERE project_id = ?", (project_id,)).fetchone()[0]
                self._insert_revision(conn, owner, project_id, number + 1, parent, project, name, now)
                conn.execute("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", (name, now, project_id))
                return _row(self._latest(conn, owner, project_id))
        finally:
            conn.close()

    def rename(self, owner: str, project_id: str, name: object) -> dict:
        """Every save of the project takes the new name; save times, and so the list order, stay as they were."""
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > NAME_MAX:
            raise Invalid(f"Name must be 1-{NAME_MAX} characters")
        conn = self._connect()
        try:
            with db.transaction(conn):
                if not conn.execute("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                                    (name.strip(), int(self.clock()), project_id, owner)).rowcount:
                    raise NotFound(NOT_FOUND)
        finally:
            conn.close()
        return {"id": project_id, "name": name.strip()}

    def delete_revision(self, owner: str, project_id: str, revision_id: str) -> int:
        """One save; deleting a project's only save deletes the project."""
        conn = self._connect()
        try:
            with db.transaction(conn):
                if not conn.execute("DELETE FROM revisions WHERE id = ? AND project_id = ? AND owner_id = ?",
                                    (revision_id, project_id, owner)).rowcount:
                    raise NotFound(REVISION_NOT_FOUND)
                if self._latest(conn, owner, project_id) is None:
                    conn.execute("DELETE FROM projects WHERE id = ? AND owner_id = ?", (project_id, owner))
            return 1
        finally:
            conn.close()

    def delete(self, owner: str, project_id: str) -> int:
        """The project and every save of it; returns how many saves went."""
        conn = self._connect()
        try:
            with db.transaction(conn):
                saves = conn.execute("SELECT count(*) FROM revisions WHERE project_id = ? AND owner_id = ?",
                                     (project_id, owner)).fetchone()[0]
                if not conn.execute("DELETE FROM projects WHERE id = ? AND owner_id = ?", (project_id, owner)).rowcount:
                    raise NotFound(NOT_FOUND)
            return saves
        finally:
            conn.close()


def register(app: FastAPI, projects: Projects, member: Callable[..., Session],
             read_project: Callable[[Request], Awaitable[dict]]) -> None:
    """The `/api/projects` routes for signed-in members; `read_project` reads a size-limited JSON object body."""

    def ids(*values: str) -> None:
        try:
            for value in values:
                canonical_id(value)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid project identity") from exc

    async def call(work, *args):
        try:
            return await run_in_threadpool(work, *args)
        except NotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except Conflict as exc:
            return JSONResponse({"detail": CONFLICT, "latest": exc.latest}, status_code=409)
        except Invalid as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        except (ValueError, TypeError, KeyError):
            raise HTTPException(status_code=422, detail="Invalid project data") from None

    @app.get("/api/projects")
    async def list_projects(session: Session = Depends(member)) -> list[dict]:
        return await call(projects.list, session.member.id)

    @app.get("/api/projects/{project_id}/{revision_id}")
    async def get_project(project_id: str, revision_id: str, session: Session = Depends(member)):
        ids(project_id, revision_id)
        return await call(projects.revision, session.member.id, project_id, revision_id)

    @app.post("/api/projects", status_code=201)
    async def create_project(request: Request, response: Response, session: Session = Depends(member)):
        """201 with a new project; 200 with the project this draft already became."""
        saved, created = await call(projects.create, session.member.id, await read_project(request))
        if not created:
            response.status_code = 200
        return saved

    @app.post("/api/projects/{project_id}/revisions", status_code=201)
    async def save_revision(project_id: str, request: Request, session: Session = Depends(member)):
        """201 with the new revision; 409 with the latest one when the save was based on an older one."""
        ids(project_id)
        return await call(projects.save, session.member.id, project_id, await read_project(request))

    @app.patch("/api/projects/{project_id}")
    async def rename_project(project_id: str, request: Request, session: Session = Depends(member)):
        ids(project_id)
        body = await read_project(request)
        return await call(projects.rename, session.member.id, project_id, body.get("name"))

    @app.delete("/api/projects/{project_id}/{revision_id}")
    async def delete_revision(project_id: str, revision_id: str, session: Session = Depends(member)) -> dict[str, int]:
        ids(project_id, revision_id)
        return {"deleted": await call(projects.delete_revision, session.member.id, project_id, revision_id)}

    @app.delete("/api/projects/{project_id}")
    async def delete_project(project_id: str, session: Session = Depends(member)) -> dict[str, int]:
        ids(project_id)
        return {"deleted": await call(projects.delete, session.member.id, project_id)}
