from io import BytesIO
import json
from zipfile import ZipFile
from pathlib import Path
import re
import uuid

from fastapi.testclient import TestClient

from cad.service.app import create_app
from signed_in import publish_package, session_headers, signed_in_client

HOST = "127.0.0.1:8765"
ORIGIN = f"http://{HOST}"


def project():
    return {"version": 5, "id": str(uuid.uuid4()), "revision": str(uuid.uuid4()), "name": "Crossing",
            "parentRevision": None, "provenance": {"account": None}, "routes": [], "measurements": {}, "furniture": [], "trackSystem": "brick-v1",
            "connectorFit": {"adjustmentMm": 0, "settingsKey": None, "calibrationId": None}}


def client(root: Path):
    return signed_in_client(root, ORIGIN, expected_host=HOST)


def test_print_presets_name_each_printer_nozzle_fast_process(tmp_path):
    with client(tmp_path) as app:
        presets = app.get("/api/print-presets").json()
    assert presets["X1 Carbon"]["fastProcess"] == "0.28mm Extra Draft @BBL X1C"
    assert presets["A1 mini"]["fastProcess"] == "0.28mm Extra Draft @BBL A1M"
    assert presets["A1 mini"]["byNozzle"]["0.6"]["fastProcess"] == "0.24mm Optimal @BBL A1M 0.6 nozzle"
    for printer in presets.values():
        for lists in printer["byNozzle"].values():
            assert lists["fastProcess"] in lists["processes"]


