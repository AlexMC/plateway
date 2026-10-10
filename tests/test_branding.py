"""The public product is Plateway, its bundled track geometry is credited, and the legal pages exist (U6: R21-R23)."""

from html.parser import HTMLParser
from io import BytesIO
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile

from pypdf import PdfReader
import trimesh

from cad.service import guide_pdf
from cad.service.plates import write_core_3mf

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
CORE = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'


class Links(HTMLParser):
    """Every link's href and text, and the hrefs inside the page's <footer>."""

    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self.footer: list[str] = []
        self._href: str | None = None
        self._text = ''
        self._in_footer = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'footer':
            self._in_footer += 1
        if tag == 'a':
            self._href, self._text = dict(attrs).get('href') or '', ''
            if self._in_footer:
                self.footer.append(self._href)

    def handle_endtag(self, tag):
        if tag == 'footer':
            self._in_footer -= 1
        if tag == 'a' and self._href is not None:
            self.links.append((self._href, ' '.join(self._text.split())))
            self._href = None

    def handle_data(self, data):
        if self._href is not None:
            self._text += data


def links(path: Path) -> Links:
    parser = Links()
    parser.feed(path.read_text())
    return parser


def text(path: Path) -> str:
    """A page's visible words, one space apart (tags, comments and markup removed)."""
    class Words(HTMLParser):
        words: list[str] = []
        skip = 0

        def handle_starttag(self, tag, attrs):
            self.skip += tag in ('style', 'script')

        def handle_endtag(self, tag):
            self.skip -= tag in ('style', 'script')

        def handle_data(self, data):
            if not self.skip:
                self.words.extend(data.split())
    parser = Words()
    parser.words = []
    parser.feed(path.read_text())
    return ' '.join(parser.words)


def test_assembly_guide_pdf_metadata_and_credits_name_plateway_and_the_track_source():
    guide = guide_pdf.Guide('Harbour loop')
    guide_pdf.closing(guide, [], [])
    reader = PdfReader(BytesIO(guide.finish(guide_pdf.Page(guide, None))))
    assert (reader.metadata.creator, reader.metadata.author) == ('Plateway', 'Plateway')
    credits = ' '.join(' '.join(page.extract_text().split()) for page in reader.pages)
    assert 'Prepared with Plateway' in credits
    assert 'lev' in credits and 'Printables #466240' in credits and 'CC BY 4.0' in credits
    assert 'not been established' not in credits and 'do not redistribute' not in credits


def test_plain_3mf_application_metadata_is_plateway(tmp_path):
    trimesh.creation.box((40, 20, 6)).export(tmp_path / 'part-0001-straight.stl')
    target = tmp_path / 'plate-01.3mf'
    write_core_3mf(target, tmp_path, [{'instanceId': 'main:0:straight', 'code': '1', 'plateLabel': 'part-0001-straight.stl',
                                       'printOrientation': 'as-authored-flat', 'bounds': {'min': [-20, -10, -3]},
                                       'plannedPlacement': {'x': 7, 'y': 7}}], 1)
    with zipfile.ZipFile(target) as archive:
        model = ET.fromstring(archive.read('3D/3dmodel.model'))
    metadata = {node.get('name'): node.text for node in model.findall(f'{CORE}metadata')}
    assert metadata['Application'] == 'Plateway'


def test_track_profile_names_its_cc_by_source_and_licence():
    provenance = json.loads((ROOT / 'cad/profiles/brick-v1.json').read_text())['provenance']
    assert provenance['license'] == 'CC-BY-4.0'
    assert 'Printables #466240' in provenance['source'] and 'by lev' in provenance['source']
    assert 'unknown' not in provenance['rights'].lower()


def test_no_tracked_file_depends_on_the_non_commercial_curve_reference():
    # kurve.stl (Printables #843349, CC BY-NC-SA) may not shape, ship with or be cited by anything bundled.
    # The plan that ordered its removal is the one file allowed to name it.
    tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout.decode().split('\0')
    offenders = [name for name in tracked if name and not name.startswith('docs/plans/') and name != 'tests/test_branding.py'
                 and (ROOT / name).is_file() and b'kurve' in (ROOT / name).read_bytes().lower()]
    assert offenders == []


def test_landing_footer_links_to_existing_privacy_and_terms_pages():
    footer = links(SITE / 'index.html').footer
    for page in ('legal/privacy.html', 'legal/terms.html'):
        assert page in footer
        assert (SITE / page).is_file()
    for page in ('privacy.html', 'terms.html'):
        # Each legal page leads back to the landing page and to the other page, and its stylesheet exists.
        hrefs = [href for href, _ in links(SITE / 'legal' / page).links]
        assert '../' in hrefs and {'privacy.html', 'terms.html'} - {page} <= set(hrefs)
        assert '../styles.css' in (SITE / 'legal' / page).read_text()


def test_terms_name_the_takedown_contact_and_the_licence_grants():
    words = text(SITE / 'legal/terms.html')
    contacts = [href for href, _ in links(SITE / 'legal/terms.html').links if href.startswith('mailto:')]
    assert contacts and 'takedown' in words.lower()
    assert 'CC BY 4.0' in words and 'have the right' in words


def test_privacy_policy_covers_the_r23_disclosures():
    words = text(SITE / 'legal/privacy.html')
    for required in ('Hetzner', 'Cloudflare', 'GitHub', 'Anthropic', 'CNPD', 'Alex Carvalho',
                     'legitimate interest', 'Export my data', 'Delete account', 'permanently'):
        assert required in words, required
    # An approved contribution stays public whether its pull request is merged or closed, and after deletion.
    assert 'merged or closed' in words and 'even after you delete your account' in words
