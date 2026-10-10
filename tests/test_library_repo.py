"""The library repository's pull-request gate (`library-repo/check_items.py`): what the bot commits passes it, broken
item folders fail it with why, and its vendored `check.py` stays the same as Plateway's."""
from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import sys

from cad.library import check
from cad.service.library_publish import repo_files
from signed_in import session_headers
from test_submissions import CURVE, CURVE_STL, FORM, LIBRARY, LOCO, ORIGIN, Clock, admin, bot_queue, member, send

REPO = Path(__file__).resolve().parent.parent / "library-repo"


def gate(root, *folders):
    """Run the gate as the library repository's workflow does: from its checkout, on these item folders."""
    return subprocess.run([sys.executable, "check_items.py", "--root", str(root), *folders], cwd=REPO,
                          capture_output=True, text=True, timeout=120)


def write(root, files):
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)


def test_what_the_bot_commits_passes_the_gate(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = admin(stack, tmp_path, clock)
        ada = member(stack, tmp_path, clock)
        car = LOCO["train"]["car"]
        uploads = [
            send(ada),
            send(ada, metadata={"name": "Adapted curve", "ends": CURVE["piece"]["ends"], "source": {
                "url": "https://www.printables.com/model/466240", "authors": ["lev"]}}),
            send(ada, "train", {"name": "Sample locomotive", **{key: LOCO["train"][key] for key in ("year", "power", "gauge")},
                                "car": {key: car[key] for key in ("kind", "motorised", "bogies", "couplers")}},
                 data=(LIBRARY / LOCO["file"]).read_bytes()),
            send(ada, "furniture", {"name": "Shelf table", "design": FORM["design"], "type": FORM["type"]}, data=None),
        ]
        for upload in uploads:
            assert upload.status_code == 201, upload.text
            approved = alex.post(f"/api/admin/submissions/{upload.json()['id']}/approve", headers=session_headers(alex, ORIGIN))
            assert approved.status_code == 200, approved.text
    repo = tmp_path / "repo"
    folders = []
    for submission in bot_queue(tmp_path):
        files = repo_files(submission)
        write(repo, files)
        folders.append(str(Path(next(iter(files))).parent))
    assert sorted(folder.split("/")[0] for folder in folders) == ["furniture", "pieces", "pieces", "trains"]
    result = gate(repo, *folders)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [line.split(": ")[1].split(" ")[0] for line in result.stdout.splitlines()] == ["passed"] * 4


def test_a_broken_item_folder_fails_the_gate_with_why(tmp_path):
    metadata = {"name": "Sample curve", "ends": CURVE["piece"]["ends"]}

    def piece(item_id, version=1, **extra):
        files = repo_files({"kind": "piece", "metadata": {"id": item_id, **metadata}, "file": "piece.stl", "data": CURVE_STL})
        if version != 1:
            files = {name.replace("/1/", f"/{version}/"): data for name, data in files.items()}
        return {**files, **{f"pieces/{item_id}/{version}/{name}": data for name, data in extra.items()}}

    good = piece("community_good")
    bare = {name: data for name, data in piece("community_bare").items() if not name.endswith("metadata.json")}
    twice = piece("community_twice", **{"spare.stl": CURVE_STL})
    named = {name: (json.dumps({"id": "community_other", **metadata}).encode() if name.endswith("metadata.json") else data)
             for name, data in piece("community_named").items()}
    zero = piece("community_zero", version=0)
    for files in (good, bare, twice, named, zero):
        write(tmp_path, files)
    result = gate(tmp_path, "pieces/community_good/1", "pieces/community_bare/1", "pieces/community_twice/1",
                  "pieces/community_named/1", "pieces/community_zero/0")
    assert result.returncode == 1, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert lines[0].startswith("pieces/community_good/1: passed ")
    assert lines[1:] == [
        "pieces/community_bare/1: refused: It has no metadata.json.",
        "pieces/community_twice/1: refused: It must hold metadata.json and one .stl file, not: piece.stl, spare.stl.",
        'pieces/community_named/1: refused: metadata.json must give the folder\'s id, "community_named".',
        'pieces/community_zero/0: refused: "0" is not a version: item folders are <id>/<whole number>/.',
    ]


def test_the_vendored_check_is_plateways_check():
    """`library-repo/check.py` is copied by hand from `cad/library/check.py`; the gate must run the same check."""
    assert (REPO / "check.py").read_bytes() == Path(check.__file__).read_bytes(), (
        "library-repo/check.py differs from cad/library/check.py: copy it over (docs/operations.md)")