def test_browser_origin_and_token_gate_mutations(tmp_path):
    with client(tmp_path) as app:
        body = project()
        headers = session_headers(app, ORIGIN)
        assert app.post("/api/projects", json=body, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
        assert app.post("/api/projects", json=body, headers={"Origin": ORIGIN}).status_code == 403
        assert app.post("/api/projects", json=body, headers={**headers, "Host": "evil.example"}).status_code == 403
        assert app.get("/api/projects").json() == []


def test_loopback_alias_loads_library_and_saves_with_session(tmp_path):
    for configured, alias in [("127.0.0.1", "localhost"), ("localhost", "127.0.0.1")]:
        host, origin = f"{configured}:8765", f"http://{configured}:8765"
        alias_origin = f"http://{alias}:8765"
        with TestClient(create_app(tmp_path / configured, expected_host=host, allowed_origin=origin, local_member=True),
                        base_url=alias_origin) as app:
            session = app.get("/api/session")
            assert session.status_code == 200
            library = app.get("/api/calibrations", headers={"Origin": alias_origin})
            assert library.status_code == 200
            assert library.json() == []
            body = project()
            headers = {"Origin": alias_origin, "X-Workshop-Session": session.json()["token"]}
            saved = app.post("/api/projects", json=body, headers=headers)
            assert saved.status_code == 201
            assert app.get(f"/api/projects/{saved.json()['id']}/{saved.json()['revision']}").json()["name"] == body["name"]
            for invalid_host in ("evil.example", "localhost.evil.example:8765", "localhost:8766"):
                assert app.get("/api/calibrations", headers={"Host": invalid_host}).status_code == 403
            for invalid_origin in ("http://localhost:8766", "https://localhost:8765", "http://localhost.evil.example:8765"):
                assert app.post("/api/projects", json=body, headers={**headers, "Origin": invalid_origin}).status_code == 403
            assert app.post("/api/projects", json=body, headers={"Origin": alias_origin}).status_code == 403


def test_development_origin_alias_keeps_configured_port_boundary(tmp_path):
    with TestClient(create_app(tmp_path, allowed_origin="http://localhost:5173", local_member=True),
                    base_url=ORIGIN) as app:
        assert app.get("/api/session", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200
        assert app.get("/api/calibrations", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200
        assert app.get("/api/calibrations", headers={"Origin": ORIGIN}).status_code == 403


def test_downloads_current_layout_plates_as_one_real_archive(tmp_path):
    package_id = f"{uuid.uuid4()}-{uuid.uuid4()}"
    receipt = {
        "id": package_id, "status": "prepared-digital-only", "manifest": "manifest.json",
        "printer": {"name": "A1 mini"},
        "plates": [
            {"model": "plate1-plain.3mf", "project": "plate1.3mf", "gcode": "plate1.gcode"},
            {"model": "plate2-plain.3mf", "project": "plate2.3mf", "gcode": "plate2.gcode"},
        ], "assemblyGuide": "guide.md", "assemblyGuidePdf": "guide.pdf",
        "parts": [{"printMesh": "plate-01/part-0001-straight.stl"}, {"printMesh": "plate-02/part-0002-curve.stl"}],
    }
    files = {
        "plate1-plain.3mf": b"plain plate one", "plate2-plain.3mf": b"plain plate two",
        "plate1.3mf": b"real plate one", "plate1.gcode": b"G1 X1\n",
        "plate2.3mf": b"real plate two", "plate2.gcode": b"G1 X2\n",
        "guide.md": b"assembly guide", "guide.pdf": b"%PDF guide",
        "plate-01/part-0001-straight.stl": b"straight", "plate-02/part-0002-curve.stl": b"curve",
    }
    # Prepared before plain 3MFs: still downloads its Bambu files.
    older = json.loads(json.dumps({**receipt, "id": f"{package_id}-0123abcd"}))
    older["plates"][1].pop("model")
    with client(tmp_path) as app:
        publish_package(app, tmp_path, receipt, files)
        publish_package(app, tmp_path, older, files)
        response = app.get(f"/api/packages/{package_id}/plates.zip")
        older_response = app.get(f"/api/packages/{older['id']}/plates.zip")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "attachment" in response.headers["content-disposition"]
    with ZipFile(BytesIO(response.content)) as archive:
        # Any slicer's files at the top; the Bambu printer's projects and G-code in their own folder.
        assert archive.namelist() == [
            "plate-01.3mf", "plate-02.3mf", "assembly-guide.md", "assembly-guide.pdf",
            "stl/part-0001-straight.stl", "stl/part-0002-curve.stl",
            "bambu-studio-a1-mini/plate-01-bambu-project.3mf", "bambu-studio-a1-mini/plate-01.gcode",
            "bambu-studio-a1-mini/plate-02-bambu-project.3mf", "bambu-studio-a1-mini/plate-02.gcode",
        ]
        assert archive.read("plate-02.3mf") == b"plain plate two"
        assert archive.read("bambu-studio-a1-mini/plate-02-bambu-project.3mf") == b"real plate two"
        assert archive.read("bambu-studio-a1-mini/plate-01.gcode") == b"G1 X1\n"
        assert archive.read("assembly-guide.md") == b"assembly guide"
        assert archive.read("assembly-guide.pdf") == b"%PDF guide"
        assert archive.read("stl/part-0002-curve.stl") == b"curve"
    with ZipFile(BytesIO(older_response.content)) as archive:
        assert "plate-02.3mf" not in archive.namelist()
        assert "bambu-studio-a1-mini/plate-02-bambu-project.3mf" in archive.namelist()


def test_plate_archive_rejects_trial_and_unsafe_or_missing_artifact(tmp_path):
    trial = {"id": f"trial-{uuid.uuid4().hex}", "status": "prepared-digital-only",
             "plates": [{"project": "plate.3mf", "gcode": "plate.gcode"}]}
    files = {"plate.3mf": b"plate", "plate.gcode": b"G1", "guide.md": b"guide"}
    layout = {"status": "prepared-digital-only", "manifest": "manifest.json", "assemblyGuide": "guide.md",
              "assemblyGuidePdf": "guide.md", "plates": [{"project": "plate.3mf", "gcode": "plate.gcode"}]}
    with client(tmp_path) as app:
        publish_package(app, tmp_path, trial, files, kind="coupon")
        assert app.get(f"/api/packages/{trial['id']}/plates.zip").status_code == 404
        for name, plate in (("unsafe", {"project": "../outside.3mf", "gcode": "plate.gcode"}),
                            ("missing", {"project": "plate.3mf", "gcode": "missing.gcode"})):
            package_id = f"{uuid.uuid4()}-{name}"
            publish_package(app, tmp_path, {**layout, "id": package_id, "plates": [plate]}, files)
            assert app.get(f"/api/packages/{package_id}/plates.zip").status_code == 404, name


def test_downloads_every_print_oriented_stl_without_substituting_assembly_meshes(tmp_path):
    package_id = f"{uuid.uuid4()}-{uuid.uuid4()}"
    receipt = {
        "id": package_id, "status": "prepared-digital-only", "manifest": "manifest.json",
        "parts": [
            {"instanceId": "upper:transition:1", "mesh": "assembly-1.stl",
             "printMesh": "plate-01/part-0001-abcdef0123456789.stl",
             "printOrientation": "side-on-bed"},
            {"instanceId": "lower:deck:1", "mesh": "assembly-2.stl",
             "printMesh": "plate-02/part-0001-bridge-deck-lower-deck-1-fedcba.stl",
             "printOrientation": "as-authored-flat"},
        ],
    }
    files = {
        "assembly-1.stl": b"assembly orientation", "assembly-2.stl": b"assembly mesh",
        receipt["parts"][0]["printMesh"]: b"side-on-bed print mesh",
        receipt["parts"][1]["printMesh"]: b"flat print mesh",
    }
    with client(tmp_path) as app:
        publish_package(app, tmp_path, receipt, files)
        response = app.get(f"/api/packages/{package_id}/stls.zip")
        saved_receipt = app.get(f"/api/packages/{package_id}")
    assert saved_receipt.status_code == 200
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert f'{package_id}-stls.zip' in response.headers["content-disposition"]
    with ZipFile(BytesIO(response.content)) as archive:
        assert archive.namelist() == [
            "part-0001-abcdef0123456789.stl",
            "part-0001-bridge-deck-lower-deck-1-fedcba.stl",
        ]
        assert archive.read(archive.namelist()[0]) == b"side-on-bed print mesh"
        assert archive.read(archive.namelist()[1]) == b"flat print mesh"


def test_print_stl_archive_rejects_trials_missing_meshes_and_unsafe_paths(tmp_path):
    files = {"print.stl": b"print mesh"}
    cases = {
        "trial": {"parts": [{"printMesh": "print.stl"}]},
        "missing": {"manifest": "manifest.json", "parts": [{"printMesh": "other.stl"}]},
        "unsafe": {"manifest": "manifest.json", "parts": [{"printMesh": "../outside.stl"}]},
        "repeated": {"manifest": "manifest.json", "parts": [{"printMesh": "print.stl"}, {"printMesh": "print.stl"}]},
    }
    with client(tmp_path) as app:
        for name, receipt in cases.items():
            package_id = f"{uuid.uuid4()}-{name}"
            publish_package(app, tmp_path, {"id": package_id, "status": "prepared-digital-only", **receipt}, files)
            assert app.get(f"/api/packages/{package_id}/stls.zip").status_code == 404, name


def test_hardware_list_checks_the_session_token_and_adds_pieces_up(tmp_path):
    bracket = {"family": "track_bracket", "label": "Wall bracket", "parameters": {"mount": 1, "reach": 72, "height": 0}}
    body = {"pieces": [{"id": ident, "piece": ident, **bracket} for ident in ("w1", "w2")]}
    with client(tmp_path) as app:
        assert app.post("/api/hardware", json=body, headers={"Origin": ORIGIN}).status_code == 403
        headers = session_headers(app, ORIGIN)
        response = app.post("/api/hardware", json=body, headers=headers)
        assert response.status_code == 200
        assert response.json()["lines"] == [{"category": "fasteners", "name": "Wood screw 4 x 30 mm (pan head)",
                                             "quantity": 4, "pieces": ["Wall bracket ×2"]}]
        assert app.post("/api/hardware", json={"pieces": "all"}, headers=headers).status_code == 422


def built_app(root: Path) -> Path:
    """A stand-in for `npm run build` (Vite `base: '/app/'`): the page and one hashed bundle."""
    ui = root / "dist"
    (ui / "assets").mkdir(parents=True)
    (ui / "index.html").write_text('<!doctype html><script type="module" src="/app/assets/index-abc.js"></script>')
    (ui / "assets" / "index-abc.js").write_text("export {};")
    return ui


def test_landing_site_at_root_and_app_under_app_both_revalidate(tmp_path):
    ui = built_app(tmp_path)
    with TestClient(create_app(tmp_path / "root", ui_root=ui), base_url=ORIGIN) as http:
        landing, page = http.get("/"), http.get("/app/")
        assert landing.status_code == 200 and landing.headers["cache-control"] == "no-cache"
        assert 'data-app-url="/app/"' in landing.text
        assert page.status_code == 200 and page.headers["cache-control"] == "no-cache"
        assert page.text == (ui / "index.html").read_text()
        bundle = http.get("/app/assets/index-abc.js")
        assert bundle.text == "export {};"
        # A hashed bundle never changes; everything else is unhashed, so a CDN or browser must revalidate it
        # (Cloudflare otherwise keeps a stylesheet for 4 hours and a new page renders with the old one).
        assert bundle.headers["cache-control"] == "public, max-age=31536000, immutable"
        # Browsers ask for `/favicon.ico` at the root whatever the page links; the app's page links the root icons too.
        for path in ("/styles.css", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest",
                     "/img/icon-192.png", "/js/landing.js", "/legal/privacy.html"):
            response = http.get(path)
            assert response.status_code == 200 and response.headers["cache-control"] == "no-cache", path
        # The site's build tools are never served.
        assert http.get("/tools/package.json").status_code == 404
        moved = http.get("/app", follow_redirects=False)
        assert moved.status_code in (307, 308) and moved.headers["location"].endswith("/app/")


def test_the_landing_page_has_no_inline_script(tmp_path):
    with TestClient(create_app(tmp_path), base_url=ORIGIN) as http:
        landing = http.get("/").text
    scripts = re.findall(r"<script\b([^>]*)>(.*?)</script>", landing, re.S)
    assert scripts and all("src=" in attributes and not body.strip() for attributes, body in scripts)
    assert not re.search(r"\son[a-z]+\s*=", landing)


def test_every_response_carries_a_csp_without_inline_script(tmp_path):
    origin, packages, library = ("https://plateway.example", "https://account.r2.cloudflarestorage.com",
                                 "https://library.plateway.example")
    app = create_app(tmp_path / "root", expected_host="plateway.example", allowed_origin=origin,
                     download_origins=[packages, library], ui_root=built_app(tmp_path))
    with TestClient(app, base_url=origin) as http:
        responses = [http.get("/"), http.get("/app/"), http.get("/js/landing.js"), http.get("/api/auth/me"),
                     http.post("/api/projects", json={}, headers={"Origin": "https://evil.example"})]
    for response in responses:
        header = response.headers["content-security-policy"]
        policy = dict(directive.split(" ", 1) for directive in header.split("; "))
        # Same-origin script files plus Cloudflare's analytics beacon: no inline script and no JavaScript eval
        # (WebAssembly may compile).
        assert policy["default-src"] == "'self'"
        assert policy["script-src"] == "'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com"
        assert not {"'unsafe-inline'", "'unsafe-eval'"} & set(header.replace(";", " ").split())
        assert set(policy["connect-src"].split()) == {"'self'", "https://api.anthropic.com", "https://cloudflareinsights.com",
                                                      packages, library}
        assert {packages, library} <= set(policy["img-src"].split())
        assert policy["frame-ancestors"] == "'none'" and policy["object-src"] == "'none'"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["strict-transport-security"].startswith("max-age=")


def test_rate_limits_key_on_cf_connecting_ip_never_x_forwarded_for(tmp_path):
    with TestClient(create_app(tmp_path), base_url=ORIGIN) as http:
        def sign_up(number: int, ip: str, forwarded: str) -> int:
            return http.post("/api/auth/signup", headers={"Origin": ORIGIN, "CF-Connecting-IP": ip,
                                                          "X-Forwarded-For": forwarded},
                             json={"email": f"m{number}@example.com", "password": "correct horse battery",
                                   "displayName": f"Member {number}"}).status_code

        # Five sign-ups per client IP: a new X-Forwarded-For each time does not make a new client.
        assert [sign_up(n, "203.0.113.7", f"198.51.100.{n}") for n in range(6)] == [202] * 5 + [429]
        assert sign_up(6, "203.0.113.8", "203.0.113.7") == 202


def test_hosted_service_takes_host_and_origin_from_its_public_origin_and_has_no_local_member(tmp_path, monkeypatch):
    import uvicorn
    from cad.service import app as service

    served = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **options: served.update(app=app, **options))
    service.main({"TRAIN_PROJECT_DIR": str(tmp_path), "PLATEWAY_PUBLIC_ORIGIN": "https://plateway.example",
                  "PLATEWAY_BIND_HOST": "0.0.0.0", "PLATEWAY_S3_ENDPOINT": "https://account.r2.example/",
                  "PLATEWAY_LIBRARY_URL": "https://library.plateway.example/index.json"})
    assert (served["host"], served["port"], served["proxy_headers"]) == ("0.0.0.0", 8765, False)
    with TestClient(served["app"], base_url="https://plateway.example") as http:
        assert http.get("/api/session").status_code == 404
        assert http.get("/api/auth/me").status_code == 401
        assert http.get("/api/auth/me", headers={"Host": "127.0.0.1:8765"}).status_code == 403
        assert http.post("/api/auth/login", json={}, headers={"Origin": ORIGIN}).status_code == 403
        connect = http.get("/").headers["content-security-policy"].split("connect-src ")[1].split(";")[0].split()
    assert {"https://account.r2.example", "https://library.plateway.example"} <= set(connect)
