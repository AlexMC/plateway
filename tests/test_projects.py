"""Members' projects in SQLite (U5, KTD2): owner-scoped, server-minted ids, stale saves conflict, local import."""
from contextlib import ExitStack
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from cad.service import db
from signed_in import session_headers, signed_in_client

HOST = "127.0.0.1:8765"
ORIGIN = f"http://{HOST}"
REPO = Path(__file__).resolve().parents[1]
IMPORT = REPO / "scripts" / "import-local-projects.py"


def project(name="Crossing"):
    return {"version": 5, "id": str(uuid.uuid4()), "revision": str(uuid.uuid4()), "name": name,
            "parentRevision": None, "provenance": {"account": None},
            "routes": [], "measurements": {}, "furniture": [], "trackSystem": "brick-v1",
            "connectorFit": {"adjustmentMm": 0, "settingsKey": None, "calibrationId": None}}


def saved_before_accounts(name):
    """A version-4 save from the local file store, before projects had an owner or a parent revision."""
    body = {**project(name), "version": 4}
    del body["parentRevision"], body["provenance"]
    return body


def member(root: Path, email="ada@example.com", name="Ada"):
    return signed_in_client(root, ORIGIN, expected_host=HOST, email=email, display_name=name)


def create(app, body):
    response = app.post("/api/projects", json=body, headers=session_headers(app, ORIGIN))
    assert response.status_code == 201, response.text
    return response.json()


def save(app, saved, body, parent):
    return app.post(f"/api/projects/{saved['id']}/revisions", json={**body, "parentRevision": parent},
                    headers=session_headers(app, ORIGIN))


def test_create_mints_ids_and_reopens_the_saved_layout(tmp_path):
    with member(tmp_path) as app:
        body = project()
        saved = create(app, body)
        assert saved["id"] != body["id"] and saved["revision"] != body["revision"]
        assert {str(uuid.UUID(saved["id"])), str(uuid.UUID(saved["revision"]))} == {saved["id"], saved["revision"]}
        reopened = app.get(f"/api/projects/{saved['id']}/{saved['revision']}").json()
        assert reopened == {**body, "id": saved["id"], "revision": saved["revision"]}
        assert app.get("/api/projects").json() == [saved]


def test_posting_the_same_draft_again_returns_its_project_instead_of_a_duplicate(tmp_path):
    with member(tmp_path) as app:
        body = project()
        first = create(app, body)
        again = app.post("/api/projects", json={**body, "name": "Edited meanwhile"}, headers=session_headers(app, ORIGIN))
        assert again.status_code == 200
        assert again.json() == first
        assert len(app.get("/api/projects").json()) == 1


def test_a_save_from_the_latest_revision_lands_and_a_stale_one_conflicts(tmp_path):
    with member(tmp_path) as app:
        body = project()
        saved = create(app, body)
        second = save(app, saved, {**body, "name": "Second"}, saved["revision"])
        assert second.status_code == 201, second.text
        assert second.json()["id"] == saved["id"] and second.json()["revision"] != saved["revision"]
        stale = save(app, saved, {**body, "name": "From another tab"}, saved["revision"])
        assert stale.status_code == 409
        assert stale.json()["latest"] == second.json()
        assert [row["revision"] for row in app.get("/api/projects").json()] == [second.json()["revision"], saved["revision"]]
        assert save(app, saved, body, "not-a-uuid").status_code == 422


