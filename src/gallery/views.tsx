import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Member } from '../account/account';
import type { WorkshopProject } from '../domain/project';
import { DrivePanel } from '../drive/panel';
import { setPieceState } from '../editor/operations';
import { fitProject } from '../fitting/fit';
import { ApiError } from '../net/api';
import {
  DESCRIPTION_MAX, LICENCE_URL, REASON_MAX, TITLE_MAX, hideLayout, layoutHash, layoutLink, listGallery, loadLayout, publishLayout,
  reportLayout, unhideLayout, unpublishLayout, type GalleryLayout, type GalleryPage, type GallerySummary, type GalleryThumbnail
} from './gallery';
import './gallery.css';

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const published = (at: string) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** Esc closes the dialog it is pressed in, and nothing under it. */
const escapeCloses = (close: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') { event.stopPropagation(); close(); }
};

/** The structured top view (no uploaded image): shelves, then printed and owned centrelines. */
export function GalleryThumb({ thumbnail, className }: { thumbnail: GalleryThumbnail | null; className: string }) {
  if (!thumbnail) return <svg className={className} viewBox="0 0 1 1" aria-hidden="true" />;
  return <svg className={className} viewBox={thumbnail.box.join(' ')} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    {thumbnail.shelves.map(([x, y, width, height], index) => <rect key={index} className="gallery-thumb-shelf" x={x} y={y} width={width} height={height} />)}
    {thumbnail.tracks.map((track, index) => <polyline key={index} className={track.owned ? 'gallery-thumb-owned' : 'gallery-thumb-printed'}
      points={track.points.join(' ')} />)}
  </svg>;
}

function Dialog({ label, onClose, onSubmit, wide = false, children }: {
  label: string; onClose: () => void; onSubmit?: (event: FormEvent) => void; wide?: boolean; children: ReactNode;
}) {
  const className = `saved-dialog gallery-dialog${wide ? ' gallery-browser' : ''}`;
  const body = <><div className="dialog-heading"><h2>{label}</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></div>{children}</>;
  return <div className="dialog-backdrop" onClick={onClose}>
    {onSubmit ? <form className={className} role="dialog" aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()}
      onKeyDown={escapeCloses(onClose)} onSubmit={event => { event.preventDefault(); onSubmit(event); }}>{body}</form> :
      <div className={className} role="dialog" aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()}
        onKeyDown={escapeCloses(onClose)}>{body}</div>}
  </div>;
}

function Card({ item }: { item: GallerySummary }) {
  return <li><a className={`gallery-card${item.hidden ? ' is-hidden' : ''}`} href={layoutHash(item.id)}>
    <GalleryThumb thumbnail={item.thumbnail} className="gallery-card-thumb" />
    <span className="gallery-card-text">
      <strong>{item.title}</strong>
      <span className="gallery-card-meta">by {item.author} · {published(item.publishedAt)} · {item.pieces} {item.pieces === 1 ? 'piece' : 'pieces'}</span>
      {item.remixOf && <span className="gallery-card-remix">Remix of “{item.remixOf.title}” by {item.remixOf.author}</span>}
      {item.description && <span className="gallery-card-description">{item.description}</span>}
      {(item.mine || item.hidden || !!item.openReports) && <span className="gallery-card-badges">
        {item.mine && <em>Yours</em>}
        {item.hidden && <em className="is-warn">Hidden</em>}
        {item.openReports ? <em className="is-warn">{item.openReports} {item.openReports === 1 ? 'report' : 'reports'}</em> : null}
      </span>}
    </span>
  </a></li>;
}

