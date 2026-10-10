"""Contributions (U15, R17, R18, KTD10): upload with the automatic check, the daily limit, Alex's quick look and the
contributor's view of each outcome."""
import base64
from contextlib import ExitStack
import itertools
import json
from pathlib import Path

from cad.service import db
from cad.service.mailer import FileSink
from cad.service.projects import saved_at
from cad.service.submissions import Submissions
from signed_in import session_headers, signed_in_client
from test_gallery import make_admin, visitor
from test_library_check import SLAB, stl

HOST = "127.0.0.1:8765"
ORIGIN = f"http://{HOST}"
DAY = 24 * 3600
LIBRARY = Path(__file__).resolve().parent / "fixtures" / "library"
INDEX = {item["id"]: item for item in json.loads((LIBRARY / "index.json").read_text())["items"]}
CURVE, LOCO = INDEX["community_sample_curve_90"], INDEX["community_sample_loco"]
CURVE_STL = (LIBRARY / CURVE["file"]).read_bytes()
FORM = json.loads((LIBRARY / "furniture-form.json").read_text())


class Clock:
    def __init__(self):
        self.ticks = itertools.count(1_800_000_000)
        self.offset = 0

    def __call__(self):
        return next(self.ticks) + self.offset

    def advance(self, seconds):
        self.offset += seconds


def member(stack, root, clock, email="ada@example.com", name="Ada"):
    return stack.enter_context(signed_in_client(root, ORIGIN, expected_host=HOST, email=email, display_name=name, clock=clock))


def admin(stack, root, clock):
    client = member(stack, root, clock, "alex@example.com", "Alex")
    make_admin(root, "alex@example.com")
    return client


def send(client, kind="piece", metadata=None, data=CURVE_STL, licence="CC-BY-4.0", **extra):
    body = {"kind": kind, "licence": licence, "attest": True,
            "metadata": metadata or {"name": "Sample curve", "ends": CURVE["piece"]["ends"]}, **extra}
    if data is not None:
        body["file"] = base64.b64encode(data).decode()
    return client.post("/api/submissions", json=body, headers=session_headers(client, ORIGIN))


def mails(root, to):
    return [message for message in (json.loads(path.read_text()) for path in sorted((root / "mail").glob("*.json")))
            if message["to"] == to]


def bot_queue(root):
    return Submissions(db.database_path(root), FileSink(root / "mail"), ORIGIN).awaiting_pull_request()


