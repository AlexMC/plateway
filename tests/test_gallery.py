"""The community gallery (U12, KTD11): stripped publishing, remix credit, reports and moderation."""
from contextlib import ExitStack, contextmanager
import itertools
import json
import uuid

from fastapi.testclient import TestClient

from cad.service import db, gallery
from cad.service.app import create_app
from cad.service.mailer import FileSink
from signed_in import PASSWORD, session_headers, signed_in_client

HOST = "127.0.0.1:8765"
ORIGIN = f"http://{HOST}"
HOUR = 3600
THUMBNAIL = {"box": [0, -600, 1200, 600], "tracks": [{"points": [0, 0, 600, 0, 1200, -300], "owned": True}],
             "shelves": [[100, -500, 400, 200]]}


class Clock:
    """Each read is a second later, so publish order is unambiguous; `advance` jumps ahead."""

    def __init__(self):
        self.ticks = itertools.count(1_800_000_000)
        self.offset = 0

    def __call__(self):
        return next(self.ticks) + self.offset

    def advance(self, seconds):
        self.offset += seconds


def layout(name="Harbour loop", **overrides):
    """A member's whole project, private parts included: inventory, observations, a +0.10 mm fit, an A1 mini setup."""
    return {
        "version": 5, "id": str(uuid.uuid4()), "revision": str(uuid.uuid4()), "layoutRevision": str(uuid.uuid4()),
        "name": name, "trackSystem": "brick-v1",
        "connectorFit": {"adjustmentMm": 0.1, "settingsKey": "a1-mini-pla", "calibrationId": str(uuid.uuid4())},
        "measurements": {"roomWidth": {"value": 2400, "source": "Entered in Setup", "measuredAt": "2026-10-01"}},
        "routes": [{"id": "r1", "name": "Main line", "points": [], "pieces": [
            {"id": "p1", "family": "brick_straight_nominal", "x": 0, "y": 0, "rotation": 0}]}],
        "crossings": [], "furniture": [], "inventory": {"brick_straight_nominal": 16, "brick_curve_r40": 8},
        "partDesign": {"joint_clearance": 0.2}, "cars": [], "printer": "A1 mini", "material": "PETG",
        "mounting": "reversible", "printSettings": {"profile": "0.12mm Fine", "nozzleMm": 0.2, "orientation": "flat"},
        "observations": [{"id": "o1", "kind": "fit", "passed": True, "material": "PETG", "printer": "A1 mini",
                          "orientation": "flat", "consistId": "c1", "notes": "snug", "recordedAt": "2026-10-01"}],
        "provenance": {"account": "someone"}, "parentRevision": str(uuid.uuid4()), **overrides,
    }


def credit(detail):
    return {"id": detail["id"], "title": detail["title"], "author": detail["author"], "licence": detail["licence"]}


def member(stack, root, clock, email, name):
    return stack.enter_context(signed_in_client(root, ORIGIN, expected_host=HOST, email=email, display_name=name,
                                                clock=clock))


@contextmanager
def visitor(root, clock, ip="203.0.113.7"):
    app = create_app(root, expected_host=HOST, allowed_origin=ORIGIN, mailer=FileSink(root / "mail"), clock=clock)
    with TestClient(app, base_url=ORIGIN, headers={"CF-Connecting-IP": ip}) as client:
        yield client


def make_admin(root, email):
    conn = db.connect(db.database_path(root))
    try:
        conn.execute("UPDATE users SET is_admin = 1 WHERE email = ?", (email,))
    finally:
        conn.close()


def publish(client, project, title="Harbour loop", description="Two stations.", thumbnail=THUMBNAIL):
    return client.post("/api/gallery", json={"title": title, "description": description, "project": project,
                                             "thumbnail": thumbnail}, headers=session_headers(client, ORIGIN))


def published(client, project, **options):
    response = publish(client, project, **options)
    assert response.status_code == 201, response.text
    return response.json()


def listed(client):
    return [item["id"] for item in client.get("/api/gallery").json()["layouts"]]


def mail_to(root, address, subject):
    messages = [json.loads(path.read_text()) for path in sorted((root / "mail").glob("*.json"))]
    return [message for message in messages if message["to"] == address and subject in message["subject"]]


