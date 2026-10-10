"""The library bot (U16, R18, R19, KTD9, KTD10, AE5) against a recorded fake of the GitHub API (`fake_github.py`):
approved uploads become one branch and one pull request, the 5-minute ETag poll publishes merges and records closes,
withdrawals, takedowns, reverts and rate limits."""
from contextlib import ExitStack
import hashlib
import json
import logging
import threading

import pytest

from cad.service import db
from cad.service.github_app import (POLL_SECONDS, WITHDRAWN_COMMENT, GitHubApp, GitHubError, LibraryBot,
                                    load_private_key)
from cad.service.library_publish import Library
from cad.service.mailer import FileSink
from cad.service.storage import open_storage
from cad.service.submissions import Submissions
from fake_github import TOKEN_LENGTH, FakeGitHub
from signed_in import PASSWORD, session_headers
from test_submissions import CURVE, CURVE_STL, ORIGIN, Clock, admin, member, send

ITEM = "community_sample_curve"
FOLDER = f"pieces/{ITEM}/1/"


class Sleeps(list):
    """Sleeping moves the test clock on instead of waiting."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def __call__(self, seconds):
        self.append(seconds)
        self.clock.advance(seconds)


def make_bot(root, fake, clock, sleeps=None):
    database = db.database_path(root)
    github = GitHubApp(fake.app_id, load_private_key(fake.private_pem), f"{fake.owner}/{fake.repo}", transport=fake,
                       clock=clock, sleep=sleeps if sleeps is not None else Sleeps(clock))
    library = Library(database, open_storage({}, db.storage_root(root)).library, clock)
    return LibraryBot(database, github, library, Submissions(database, FileSink(root / "mail"), ORIGIN), clock=clock)


class Scene:
    """Alex, Ada with an approved sample curve, the fake GitHub and the bot, before the bot's first cycle."""

    def __init__(self, stack, root, metadata=None):
        self.root, self.clock = root, Clock()
        self.alex = admin(stack, root, self.clock)
        self.ada = member(stack, root, self.clock)
        self.upload = send(self.ada, metadata=metadata).json()
        self.fake = FakeGitHub(clock=self.clock)
        self.sleeps = Sleeps(self.clock)
        self.bot = make_bot(root, self.fake, self.clock, self.sleeps)
        approved = self.alex.post(f"/api/admin/submissions/{self.upload['id']}/approve",
                                  headers=session_headers(self.alex, ORIGIN))
        assert approved.status_code == 200, approved.text

    def mine(self):
        [submission] = self.ada.get("/api/submissions").json()["submissions"]
        return submission

    def index(self):
        response = self.ada.get("/api/library/index.json")
        return {item["id"]: item for item in response.json()["items"]} if response.status_code == 200 else None

    def poll(self):
        """The next cycle after five minutes."""
        self.clock.advance(POLL_SECONDS)
        return self.bot.cycle()

    def admin_post(self, path, body=None):
        return self.alex.post(path, json=body, headers=session_headers(self.alex, ORIGIN))


@pytest.fixture
def scene(tmp_path):
    with ExitStack() as stack:
        yield Scene(stack, tmp_path)


def test_approving_creates_one_branch_and_one_pull_request_with_the_item_files(scene):
    assert scene.bot.cycle()["opened"] == [1]
    branch = f"heads/submissions/{scene.upload['id']}"
    assert sorted(scene.fake.refs) == ["heads/main", branch]
    [pull] = scene.fake.pulls.values()
    assert (pull["head"]["ref"], pull["base"]["ref"], pull["state"]) == (branch.removeprefix("heads/"), "main", "open")
    added = {path: data for path, data in scene.fake.files(branch.removeprefix("heads/")).items()
             if path not in scene.fake.files("main")}
    assert sorted(added) == [FOLDER + "metadata.json", FOLDER + "piece.stl"]
    assert added[FOLDER + "piece.stl"] == CURVE_STL
    assert json.loads(added[FOLDER + "metadata.json"]) == {"id": ITEM, "name": "Sample curve", "ends": CURVE["piece"]["ends"]}
    assert scene.mine()["state"] == "pr_open"
    # Later cycles don't open it again.
    scene.bot.cycle()
    scene.poll()
    assert (len(scene.fake.pulls), sorted(scene.fake.refs)) == (1, ["heads/main", branch])