def test_a_checked_upload_waits_for_the_quick_look_and_tells_the_admins(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        sent = send(ada)
        assert sent.status_code == 201, sent.text
        upload = sent.json()
        assert upload | {"id": None, "uploadedAt": None} == {
            "id": None, "kind": "piece", "state": "awaiting_look", "name": "Sample curve", "author": "Ada",
            "licence": "CC-BY-4.0", "reason": None, "uploadedAt": None, "reviewedAt": None,
            "metadata": {"id": "community_sample_curve", "name": "Sample curve", "ends": CURVE["piece"]["ends"]}}
        mine = ada.get("/api/submissions").json()
        assert [item["id"] for item in mine["submissions"]] == [upload["id"]]
        assert (mine["left"], mine["canReview"]) == (4, False)
    [mail] = mails(tmp_path, "alex@example.com")[-1:]
    assert mail["subject"] == "Plateway: upload awaiting review: Sample curve"
    assert f"{ORIGIN}/app/#review={upload['id']}" in mail["text"]


def test_an_upload_that_fails_the_check_is_refused_with_why_and_not_kept(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock)
        holes = send(ada, data=stl(SLAB[:-1]), metadata={"name": "Holey", "ends": []})
        assert (holes.status_code, holes.json()["detail"]) == (
            422, "The mesh has holes: it must be a closed solid. Repair it in your CAD program or slicer.")
        unattested = ada.post("/api/submissions", json={"kind": "piece", "licence": "CC-BY-4.0", "metadata": {}},
                              headers=session_headers(ada, ORIGIN))
        assert unattested.status_code == 422
        mine = ada.get("/api/submissions").json()
        # Nothing kept, but the checked attempt counts toward this hour's cap.
        assert (mine["submissions"], mine["left"], mine["limit"]) == ([], 4, "attempts_hour")


def test_rejecting_needs_a_reason_which_the_contributor_sees_and_nothing_reaches_github(tmp_path):
    """AE5: an upload Alex rejects in Plateway never reaches GitHub, and the contributor sees "Rejected" with why."""
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        upload = send(ada).json()
        path = f"/api/admin/submissions/{upload['id']}"
        assert alex.get(f"{path}/file").content == CURVE_STL
        silent = alex.post(f"{path}/reject", json={"reason": "  "}, headers=session_headers(alex, ORIGIN))
        assert silent.status_code == 422
        assert alex.get(path).json()["state"] == "awaiting_look"
        rejected = alex.post(f"{path}/reject", json={"reason": "The rails stop 3 mm short of the end face."},
                             headers=session_headers(alex, ORIGIN))
        assert rejected.status_code == 200, rejected.text
        [mine] = ada.get("/api/submissions").json()["submissions"]
        assert (mine["state"], mine["reason"]) == ("rejected", "The rails stop 3 mm short of the end face.")
        # Its metadata stays, so "Submit a corrected version" can fill the form in again.
        assert mine["metadata"] == upload["metadata"]
        assert alex.get(f"{path}/file").status_code == 404
        again = alex.post(f"{path}/approve", headers=session_headers(alex, ORIGIN))
        assert again.status_code == 409
    assert bot_queue(tmp_path) == []


def test_approving_hands_the_upload_to_the_github_bot(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        upload = send(ada).json()
        approved = alex.post(f"/api/admin/submissions/{upload['id']}/approve", headers=session_headers(alex, ORIGIN))
        assert approved.json()["state"] == "approved"
        assert ada.get("/api/submissions").json()["submissions"][0]["state"] == "approved"
        queue = alex.get("/api/admin/submissions").json()
        assert (queue["waiting"], [item["id"] for item in queue["reviewed"]]) == ([], [upload["id"]])
    [handed] = bot_queue(tmp_path)
    assert (handed["id"], handed["file"], handed["data"], handed["metadata"]["id"]) == (
        upload["id"], "piece.stl", CURVE_STL, "community_sample_curve")


def test_a_members_sixth_upload_in_a_day_is_refused(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock)
        ids = [send(ada).json()["metadata"]["id"] for _ in range(5)]
        assert ids == ["community_sample_curve"] + [f"community_sample_curve_{n}" for n in range(2, 6)]
        sixth = send(ada)
        assert sixth.status_code == 429
        assert "5 uploads today" in sixth.json()["detail"] and sixth.json()["resetsAt"]
        # The hour's attempts are spent too, but the stored-upload cap frees up later, so it is the one that binds.
        mine = ada.get("/api/submissions").json()
        assert (mine["left"], mine["limit"], mine["resetsAt"]) == (0, "uploads", sixth.json()["resetsAt"])
        clock.advance(DAY)
        assert send(ada).status_code == 201


def test_refused_uploads_count_toward_the_attempt_cap(tmp_path):
    """Every upload runs the heavy check, so refused ones count too: 5 attempts an hour, 15 a day."""
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock)
        bad = {"data": stl(SLAB[:-1]), "metadata": {"name": "Holey", "ends": []}}
        assert [send(ada, **bad).status_code for _ in range(5)] == [422] * 5
        sixth = send(ada)
        assert sixth.status_code == 429
        assert "5 uploads this hour" in sixth.json()["detail"] and sixth.json()["resetsAt"]
        for _ in range(2):
            clock.advance(3600)
            assert [send(ada, **bad).status_code for _ in range(5)] == [422] * 5
        clock.advance(3600)
        refused = send(ada)
        assert refused.status_code == 429
        assert "15 uploads today" in refused.json()["detail"] and refused.json()["resetsAt"]
        clock.advance(DAY - 3 * 3600)
        assert send(ada).status_code == 201


def test_uploads_left_reports_the_attempt_cap_that_binds(tmp_path):
    """Refused uploads leave the stored-upload count alone, so `left` must follow the attempt caps too: the panel
    should never offer an upload the next request refuses."""
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock)
        bad = {"data": stl(SLAB[:-1]), "metadata": {"name": "Holey", "ends": []}}
        assert [send(ada, **bad).status_code for _ in range(4)] == [422] * 4
        mine = ada.get("/api/submissions").json()
        assert (mine["left"], mine["limit"]) == (1, "attempts_hour")
        assert send(ada, **bad).status_code == 422
        conn = db.connect(db.database_path(tmp_path))
        first = conn.execute("SELECT min(at) FROM audit_events WHERE kind = 'upload_attempt'").fetchone()[0]
        conn.close()
        mine = ada.get("/api/submissions").json()
        assert (mine["left"], mine["limit"], mine["resetsAt"]) == (0, "attempts_hour", saved_at(first + 3600))
        assert send(ada).json()["resetsAt"] == mine["resetsAt"]
        clock.advance(3600)
        mine = ada.get("/api/submissions").json()
        assert (mine["left"], mine["resetsAt"]) == (5, None)
        assert send(ada).status_code == 201