def test_saves_list_newest_first_and_a_rename_names_every_save_without_reordering(tmp_path):
    now = [2_000_000_000.0]
    with signed_in_client(tmp_path, ORIGIN, expected_host=HOST, clock=lambda: now[0]) as app:
        headers = session_headers(app, ORIGIN)
        first = create(app, project("Loop"))
        now[0] += 600
        other = create(app, project("Other"))
        now[0] += 600
        second = save(app, first, project("Loop"), first["revision"]).json()
        before = app.get("/api/projects").json()
        assert [row["revision"] for row in before] == [second["revision"], other["revision"], first["revision"]]
        assert datetime.fromisoformat(before[0]["savedAt"]).timestamp() == 2_000_001_200
        assert app.patch(f"/api/projects/{first['id']}", json={"name": "Kallax"}, headers={"Origin": ORIGIN}).status_code == 403
        assert app.patch(f"/api/projects/{first['id']}", json={"name": " "}, headers=headers).status_code == 422
        assert app.patch(f"/api/projects/{first['id']}", json={"name": "  Kallax loop "}, headers=headers).status_code == 200
        after = app.get("/api/projects").json()
        assert [(row["revision"], row["savedAt"]) for row in after] == [(row["revision"], row["savedAt"]) for row in before]
        assert [row["name"] for row in after] == ["Kallax loop", "Other", "Kallax loop"]
        assert app.get(f"/api/projects/{first['id']}/{first['revision']}").json()["name"] == "Kallax loop"
        assert app.patch(f"/api/projects/{uuid.uuid4()}", json={"name": "x"}, headers=headers).status_code == 404


def test_delete_removes_one_save_or_the_whole_project(tmp_path):
    with member(tmp_path) as app:
        headers = session_headers(app, ORIGIN)
        first, other = create(app, project()), create(app, project())
        second = save(app, first, project(), first["revision"]).json()
        assert app.delete(f"/api/projects/{first['id']}/{first['revision']}", headers={"Origin": ORIGIN}).status_code == 403
        assert app.delete(f"/api/projects/{first['id']}/{first['revision']}", headers=headers).json() == {"deleted": 1}
        assert {row["revision"] for row in app.get("/api/projects").json()} == {second["revision"], other["revision"]}
        assert app.delete(f"/api/projects/{first['id']}/{first['revision']}", headers=headers).status_code == 404
        assert app.delete(f"/api/projects/{first['id']}", headers=headers).json() == {"deleted": 1}
        assert [row["id"] for row in app.get("/api/projects").json()] == [other["id"]]
        assert app.delete(f"/api/projects/{first['id']}", headers=headers).status_code == 404
        # The last save of a project takes the project with it.
        assert app.delete(f"/api/projects/{other['id']}/{other['revision']}", headers=headers).json() == {"deleted": 1}
        assert app.get("/api/projects").json() == []
        assert app.delete("/api/projects/not-a-uuid", headers=headers).status_code == 422


def test_a_member_cannot_reach_another_members_projects(tmp_path):
    with ExitStack() as stack:
        ada = stack.enter_context(member(tmp_path))
        bob = stack.enter_context(member(tmp_path, "bob@example.com", "Bob"))
        mine = create(ada, project("Ada's layout"))
        headers = session_headers(bob, ORIGIN)
        assert bob.get("/api/projects").json() == []
        assert bob.get(f"/api/projects/{mine['id']}/{mine['revision']}").status_code == 404
        assert bob.patch(f"/api/projects/{mine['id']}", json={"name": "Taken"}, headers=headers).status_code == 404
        assert save(bob, mine, project(), mine["revision"]).status_code == 404
        assert bob.delete(f"/api/projects/{mine['id']}/{mine['revision']}", headers=headers).status_code == 404
        assert bob.delete(f"/api/projects/{mine['id']}", headers=headers).status_code == 404
        # The same browser draft posted by another member becomes that member's own project.
        body = project()
        assert create(ada, body)["id"] != create(bob, body)["id"]
        assert ada.get(f"/api/projects/{mine['id']}/{mine['revision']}").json()["name"] == "Ada's layout"
        assert [row["name"] for row in bob.get("/api/projects").json()] == ["Crossing"]


def test_rejects_other_versions_unsafe_ids_and_oversized_projects(tmp_path):
    with member(tmp_path) as app:
        headers = session_headers(app, ORIGIN)
        for bad in ({**project(), "version": 4}, {**project(), "id": "../../escape"}, {**project(), "name": 7},
                    {**project(), "connectorFit": {"adjustmentMm": 1}}):
            assert app.post("/api/projects", json=bad, headers=headers).status_code == 422
        huge = {**project(), "notes": "x" * 2_000_001}
        assert app.post("/api/projects", json=huge, headers=headers).status_code == 413
        assert app.get(f"/api/projects/{uuid.uuid4()}/not-a-uuid").status_code == 422
        assert app.get("/api/projects").json() == []


