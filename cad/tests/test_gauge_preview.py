"""The narrow-gauge end drawn by the editor is generated from the current CAD sources."""

import json

from cad.generate_gauge_preview import OUTPUT, source_digest
from cad.models import gauge


def test_narrow_end_preview_is_current():
    data = json.loads(OUTPUT.read_text())
    assert data["endLength"] == gauge.NARROW_PROFILE["endTieWidth"]
    assert data["sourceDigest"] == source_digest(), "regenerate with: env PYTHONPATH=. uv run python -m cad.generate_gauge_preview"