/** Shared layouts, newest first; a card opens the layout's read-only page. Contribute leads to the library uploads. */
export function GalleryBrowser({ onPublish, onContribute, onClose }: { onPublish: () => void; onContribute: () => void; onClose: () => void }) {
  const [page, setPage] = useState<GalleryPage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    listGallery().then(first => { if (active) setPage(first); }, failure => { if (active) setError(message(failure, 'Could not load the gallery.')); });
    return () => { active = false; };
  }, []);
  async function more() {
    if (!page?.next) return;
    setBusy(true);
    try {
      const next = await listGallery(page.next);
      setPage(current => current && { layouts: [...current.layouts, ...next.layouts], next: next.next });
    } catch (failure) { setError(message(failure, 'Could not load more layouts.')); }
    finally { setBusy(false); }
  }
  return <Dialog label="Community layouts" onClose={onClose} wide>
    <div className="gallery-intro">
      <p>Layouts members shared under CC BY 4.0. Open one to look around and test drive it; Remix copies it into your editor.</p>
      <div className="gallery-intro-actions">
        <button type="button" className="quiet-button" onClick={onContribute}>Contribute pieces, trains or furniture</button>
        <button type="button" className="quiet-button" onClick={onPublish}>Publish your layout</button>
      </div>
    </div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!page && !error && <p className="gallery-loading" role="status">Loading layouts…</p>}
    {page && (page.layouts.length ? <ul className="gallery-cards">{page.layouts.map(item => <Card key={item.id} item={item} />)}</ul> :
      <div className="gallery-empty">
        <h3>No shared layouts yet</h3>
        <p>Layouts members publish show here, newest first. Publish yours and it goes live at once, credited to you.</p>
        <button type="button" className="primary-button" onClick={onPublish}>Publish your layout</button>
      </div>)}
    {page?.next && <div className="gallery-more"><button type="button" className="quiet-button" disabled={busy} onClick={() => void more()}>Show more</button></div>}
  </Dialog>;
}

/** Title, description, and what is and isn't shared (R26), then publish under CC BY 4.0 (R14). */
export function PublishDialog({ project, member, onClose, onPublished }: {
  project: WorkshopProject; member: Member; onClose: () => void; onPublished: (layout: GalleryLayout) => void;
}) {
  const [title, setTitle] = useState(project.name.slice(0, TITLE_MAX));
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [parent] = project.ancestors ?? [];
  async function submit() {
    setBusy(true); setError('');
    try { onPublished(await publishLayout(project, title.trim(), description.trim())); }
    catch (failure) { setError(message(failure, 'Could not publish the layout.')); setBusy(false); }
  }
  return <Dialog label="Publish to the gallery" onClose={onClose} onSubmit={() => void submit()}>
    <div className="account-fields">
      <label className="save-name">Title<input autoFocus value={title} maxLength={TITLE_MAX} onChange={event => setTitle(event.target.value)} /></label>
      <label className="save-name">Description<textarea className="gallery-textarea" rows={3} value={description} maxLength={DESCRIPTION_MAX}
        placeholder="What makes it fun to run, what it needs" onChange={event => setDescription(event.target.value)} /></label>
    </div>
    <p className="save-hint">Goes live at once under <a href={LICENCE_URL} target="_blank" rel="noopener">CC BY 4.0</a>, credited to {member.displayName}
      {parent && <> as a remix of “{parent.title}” by {parent.author}</>}. Anyone can open, test drive and remix it.</p>
    <p className="save-hint gallery-shared">Shared: the track, shelves, room size and train. Not shared: the track you own, test-drive notes,
      fit calibration, printer, material and print settings.</p>
    {error && <p className="account-error" role="alert">{error}</p>}
    <div className="save-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary-button" disabled={busy || !title.trim()}>Publish</button></div>
  </Dialog>;
}

function ReasonDialog({ label, intro, action, onSend, onClose }: {
  label: string; intro: string; action: string; onSend: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true); setError('');
    try { await onSend(reason.trim()); }
    catch (failure) { setError(message(failure, `Could not ${action.toLowerCase()}.`)); setBusy(false); }
  }
  return <Dialog label={label} onClose={onClose} onSubmit={() => void send()}>
    <p className="account-text">{intro}</p>
    <label className="save-name">Reason<textarea className="gallery-textarea" autoFocus rows={3} value={reason} maxLength={REASON_MAX}
      onChange={event => setReason(event.target.value)} /></label>
    {error && <p className="account-error" role="alert">{error}</p>}
    <div className="save-actions gallery-actions-gap"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary-button" disabled={busy || !reason.trim()}>{action}</button></div>
  </Dialog>;
}