def test_visitors_cannot_reach_projects(tmp_path):
    with member(tmp_path) as app:
        app.post("/api/auth/logout", headers=session_headers(app, ORIGIN))
        assert app.get("/api/projects").status_code == 401
        assert app.post("/api/projects", json=project(), headers={"Origin": ORIGIN}).status_code == 401


def local_projects(root: Path) -> dict[str, list[dict]]:
    """A `.projects` folder as the file store left it: `<id>-<revision>.json` per save, and calibration results."""
    first, second = saved_before_accounts("Harbour"), saved_before_accounts("Yard")
    later = {**first, "revision": str(uuid.uuid4()), "name": "Harbour v2"}
    for body, mtime in ((first, 1_700_000_000), (later, 1_700_000_600), (second, 1_700_000_300)):
        path = root / f"{body['id']}-{body['revision']}.json"
        path.write_text(json.dumps(body))
        os.utime(path, (mtime, mtime))
    (root / "calibrations").mkdir()
    result = {"id": str(uuid.uuid4()), "settingsKey": "key", "trackSystem": "brick-v1", "adjustmentMm": 0.05,
              "result": "fits", "notes": "", "receiptId": "trial-1", "recordedAt": "2026-09-30T10:00:00.000000+00:00",
              "conditions": {"printer": "X1 Carbon"}, "parameters": {}, "calibrationProcessVersion": 1}
    (root / "calibrations" / f"{result['id']}.json").write_text(json.dumps(result))
    return {"Harbour": [first, later], "Yard": [second], "calibrations": [result]}


def run_import(source: Path, database: Path, email: str) -> str:
    done = subprocess.run([sys.executable, str(IMPORT), str(source), "--db", str(database), "--email", email],
                          capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return done.stdout


def test_importing_local_projects_twice_imports_each_save_and_result_once(tmp_path):
    source = tmp_path / "local"
    source.mkdir()
    local = local_projects(source)
    root = tmp_path / "service"
    with member(root) as app:
        pass
    database = db.database_path(root)
    run_import(source, database, "ada@example.com")
    run_import(source, database, "ADA@example.com")
    with member(root) as app:
        listed = app.get("/api/projects").json()
        assert [row["name"] for row in listed] == ["Harbour v2", "Yard", "Harbour v2"]
        harbour = [row for row in listed if row["id"] == listed[0]["id"]]
        assert len(harbour) == 2
        assert {row["id"] for row in listed}.isdisjoint({body["id"] for body in local["Harbour"] + local["Yard"]})
        reopened = app.get(f"/api/projects/{harbour[1]['id']}/{harbour[1]['revision']}").json()
        assert reopened == {**local["Harbour"][0], "id": harbour[1]["id"], "revision": harbour[1]["revision"],
                            "name": "Harbour v2"}
    conn = db.connect(database)
    calibrations = conn.execute("SELECT id, result, receipt_digest, record FROM calibrations").fetchall()
    assert [(row["id"], row["result"], row["receipt_digest"]) for row in calibrations] == [(local["calibrations"][0]["id"], "fits", None)]
    assert json.loads(calibrations[0]["record"]) == local["calibrations"][0]
    # A browser draft of an imported project adopts it rather than duplicating it.
    with member(root) as app:
        draft = {**local["Yard"][0], "version": 5}
        assert app.post("/api/projects", json=draft, headers=session_headers(app, ORIGIN)).status_code == 200


def test_import_refuses_an_unknown_account_and_never_changes_the_local_folder(tmp_path):
    source = tmp_path / "local"
    source.mkdir()
    local_projects(source)
    before = {path: path.read_bytes() for path in source.rglob("*.json")}
    root = tmp_path / "service"
    with member(root):
        pass
    done = subprocess.run([sys.executable, str(IMPORT), str(source), "--db", str(db.database_path(root)),
                           "--email", "nobody@example.com"], capture_output=True, text=True)
    assert done.returncode != 0
    assert "No account" in done.stderr
    run_import(source, db.database_path(root), "ada@example.com")
    assert {path: path.read_bytes() for path in source.rglob("*.json")} == before