def test_an_admin_is_not_held_to_the_upload_caps(tmp_path):
    """Admins are trusted, and seeding the library through the real flow would otherwise take days."""
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        bad = {"data": stl(SLAB[:-1]), "metadata": {"name": "Holey", "ends": []}}
        assert [send(alex, **bad).status_code for _ in range(5)] == [422] * 5
        assert [send(alex).status_code for _ in range(16)] == [201] * 16
        mine = alex.get("/api/submissions").json()
        assert (len(mine["submissions"]), mine["left"], mine["limit"], mine["resetsAt"]) == (16, None, None, None)
        assert [send(ada).status_code for _ in range(6)] == [201] * 5 + [429]


def test_only_admins_reach_the_quick_look(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        upload = send(ada).json()
        path = f"/api/admin/submissions/{upload['id']}"
        for client in (ada, stack.enter_context(visitor(tmp_path, clock))):
            assert client.get("/api/admin/submissions").status_code == 404
            assert client.get(path).status_code == 404
            assert client.get(f"{path}/file").status_code == 404
        assert ada.post(f"{path}/approve", headers=session_headers(ada, ORIGIN)).status_code == 404
        assert alex.get(path).json()["file"] == {"name": "piece.stl", "bytes": len(CURVE_STL)}
        assert alex.get("/api/submissions").json()["canReview"] is True


def test_the_furniture_form_and_an_adapted_train_are_accepted(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        table = send(ada, "furniture", {"name": "Shelf table", "design": FORM["design"], "type": FORM["type"]}, data=None)
        assert table.status_code == 201, table.text
        preset = json.loads(alex.get(f"/api/admin/submissions/{table.json()['id']}/file").content)
        assert (preset["family"], preset["label"]) == ("community_shelf_table", "Shelf table")
        assert table.json()["metadata"] == {"id": "community_shelf_table", "name": "Shelf table", "design": FORM["design"]}
        car = LOCO["train"]["car"]
        fields = {"name": "Sample locomotive", **{key: LOCO["train"][key] for key in ("year", "power", "gauge")},
                  "car": {"kind": car["kind"], "motorised": car["motorised"], "bogies": car["bogies"], "couplers": car["couplers"]},
                  "source": {"url": "https://library.ldraw.org/omr/sets/700-1", "authors": ["Michael Heidemann"]}}
        loco = send(ada, "train", fields, data=(LIBRARY / LOCO["file"]).read_bytes(), licence="CC-BY-2.0")
        assert loco.status_code == 201, loco.text
        measured = loco.json()["metadata"]["car"]
        assert {key: measured[key] for key in ("length", "width", "height", "wheelbase", "triangles")} == {
            key: car[key] for key in ("length", "width", "height", "wheelbase", "triangles")}
        assert loco.json()["licence"] == "CC-BY-2.0"
        unsourced = send(ada, "train", {**fields, "source": None}, data=(LIBRARY / LOCO["file"]).read_bytes(),
                         licence="CC-BY-2.0")
        assert (unsourced.status_code, unsourced.json()["detail"]) == (422, "A model of your own is shared under CC BY 4.0.")


def test_a_piece_adapted_from_a_cc_by_model_keeps_its_source_and_a_malformed_source_is_refused(tmp_path):
    clock = Clock()
    lev = {"url": "https://www.printables.com/model/466240", "authors": ["lev"]}
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock)
        adapted = send(ada, metadata={"name": "Sample curve", "ends": CURVE["piece"]["ends"], "source": lev})
        assert adapted.status_code == 201, adapted.text
        assert (adapted.json()["licence"], adapted.json()["metadata"]["source"]) == ("CC-BY-4.0", lev)
        nameless = send(ada, metadata={"name": "Sample curve", "ends": CURVE["piece"]["ends"],
                                       "source": {**lev, "authors": []}})
        assert (nameless.status_code, nameless.json()["detail"]) == (422, "An adapted model needs its source's authors.")