def test_the_pull_request_and_commit_name_the_contributor_by_display_name_only(scene):
    scene.bot.cycle()
    [pull] = scene.fake.pulls.values()
    commit = scene.fake.commits[pull["head"]["sha"]]
    for text in (pull["title"], pull["body"], commit["message"]):
        assert "Ada" in text
        assert "@" not in text and "ada@example.com" not in text
    # The App's own identity commits; the contributor's email is never sent as an author.
    assert commit["author"]["type"] == "Bot"


def test_a_merged_pull_request_publishes_the_item_with_its_credit_and_digest(scene):
    """AE5: a merged upload appears in the library, credited."""
    scene.bot.cycle()
    scene.fake.merge(1)
    assert scene.index() is None
    result = scene.poll()["poll"]
    assert (result["merged"], result["published"]) == ([1], [ITEM])
    entry = scene.index()[ITEM]
    assert entry == {"id": ITEM, "version": 1, "kind": "piece", "state": "live", "name": "Sample curve",
                     "licence": "CC-BY-4.0", "credit": "Ada", "file": FOLDER + "piece.stl",
                     "digest": hashlib.sha256(CURVE_STL).hexdigest(), "piece": {"ends": CURVE["piece"]["ends"]}}
    assert scene.ada.get(f"/api/library/{entry['file']}").content == CURVE_STL
    assert scene.mine()["state"] == "live"


def test_a_piece_adapted_from_a_cc_by_model_is_published_crediting_its_contributor_and_its_source(tmp_path):
    lev = {"url": "https://www.printables.com/model/466240", "authors": ["lev"]}
    with ExitStack() as stack:
        scene = Scene(stack, tmp_path, {"name": "Sample curve", "ends": CURVE["piece"]["ends"], "source": lev})
        scene.bot.cycle()
        scene.fake.merge(1)
        assert scene.poll()["poll"]["published"] == [ITEM]
        entry = scene.index()[ITEM]
        assert (entry["licence"], entry["credit"], entry["piece"]) == (
            "CC-BY-4.0", "Ada, adapted from lev", {"ends": CURVE["piece"]["ends"], "source": lev})