def test_a_published_copy_carries_none_of_the_authors_private_data_and_credits_them(tmp_path):
    """Covers AE7, R14, R25, R26: whatever the browser sends, the shared copy has no inventory, observations, fit
    calibration, printer, material, print settings or account."""
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        project = layout()
        shared = published(ada, project)
        assert (shared["author"], shared["licence"], shared["title"], shared["pieces"]) == ("Ada", "CC-BY-4.0", "Harbour loop", 1)
        with visitor(tmp_path, clock) as anyone:
            body = anyone.get(f"/api/gallery/{shared['id']}").json()["project"]
        assert body["inventory"] == {} and body["observations"] == []
        assert body["connectorFit"] == {"adjustmentMm": 0, "settingsKey": None, "calibrationId": None}
        assert (body["printer"], body["material"]) == ("X1 Carbon", None)
        assert body["printSettings"] == {"profile": None, "nozzleMm": None, "orientation": "flat"}
        assert body["provenance"] == {"account": None} and body["parentRevision"] is None
        assert body["id"] == shared["id"] and body["id"] != project["id"]
        assert body["routes"] == project["routes"] and body["measurements"] == project["measurements"]
        assert "A1 mini" not in json.dumps(body) and "PETG" not in json.dumps(body)


def test_the_gallery_lists_newest_first_for_anyone_without_an_account(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        first = published(ada, layout(), title="First")
        second = published(ada, layout(), title="Second")
        with visitor(tmp_path, clock) as anyone:
            page = anyone.get("/api/gallery").json()
            assert [item["title"] for item in page["layouts"]] == ["Second", "First"]
            assert page["next"] is None
            card = page["layouts"][1]
            assert card["thumbnail"] == THUMBNAIL and card["description"] == "Two stations." and not card["mine"]
            assert anyone.get(f"/api/gallery/{first['id']}").status_code == 200
        card = ada.get("/api/gallery").json()["layouts"][0]
        assert card["mine"] and card == {key: value for key, value in second.items()
                                         if key not in {"project", "ancestors", "canModerate"}}


def test_publishing_needs_a_verified_member(tmp_path):
    clock = Clock()
    with visitor(tmp_path, clock) as anyone:
        refused = anyone.post("/api/gallery", json={"title": "Mine", "project": layout(), "thumbnail": THUMBNAIL},
                              headers={"Origin": ORIGIN})
        assert refused.status_code == 401
        assert anyone.post("/api/auth/signup", json={"email": "new@example.com", "password": PASSWORD,
                                                     "displayName": "Newcomer"}, headers={"Origin": ORIGIN}).status_code == 202
        assert anyone.post("/api/auth/login", json={"email": "new@example.com", "password": PASSWORD},
                           headers={"Origin": ORIGIN}).status_code == 200
        assert publish(anyone, layout()).status_code == 403
        assert anyone.get("/api/gallery").json()["layouts"] == []


def test_a_thumbnail_is_structured_data_never_an_image(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        for thumbnail in ('<svg onload="alert(1)"/>', "data:image/png;base64,AAAA",
                          {**THUMBNAIL, "svg": "<svg/>"}, {**THUMBNAIL, "tracks": [{"points": ["M0 0"], "owned": True}]},
                          {**THUMBNAIL, "box": [0, 0, 0.5, 100]}):
            assert publish(ada, layout(), thumbnail=thumbnail).status_code == 422
        assert publish(ada, layout(routes=[])).status_code == 422
        assert listed(ada) == []


def test_a_remix_of_a_remix_credits_both_ancestors_with_their_names_at_publish_time(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        bob = member(stack, tmp_path, clock, "bob@example.com", "Bob")
        cat = member(stack, tmp_path, clock, "cat@example.com", "Cat")
        original = published(ada, layout(), title="Harbour loop")
        remix = published(bob, layout(ancestors=[credit(original)]), title="Harbour loop with yard")
        assert remix["remixOf"] == credit(original)
        renamed = ada.patch("/api/account", json={"displayName": "Ada Lovelace"}, headers=session_headers(ada, ORIGIN))
        assert renamed.status_code == 200
        forged = [{**credit(remix), "author": "Someone else"}, {**credit(original), "title": "Not this"}]
        again = published(cat, layout(ancestors=forged), title="Harbour loop, third take")
        assert again["ancestors"] == [credit(remix), credit(original)]
        assert again["ancestors"][1]["author"] == "Ada" and again["author"] == "Cat"
        assert published(ada, layout())["author"] == "Ada Lovelace"
        # The parent is unpublished: the gallery kept its credit, and the chain still reaches the original.
        assert bob.delete(f"/api/gallery/{remix['id']}", headers=session_headers(bob, ORIGIN)).status_code == 200
        fourth = published(cat, layout(ancestors=again["ancestors"]), title="Fourth")
        assert fourth["ancestors"] == [credit(remix), credit(original)]


def test_a_reported_layout_stays_listed_until_an_admin_hides_it_then_only_they_and_its_author_open_it(tmp_path):
    """Covers AE6, R16: a report emails the admins; hiding emails the author with the reason; remixes stay visible."""
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        bob = member(stack, tmp_path, clock, "bob@example.com", "Bob")
        alex = member(stack, tmp_path, clock, "alex@example.com", "Alex")
        make_admin(tmp_path, "alex@example.com")
        reported = published(ada, layout(), title="Rude words")
        remix = published(bob, layout(ancestors=[credit(reported)]), title="Clean version")
        anyone = stack.enter_context(visitor(tmp_path, clock))
        assert anyone.post(f"/api/gallery/{reported['id']}/report", json={"reason": "Offensive title"},
                           headers={"Origin": ORIGIN}).status_code == 202
        assert reported["id"] in listed(anyone)
        [alert] = mail_to(tmp_path, "alex@example.com", "reported")
        assert "Offensive title" in alert["text"] and f"#gallery={reported['id']}" in alert["text"]
        assert alex.get("/api/gallery").json()["layouts"][1]["openReports"] == 1
        assert [item["reason"] for item in alex.get(f"/api/gallery/{reported['id']}").json()["reports"]] == ["Offensive title"]

        assert bob.post(f"/api/gallery/{reported['id']}/hide", json={"reason": "x"},
                        headers=session_headers(bob, ORIGIN)).status_code == 404
        hidden = alex.post(f"/api/gallery/{reported['id']}/hide", json={"reason": "Breaks the gallery rules"},
                           headers=session_headers(alex, ORIGIN))
        assert hidden.status_code == 200 and hidden.json()["hidden"]["reason"] == "Breaks the gallery rules"
        assert listed(anyone) == [remix["id"]] and listed(bob) == [remix["id"]]
        assert anyone.get(f"/api/gallery/{reported['id']}").status_code == 404
        assert bob.get(f"/api/gallery/{reported['id']}").status_code == 404
        assert ada.get(f"/api/gallery/{reported['id']}").json()["hidden"]["reason"] == "Breaks the gallery rules"
        assert alex.get(f"/api/gallery/{reported['id']}").status_code == 200
        assert anyone.get(f"/api/gallery/{remix['id']}").json()["remixOf"] == credit(reported)
        [notice] = mail_to(tmp_path, "ada@example.com", "hidden")
        assert "Breaks the gallery rules" in notice["text"]

        shown = alex.post(f"/api/gallery/{reported['id']}/unhide", headers=session_headers(alex, ORIGIN))
        assert shown.status_code == 200 and "hidden" not in shown.json() and shown.json()["openReports"] == 0
        assert listed(anyone) == [remix["id"], reported["id"]]


def test_anyone_can_report_without_a_session_five_times_an_hour(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        target = published(ada, layout())
        report = lambda client: client.post(f"/api/gallery/{target['id']}/report", json={"reason": "Spam"},
                                            headers={"Origin": ORIGIN})
        with visitor(tmp_path, clock) as anyone:
            assert [report(anyone).status_code for _ in range(6)] == [202] * 5 + [429]
            assert anyone.post(f"/api/gallery/{target['id']}/report", json={"reason": "Spam"}).status_code == 403
        with visitor(tmp_path, clock, ip="198.51.100.2") as elsewhere:
            assert report(elsewhere).status_code == 202
        clock.advance(HOUR)
        with visitor(tmp_path, clock) as anyone:
            assert report(anyone).status_code == 202
            assert anyone.post(f"/api/gallery/{uuid.uuid4()}/report", json={"reason": "Spam"},
                               headers={"Origin": ORIGIN}).status_code == 404


def test_an_author_unpublishes_only_their_own_layout(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        bob = member(stack, tmp_path, clock, "bob@example.com", "Bob")
        mine = published(ada, layout())
        assert bob.delete(f"/api/gallery/{mine['id']}", headers=session_headers(bob, ORIGIN)).status_code == 404
        assert listed(bob) == [mine["id"]]
        assert ada.delete(f"/api/gallery/{mine['id']}", headers=session_headers(ada, ORIGIN)).status_code == 200
        assert listed(bob) == [] and ada.get(f"/api/gallery/{mine['id']}").status_code == 404


def test_a_made_up_ancestor_is_dropped_and_one_that_left_the_gallery_keeps_its_credit(tmp_path):
    """Covers R15, R25: a remix credits only layouts the gallery has published, even after they leave it."""
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        bob = member(stack, tmp_path, clock, "bob@example.com", "Bob")
        cat = member(stack, tmp_path, clock, "cat@example.com", "Cat")
        forged = {"id": str(uuid.uuid4()), "title": "Offensive loop", "author": "Ada", "licence": "CC-BY-4.0"}
        impersonation = published(cat, layout(ancestors=[forged]), title="Not by Ada")
        assert impersonation["ancestors"] == [] and impersonation["remixOf"] is None

        original = published(ada, layout(), title="Harbour loop")
        remix = published(bob, layout(ancestors=[credit(original)]), title="Harbour loop with yard")
        assert ada.delete(f"/api/gallery/{original['id']}", headers=session_headers(ada, ORIGIN)).status_code == 200
        claimed = [{**credit(original), "title": "Renamed by the remixer", "author": "Cat"}]
        assert published(cat, layout(ancestors=claimed), title="Third take")["ancestors"] == [credit(original)]

        deleted = bob.request("DELETE", "/api/account", json={"password": PASSWORD}, headers=session_headers(bob, ORIGIN))
        assert deleted.status_code == 200, deleted.text
        later = published(cat, layout(ancestors=[credit(remix), forged]), title="Fourth take")
        assert later["ancestors"] == [credit(remix), credit(original)] and later["remixOf"]["author"] == "Bob"


def test_a_member_publishes_ten_layouts_a_day(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        bob = member(stack, tmp_path, clock, "bob@example.com", "Bob")
        first, *_ = [published(ada, layout(), title=f"Loop {index}") for index in range(10)]
        refused = publish(ada, layout())
        assert refused.status_code == 429 and "10 layouts today" in refused.json()["detail"]
        # Unpublishing does not give a publish back.
        assert ada.delete(f"/api/gallery/{first['id']}", headers=session_headers(ada, ORIGIN)).status_code == 200
        assert publish(ada, layout()).status_code == 429
        assert publish(bob, layout()).status_code == 201
        clock.advance(24 * HOUR)
        assert publish(ada, layout()).status_code == 201


def test_an_admin_has_no_daily_publish_limit(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = member(stack, tmp_path, clock, "alex@example.com", "Alex")
        make_admin(tmp_path, "alex@example.com")
        assert all(publish(alex, layout(), title=f"Loop {index}").status_code == 201 for index in range(12))


def test_a_thumbnail_holds_at_most_4000_points_and_64_kb(tmp_path):
    clock = Clock()
    line = lambda count: [coordinate for index in range(count) for coordinate in (index, -index)]
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        assert publish(ada, layout(), thumbnail={**THUMBNAIL, "tracks": [{"points": line(4001), "owned": True}]}).status_code == 422
        # 4,000 points within the byte cap, then 4,000 points written too long for it.
        assert publish(ada, layout(), thumbnail={**THUMBNAIL, "tracks": [{"points": line(4000), "owned": True}]}).status_code == 201
        wide = [{"points": [-999_999] * 4, "owned": False} for _ in range(2000)]
        assert publish(ada, layout(), thumbnail={**THUMBNAIL, "tracks": wide}).status_code == 422
        assert len(listed(ada)) == 1


def test_the_gallery_lists_each_layouts_piece_count_including_ones_published_before_it_was_stored(tmp_path):
    path = db.database_path(tmp_path)
    earlier = tmp_path / "earlier-migrations"
    earlier.mkdir()
    for migration in sorted(db.MIGRATIONS_DIR.glob("00[1-5]_*.sql")):
        (earlier / migration.name).write_text(migration.read_text())
    assert db.migrate(path, earlier) == 5
    conn = db.connect(path)
    try:
        conn.execute("INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) "
                     "VALUES ('u1', 'old@example.com', 'x', 'Oldtimer', 0, 0)")
        body = layout(routes=[{"id": "r1", "pieces": [{"id": "a"}, {"id": "b"}]}, {"id": "r2", "pieces": [{"id": "c"}]},
                              {"id": "r3"}])
        conn.execute("INSERT INTO gallery_layouts (id, owner_id, title, body, author_name, published_at) "
                     "VALUES (?, 'u1', 'Old loop', ?, 'Oldtimer', 1)", (str(uuid.uuid4()), json.dumps(body)))
    finally:
        conn.close()
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        two = layout(routes=[{"id": "r1", "name": "Main line", "points": [], "pieces": [
            {"id": f"p{index}", "family": "brick_straight_nominal", "x": index * 128, "y": 0, "rotation": 0}
            for index in range(2)]}])
        published(ada, two, title="New loop")
        with visitor(tmp_path, clock) as anyone:
            cards = anyone.get("/api/gallery").json()["layouts"]
        assert [(card["title"], card["pieces"]) for card in cards] == [("New loop", 2), ("Old loop", 3)]


def test_pages_continue_after_the_last_card_even_when_layouts_share_a_second(tmp_path, monkeypatch):
    monkeypatch.setattr(gallery, "PAGE_SIZE", 2)
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, "ada@example.com", "Ada")
        monkeypatch.setattr(clock, "ticks", itertools.repeat(1_800_000_000))
        ids = sorted((published(ada, layout(), title=f"Loop {index}")["id"] for index in range(5)), reverse=True)
        with visitor(tmp_path, clock) as anyone:
            seen, cursor = [], None
            while True:
                page = anyone.get("/api/gallery", params={"before": cursor} if cursor else None).json()
                seen += [card["id"] for card in page["layouts"]]
                if not (cursor := page["next"]):
                    break
        assert seen == ids