/** Asked before a remix replaces a visitor's layout: their work lives only in this browser. */
export function ReplaceDraftDialog({ onSignUp, onReplace, onCancel }: { onSignUp: () => void; onReplace: () => void; onCancel: () => void }) {
  return <Dialog label="Replace your layout?" onClose={onCancel}>
    <p className="account-text">This replaces your current layout in this browser. Sign up to keep it in an account first, or replace it with the remix.</p>
    <div className="save-actions"><button type="button" className="quiet-button" onClick={onReplace}>Replace</button>
      <button type="button" className="primary-button" autoFocus onClick={onSignUp}>Sign up to keep it</button></div>
  </Dialog>;
}

type Loaded = { layout: GalleryLayout; project: WorkshopProject };

/**
 * A shared layout's page: its credits and a view, and Test drive on its own copy. Nothing here touches the browser draft;
 * Remix is the only way the layout reaches the editor.
 */
export function LayoutPage({ id, onRemix, onBack, onClose, onNotice }: {
  id: string;
  onRemix: (layout: GalleryLayout, project: WorkshopProject) => void;
  /** To the gallery. */
  onBack: () => void;
  /** Back to the user's own layout. */
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'layout' | 'drive'>('layout');
  /** Test drive's copy: switches and mechanisms move here only. */
  const [driven, setDriven] = useState<WorkshopProject | null>(null);
  const [asking, setAsking] = useState<'report' | 'hide' | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null); setError(''); setTab('layout');
    loadLayout(id).then(result => { if (active) { setLoaded(result); setDriven(result.project); } },
      failure => { if (active) setError(failure instanceof ApiError && failure.status === 404 ? 'This layout is not in the gallery.' : message(failure, 'Could not open the layout.')); });
    return () => { active = false; };
  }, [id]);
  const fit = useMemo(() => driven && fitProject(driven), [driven]);
  const metres = useMemo(() => loaded ? fitProject(loaded.project).sections.reduce((sum, section) => sum + section.run, 0) / 1000 : 0, [loaded]);
  const layout = loaded?.layout;
  const update = (next: GalleryLayout) => setLoaded(current => current && { ...current, layout: next });

  async function copyLink() {
    try { await navigator.clipboard.writeText(layoutLink(id)); onNotice('Link copied.'); }
    catch { onNotice(`Copy this link: ${layoutLink(id)}`); }
  }
  async function unpublish() {
    if (!layout || !window.confirm(`Unpublish “${layout.title}”? Remixes of it keep their credit.`)) return;
    try { await unpublishLayout(layout.id); onNotice('Unpublished.'); onBack(); }
    catch (failure) { onNotice(message(failure, 'Could not unpublish the layout.')); }
  }
  async function unhide() {
    if (!layout) return;
    try { update(await unhideLayout(layout.id)); onNotice('The layout is back in the gallery.'); }
    catch (failure) { onNotice(message(failure, 'Could not show the layout again.')); }
  }
  const room = loaded && [loaded.project.measurements.roomWidth.value, loaded.project.measurements.roomDepth.value];

  return <div className="gallery-page" role="region" aria-label="Community layout">
    <header className="topbar gallery-page-bar">
      <div className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /></div>
        <span className="gallery-page-name">{layout?.title ?? 'Community layout'}</span>
        <span className="save-status">Read-only</span></div>
      {loaded && <nav className="step-nav" role="tablist" aria-label="Layout views">
        {(['layout', 'drive'] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item}
          className={`step-pill${tab === item ? ' active' : ''}`} onClick={() => setTab(item)}>{item === 'layout' ? 'Layout' : 'Test drive'}</button>)}
      </nav>}
      <div className="top-actions">
        <button type="button" className="quiet-button" onClick={onBack}>← Gallery</button>
        <button type="button" className="quiet-button" onClick={onClose}>Back to your layout</button>
        {loaded && <button type="button" className="primary-button" onClick={() => onRemix(loaded.layout, loaded.project)}>Remix</button>}
      </div>
    </header>
    {error && <div className="gallery-page-missing"><p>{error}</p><button type="button" className="quiet-button" onClick={onBack}>Browse the gallery</button></div>}
    {!loaded && !error && <p className="gallery-loading" role="status">Opening the layout…</p>}
    {loaded && layout && tab === 'layout' && <div className="gallery-page-body">
      <GalleryThumb thumbnail={layout.thumbnail} className="gallery-page-view" />
      <aside className="gallery-page-info">
        {layout.hidden && <p className="gallery-hidden-note" role="status"><strong>Hidden from the gallery.</strong> {layout.hidden.reason}
          {' '}Only its author and admins can open it.</p>}
        <h2>{layout.title}</h2>
        <p className="gallery-credit">by <strong>{layout.author}</strong> · {published(layout.publishedAt)} · <a href={LICENCE_URL} target="_blank" rel="noopener">CC BY 4.0</a></p>
        {layout.ancestors.length > 0 && <ol className="gallery-ancestors" aria-label="Remix of">
          {layout.ancestors.map(item => <li key={item.id}>Remix of <a href={layoutHash(item.id)}>“{item.title}”</a> by {item.author}</li>)}
        </ol>}
        {layout.description && <p className="gallery-description">{layout.description}</p>}
        <p className="gallery-facts">{metres.toFixed(1)} m of track · {layout.pieces} {layout.pieces === 1 ? 'piece' : 'pieces'}
          {room && room[0] && room[1] ? <> · room {(room[0] / 1000).toFixed(1)} × {(room[1] / 1000).toFixed(1)} m</> : null}</p>
        <p className="save-hint">Looking and test driving here never change your own layout. Remix copies this one into your editor with your own
          printer, material and fit.</p>
        <div className="gallery-page-actions">
          <button type="button" className="primary-button" onClick={() => onRemix(layout, loaded.project)}>Remix</button>
          <button type="button" className="quiet-button" onClick={() => setTab('drive')}>Test drive</button>
          <button type="button" className="quiet-button" onClick={() => void copyLink()}>Copy link</button>
          {!layout.mine && !layout.hidden && <button type="button" className="quiet-button" onClick={() => setAsking('report')}>Report</button>}
          {layout.mine && <button type="button" className="quiet-button gallery-danger" onClick={() => void unpublish()}>Unpublish</button>}
        </div>
        {layout.canModerate && <section className="gallery-moderation" aria-label="Moderation">
          <h3>Moderation</h3>
          {layout.reports?.length ? <ul>{layout.reports.map((report, index) => <li key={index}>{report.reason} <small>{published(report.reportedAt)}</small></li>)}</ul> :
            <p className="save-hint">No open reports.</p>}
          {layout.hidden ? <button type="button" className="quiet-button" onClick={() => void unhide()}>Unhide</button> :
            <button type="button" className="quiet-button gallery-danger" onClick={() => setAsking('hide')}>Hide</button>}
        </section>}
      </aside>
    </div>}
    {loaded && driven && fit && tab === 'drive' && <div className="gallery-page-drive">
      <DrivePanel project={driven} fit={fit} onSetState={(pieceId, state) => setDriven(current => current && setPieceState(current, pieceId, state))} />
    </div>}
    {asking === 'report' && layout && <ReasonDialog label="Report this layout" action="Send report"
      intro="Tell us what is wrong with it. An admin looks at every report; the layout stays up until they decide."
      onClose={() => setAsking(null)} onSend={async reason => { await reportLayout(layout.id, reason); setAsking(null); onNotice('Report sent. Thank you.'); }} />}
    {asking === 'hide' && layout && <ReasonDialog label="Hide this layout" action="Hide"
      intro="It leaves the gallery and its link stops working for everyone but its author and admins. The author gets this reason by email."
      onClose={() => setAsking(null)} onSend={async reason => { update(await hideLayout(layout.id, reason)); setAsking(null); onNotice('The layout is hidden.'); }} />}
  </div>;
}