def test_merges_and_closes_show_within_one_poll_and_unchanged_pull_requests_cost_no_rate_limit(scene):
    scene.bot.cycle()  # opens the pull request and polls it
    scene.clock.advance(POLL_SECONDS // 2)
    asked = len(scene.fake.requests)
    assert "poll" not in scene.bot.cycle()
    assert len(scene.fake.requests) == asked
    used = scene.fake.rate_used
    unchanged = scene.poll()["poll"]
    assert (unchanged["checked"], unchanged["unchanged"]) == (1, 1)
    assert scene.fake.rate_used == used  # both 304s: the pull request and the default branch's tree
    scene.fake.merge(1)
    assert scene.poll()["poll"]["merged"] == [1]
    assert scene.mine()["state"] == "live"


def test_a_pull_request_closed_without_merging_shows_as_rejected_with_the_closing_comment(scene):
    """AE5: an approved upload whose pull request is closed shows as rejected, and nothing reaches the library."""
    scene.bot.cycle()
    scene.fake.close(1, "This duplicates the R56 curve already in the library.")
    assert scene.poll()["poll"]["closed"] == [1]
    mine = scene.mine()
    assert (mine["state"], mine["reason"]) == ("closed", "This duplicates the R56 curve already in the library.")
    assert scene.index() is None
    assert scene.alex.get(f"/api/admin/submissions/{scene.upload['id']}").json()["file"] is None


def test_a_close_that_fails_part_way_is_handled_on_the_next_poll(scene):
    scene.bot.cycle()
    scene.fake.close(1, "Not a curve we need.")
    scene.fake.fail_next("GET", "/issues/1/comments", 500, {}, "Server Error")
    with pytest.raises(GitHubError):
        scene.poll()
    assert scene.mine()["state"] == "pr_open"
    assert scene.poll()["poll"]["closed"] == [1]
    mine = scene.mine()
    assert (mine["state"], mine["reason"]) == ("closed", "Not a curve we need.")


def test_alex_rejecting_an_open_pull_request_in_plateway_closes_it_with_his_reason(scene):
    scene.bot.cycle()
    rejected = scene.admin_post(f"/api/admin/submissions/{scene.upload['id']}/reject", {"reason": "The ends are swapped."})
    assert rejected.status_code == 200, rejected.text
    assert scene.bot.cycle()["closed"] == [1]
    assert scene.fake.pulls[1]["state"] == "closed"
    assert scene.fake.comments[1][-1]["body"] == "Rejected in Plateway: The ends are swapped."
    mine = scene.mine()
    assert (mine["state"], mine["reason"]) == ("closed", "The ends are swapped.")


def test_rejecting_in_plateway_after_the_merge_on_github_keeps_the_upload_merged(scene):
    scene.bot.cycle()
    rejected = scene.admin_post(f"/api/admin/submissions/{scene.upload['id']}/reject", {"reason": "Rights unclear."})
    assert rejected.status_code == 200, rejected.text
    scene.fake.merge(1)  # Alex merged it on GitHub before the bot closed it
    assert scene.bot.cycle()["closed"] == [1]
    assert scene.fake.pulls[1]["merged"] is True
    mine = scene.mine()
    assert (mine["state"], mine["reason"]) == ("merged", None)
    assert scene.alex.get(f"/api/admin/submissions/{scene.upload['id']}").json()["file"] is not None
    conn = db.connect(db.database_path(scene.root))
    [(detail,)] = conn.execute("SELECT detail FROM audit_events WHERE kind = 'submission_rejected_after_merge'")
    assert json.loads(detail) == {"submission": scene.upload["id"], "pullRequest": 1}
    # Its files are in the library repository, so it is published like any merge; Alex removes it from there.
    assert scene.poll()["poll"]["published"] == [ITEM]
    assert scene.mine()["state"] == "live"


def test_deleting_the_account_withdraws_the_upload_and_the_bot_closes_its_pull_request(scene):
    scene.bot.cycle()
    deleted = scene.ada.request("DELETE", "/api/account", json={"password": PASSWORD},
                                headers=session_headers(scene.ada, ORIGIN))
    assert deleted.status_code == 200, deleted.text
    assert scene.bot.cycle()["withdrawn"] == [1]
    assert scene.fake.pulls[1]["state"] == "closed"
    assert scene.fake.comments[1][-1]["body"] == WITHDRAWN_COMMENT
    assert scene.bot.cycle()["withdrawn"] == []
    conn = db.connect(db.database_path(scene.root))
    assert conn.execute("SELECT state FROM submissions").fetchone()[0] == "withdrawn"
    assert conn.execute("SELECT count(*) FROM submission_files").fetchone()[0] == 0


def test_deleting_the_account_after_the_merge_keeps_the_merged_item(scene):
    scene.bot.cycle()
    scene.fake.merge(1)
    deleted = scene.ada.request("DELETE", "/api/account", json={"password": PASSWORD},
                                headers=session_headers(scene.ada, ORIGIN))
    assert deleted.status_code == 200, deleted.text
    assert scene.bot.cycle()["withdrawn"] == [1]
    conn = db.connect(db.database_path(scene.root))
    assert conn.execute("SELECT state FROM submissions").fetchone()[0] == "merged"
    assert conn.execute("SELECT count(*) FROM submission_files").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM audit_events WHERE kind = 'submission_withdrawn_after_merge'").fetchone()[0] == 1
    assert scene.bot.cycle()["withdrawn"] == []
    assert scene.poll()["poll"]["published"] == [ITEM]
    assert scene.index()[ITEM]["credit"] == "Ada"


def test_the_poll_ignores_the_pull_request_of_a_withdrawn_upload(scene):
    scene.bot.cycle()
    conn = db.connect(db.database_path(scene.root))
    conn.execute("UPDATE submissions SET state = 'withdrawn', pr_closed_at = 1")
    scene.fake.merge(1)
    poll = scene.poll()["poll"]
    assert (poll["checked"], poll["merged"], poll["published"]) == (0, [], [])
    assert conn.execute("SELECT state FROM submissions").fetchone()[0] == "withdrawn"
    assert scene.index() is None


def test_removing_a_live_item_deletes_its_files_and_keeps_a_tombstone(scene):
    scene.bot.cycle()
    scene.fake.merge(1)
    scene.poll()
    assert any(path.startswith(FOLDER) for path in scene.fake.files("main"))
    for client in (scene.ada,):
        assert client.post(f"/api/admin/library/{ITEM}/remove", headers=session_headers(client, ORIGIN)).status_code == 404
    removed = scene.admin_post(f"/api/admin/library/{ITEM}/remove")
    assert removed.json() == {"id": ITEM, "version": 1, "kind": "piece", "state": "removed"}
    assert scene.index()[ITEM] == {"id": ITEM, "version": 1, "kind": "piece", "state": "removed"}
    assert scene.ada.get(f"/api/library/{FOLDER}piece.stl").status_code == 404
    assert scene.bot.cycle()["removed"] == [ITEM]
    assert not any(path.startswith(f"pieces/{ITEM}/") for path in scene.fake.files("main"))
    assert scene.bot.cycle()["removed"] == []
    assert scene.mine()["state"] == "removed"
    # The revert check that follows sees the files gone, but a removed item stays removed.
    scene.poll()
    assert scene.index()[ITEM]["state"] == "removed"


def test_a_merged_then_reverted_item_is_retired_not_removed(scene):
    scene.bot.cycle()
    scene.fake.merge(1)
    scene.poll()
    scene.fake.revert(f"pieces/{ITEM}/")
    assert scene.poll()["poll"]["retired"] == [ITEM]
    assert scene.index()[ITEM]["state"] == "retired"
    assert scene.ada.get(f"/api/library/{FOLDER}piece.stl").content == CURVE_STL
    assert scene.mine()["state"] == "retired"


def test_a_revert_check_that_fails_is_retried_on_the_next_poll(scene, monkeypatch):
    scene.bot.cycle()
    scene.fake.merge(1)
    scene.poll()
    scene.fake.revert(f"pieces/{ITEM}/")
    retire_missing = scene.bot.library.retire_missing

    def failing(paths):
        raise OSError("The bucket is unreachable")

    monkeypatch.setattr(scene.bot.library, "retire_missing", failing)
    with pytest.raises(OSError):
        scene.poll()
    monkeypatch.setattr(scene.bot.library, "retire_missing", retire_missing)
    assert scene.poll()["poll"]["retired"] == [ITEM]


def test_alex_retires_a_live_item(scene):
    scene.bot.cycle()
    scene.fake.merge(1)
    scene.poll()
    assert scene.admin_post(f"/api/admin/library/{ITEM}/retire").json()["state"] == "retired"
    assert scene.index()[ITEM]["state"] == "retired"
    assert scene.admin_post(f"/api/admin/library/{ITEM}/retire").status_code == 409
    assert scene.ada.get(f"/api/library/{FOLDER}piece.stl").content == CURVE_STL


def test_merged_files_that_differ_from_the_approved_upload_are_not_published(scene):
    scene.bot.cycle()
    head = scene.fake.pulls[1]["head"]["sha"]
    # Someone pushes other bytes to the pull request's branch before merging.
    commit = scene.fake.commits[head]
    files = dict(scene.fake.trees[commit["tree"]])
    files[FOLDER + "piece.stl"] = scene.fake._blob(b"not the approved file")
    swapped = scene.fake._commit(scene.fake._tree(files), commit["parents"], "Edit", {"type": "User"})
    scene.fake.refs[f"heads/{scene.fake.pulls[1]['head']['ref']}"] = scene.fake.pulls[1]["head"]["sha"] = swapped
    scene.fake.merge(1)
    assert scene.poll()["poll"]["published"] == []
    assert scene.index() is None
    assert scene.mine()["state"] == "merged"


def test_a_secondary_rate_limit_403_is_retried_after_its_retry_after(scene):
    scene.fake.fail_next("POST", "/pulls", 403, {"retry-after": "7"},
                         "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.")
    assert scene.bot.cycle()["opened"] == [1]
    assert 7 in scene.sleeps
    assert len(scene.fake.pulls) == 1


def test_a_403_that_is_not_a_rate_limit_fails_without_retrying(scene):
    scene.fake.fail_next("POST", "/pulls", 403, {}, "Resource not accessible by integration")
    with pytest.raises(GitHubError) as failure:
        scene.bot.cycle()
    assert failure.value.status == 403
    assert scene.mine()["state"] == "approved"
    assert scene.bot.cycle()["opened"] == [1]  # the next cycle reuses the branch
    assert len(scene.fake.pulls) == 1


def test_tokens_are_opaque_reused_until_near_expiry_and_never_logged(scene, caplog):
    caplog.set_level(logging.DEBUG)
    scene.bot.cycle()
    scene.fake.fail_next("GET", "/pulls/1", 500, {}, "Server Error")
    with pytest.raises(GitHubError):
        scene.poll()
    [token] = scene.fake.issued
    assert len(token) == TOKEN_LENGTH
    scene.clock.advance(3600)
    scene.poll()
    assert len(scene.fake.issued) == 2
    logged = caplog.text
    secrets = scene.fake.issued + [scene.fake.private_pem.splitlines()[1]]
    assert all(secret not in logged for secret in secrets)
    assert "Bearer" not in logged and "eyJ" not in logged


def test_requests_run_one_at_a_time(scene):
    github = scene.bot.github
    scene.fake.delay = 0.02
    threads = [threading.Thread(target=github.call, args=("GET", github.repo_path)) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert scene.fake.most_in_flight == 1
