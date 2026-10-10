import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { VISITOR, loadAccount, serviceOnline, signOut, takeEmailLink, verifyEmail, type Account } from '../account/account';
import { AccountDialog, AuthDialog, SignOutDialog, VerifyBanner, type AuthRequest } from '../account/dialogs';
import { FeedbackDialog } from '../feedback/feedback-dialog';
import { libraryLoad, libraryVersion, onLibraryChange } from '../domain/library';
import { changeProject, parseProject, serializeProject, unavailablePieces, type MeasurementKey, type WorkshopProject } from '../domain/project';
import { fitProject } from '../fitting/fit';
import { DrivePanel } from '../drive/panel';
import { ExportPanel, currentLayoutPackages, type SavedRevision } from '../export/panel';
import { filesExpired, inspectionMeshes, type ArtifactReceipt } from '../export/receipt';
import { ApiError, SIGNED_OUT, apiFetch, apiJson, apiUrl, onSignedOut } from '../net/api';
import { track } from '../net/telemetry';
import { galleryRoute, layoutHash, remixLayout, remixSetup, type GalleryLayout, type GalleryRoute } from '../gallery/gallery';
import { GalleryBrowser, LayoutPage, PublishDialog, ReplaceDraftDialog } from '../gallery/views';
import { contributeRoute, type ContributeRoute } from '../contribute/contribute';
import { ContributePage, QuickLookPage, ReviewPage } from '../contribute/views';
import { RouteEditor } from './app';
import { setPieceState } from './operations';
import { SetupDrawer, createStandardProject, type SetupTarget } from './setup';
import { inventoryMatches, setSetupMeasurement } from './setup-defaults';
import { SmallScreenNotice } from './small-screen-notice';

type SavedProject = { id: string; revision: string; name: string; savedAt: string };
/** The revision that counts as clean: the last one saved or opened, or an untouched new project. Whether the project has
 * saves in the account (so Save no longer asks for a name) is `project.parentRevision !== null`. */
type Baseline = { revision: string; saved: boolean };
type Step = 'build' | 'drive' | 'print';
const STEPS: { id: Step; title: string }[] = [
  { id: 'build', title: 'Build track' },
  { id: 'drive', title: 'Test drive' },
  { id: 'print', title: 'Print' }
];
const DRAFT_KEY = 'train-layout-workshop:current';
/** A draft that cannot be opened, or another account's unsaved work, is kept here instead of being discarded (KTD9). */
const RECOVERED_KEY = `${DRAFT_KEY}:recovered`;
/** Set once the user has opened Setup; hides Build's "Typical starter set" cue for good. */
const SETUP_SEEN_KEY = 'train-layout-workshop:setup-opened';
const NOTICE_MS = 4000;

/** A new project; `account`: the signed-in member's id, so it is never taken for a visitor's work. */
function freshStart(account: string | null = null): { project: WorkshopProject; baseline: Baseline } {
  const project = { ...createStandardProject('New train layout'), provenance: { account } };
  return { project, baseline: { revision: project.revision, saved: false } };
}

/** Keeps `raw` under the recovered key; one already kept there stays, and this one goes beside it. False when storage fails. */
function keepAside(raw: string): boolean {
  try {
    const kept = localStorage.getItem(RECOVERED_KEY);
    localStorage.setItem(kept === null || kept === raw ? RECOVERED_KEY : `${RECOVERED_KEY}:${Date.now()}`, raw);
    return true;
  } catch { return false; }
}

/** Said once at start-up when the library index didn't load; the built-in catalogue works as ever. */
const LIBRARY_FAILED = 'The community library didn’t load; built-in pieces work. Reload the page to try again.';
function unavailableNotice(count: number): string {
  if (libraryLoad()?.loaded === false) return `${count === 1 ? '1 piece in this layout shows' : `${count} pieces in this layout show`} as unavailable because the community library didn’t load. Reload the page to try again.`;
  return count === 1 ? '1 piece in this layout is not in the library. It shows as an unavailable piece; replace it before preparing plates.' :
    `${count} pieces in this layout are not in the library. They show as unavailable pieces; replace them before preparing plates.`;
}

/** The browser keeps the working copy; a missing draft starts a new project, and so does an unreadable one, which is kept
 * aside under the recovered key. `startDismissed`: the id of the project whose Build start screen the user dismissed
 * ('' when not dismissed). `notice`: what to tell the user about the draft. */
function restoreDraft(): { project: WorkshopProject; baseline: Baseline; startDismissed: string; notice: string } {
  let raw: string | null = null;
  try { raw = localStorage.getItem(DRAFT_KEY); } catch { /* storage is blocked: nothing to restore or keep */ }
  if (raw === null) return { ...freshStart(), startDismissed: '', notice: '' };
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || !('project' in stored) || typeof stored.project !== 'string') throw new Error('Not a stored draft');
    const project = parseProject(stored.project);
    const baseline = 'baseline' in stored && stored.baseline && typeof stored.baseline === 'object' ? stored.baseline as Partial<Baseline> : {};
    const startDismissed = 'startDismissed' in stored && stored.startDismissed === project.id ? project.id : '';
    const missing = unavailablePieces(project).length;
    return { project, baseline: { revision: typeof baseline.revision === 'string' ? baseline.revision : '', saved: baseline.saved === true },
      startDismissed, notice: missing ? unavailableNotice(missing) : '' };
  } catch (error) {
    console.warn('Starting a new project; the browser copy could not be read and is kept aside.', error);
    return { ...freshStart(), startDismissed: '', notice: keepAside(raw)
      ? 'Your browser copy couldn’t be opened, so a new project started. The old copy is kept in this browser.'
      : 'Your browser copy couldn’t be opened, so a new project started.' };
  }
}

function isSavedProject(value: unknown): value is SavedProject {
  return !!value && typeof value === 'object' &&
    ['id', 'revision', 'name', 'savedAt'].every(key => typeof (value as Record<string, unknown>)[key] === 'string');
}

/** Click to rename; Enter or leaving the field keeps the new name, Esc or an empty name keeps the old one. */
function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing !== null || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [editing]);
  if (editing === null) return <button ref={button} className="brand-project" title="Rename project" onClick={() => setEditing(name)}>{name || 'Untitled layout'}</button>;
  const finish = (keep: boolean, returnFocus: boolean) => {
    // Unmounting the field after Enter/Esc can fire a late blur; only the first ending counts.
    if (refocus.current) return;
    const next = editing.trim();
    if (keep && next && next !== name) onRename(next);
    refocus.current = returnFocus;
    setEditing(null);
  };
  return <input className="brand-project-input" aria-label="Project name" autoFocus value={editing}
    onFocus={event => event.currentTarget.select()} onChange={event => setEditing(event.target.value)}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true, true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false, true); }
    }} onBlur={() => finish(true, false)} />;
}

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function savedAgo(savedAt: string): string {
  const seconds = (Date.parse(savedAt) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return '';
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Newest first; one entry per project with its older saves behind it. */
function groupSaved(list: readonly SavedProject[]): SavedProject[][] {
  const groups = new Map<string, SavedProject[]>();
  for (const item of [...list].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))) {
    groups.set(item.id, [...groups.get(item.id) ?? [], item]);
  }
  return [...groups.values()];
}

export function Workspace() {
  const [start] = useState(restoreDraft);
  const [project, setProject] = useState<WorkshopProject>(start.project);
  const [baseline, setBaseline] = useState<Baseline>(start.baseline);
  /** Build's start screen stays away for this project id once dismissed; another project (New, Open) gets its own. */
  const [startDismissed, setStartDismissed] = useState(start.startDismissed);
  const [account, setAccount] = useState<Account>({ status: 'connecting' });
  /** The account state the last answer gave, for callbacks registered once. */
  const accountNow = useRef(account);
  useEffect(() => { accountNow.current = account; }, [account]);
  const member = account.status === 'member' ? account.member : null;
  const online = serviceOnline(account);
  /** Sign in, sign up and the email-link screens; null while closed. */
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** At tablet-portrait widths and below the header's secondary actions fold into a Menu (styles.css); wider they show inline. */
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  /** "Save before signing out?" while asked; `busy` while saving and signing out. */
  const [signingOut, setSigningOut] = useState<'ask' | 'busy' | null>(null);
  const [savedGroups, setSavedGroups] = useState<SavedProject[][] | null>(null);
  /** The Save dialog's name field; null while the dialog is closed. */
  const [saveName, setSaveName] = useState<string | null>(null);
  /** The Open dialog's project being renamed, with the name typed so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { if (savedGroups === null) setRenaming(null); }, [savedGroups]);
  /** The newer save a refused save met (KTD2): "Keep both" or "Use newer" while asked. */
  const [conflict, setConflict] = useState<SavedProject | null>(null);
  const dialogOpen = savedGroups !== null || saveName !== null || auth !== null || accountOpen || signingOut === 'ask' || conflict !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    // On the page, not the dialog: deleting a save removes the focused row and focus falls back to the body.
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSavedGroups(null); setSaveName(null); setAuth(null); setAccountOpen(false); setConflict(null);
      setSigningOut(current => current === 'ask' ? null : current);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [dialogOpen]);
  const [notice, setNotice] = useState(start.notice || (libraryLoad()?.loaded === false ? LIBRARY_FAILED : ''));
  const [receipts, setReceipts] = useState<ArtifactReceipt[]>([]);
  const [step, setStep] = useState<Step>('build');
  const [setupRequest, setSetupRequest] = useState<{ target: SetupTarget | null } | null>(null);
  const [setupSeen, setSetupSeen] = useState(() => { try { return localStorage.getItem(SETUP_SEEN_KEY) !== null; } catch { return false; } });
  const setupOpener = useRef<HTMLElement | null>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const [drivenLayout, setDrivenLayout] = useState('');
  /** The gallery's address (`#gallery`, `#gallery=<id>`); null while the editor shows. Back and Forward move through it. */
  const [gallery, setGallery] = useState<GalleryRoute | null>(() => galleryRoute(window.location.hash));
  /** The contribute pages' address (`#contribute`, `#review`, `#review=<id>`); null while the editor shows. */
  const [contribute, setContribute] = useState<ContributeRoute | null>(() => contributeRoute(window.location.hash));
  useEffect(() => {
    const follow = () => { setGallery(galleryRoute(window.location.hash)); setContribute(contributeRoute(window.location.hash)); };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  // Usage counts (src/net/telemetry.ts): each counts once per page load, however often it opens.
  useEffect(() => track('app_open'), []);
  useEffect(() => { if (step === 'drive') track('test_drive'); else if (step === 'print') track('print_open'); }, [step]);
  useEffect(() => {
    if (gallery?.view === 'browse') track('gallery_open'); else if (gallery?.view === 'layout') track('gallery_layout_open');
  }, [gallery?.view]);
  useEffect(() => { if (contribute?.view === 'contribute') track('contribute_open'); }, [contribute?.view]);
  useEffect(() => { if (auth?.mode === 'sign-up') track('signup_open'); else if (auth?.mode === 'sign-in') track('signin_open'); }, [auth?.mode]);
  /** A full page (a shared layout, contributing, the quick look) covers the stage: unmounted, no editor key reaches the draft. */
  const covered = gallery?.view === 'layout' || contribute !== null;
  const [publishing, setPublishing] = useState(false);
  /** A remix waiting for a visitor with a layout of their own to choose: keep theirs (sign up) or replace it. */
  const [remixAsk, setRemixAsk] = useState<{ layout: GalleryLayout; project: WorkshopProject } | null>(null);
  const draftWarned = useRef(false);
  const header = useRef<HTMLElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const stepTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const dirty = project.revision !== baseline.revision;
  const currentStep = STEPS.findIndex(item => item.id === step);
  const next = STEPS[currentStep + 1], previous = STEPS[currentStep - 1];
  // Furniture and trains the library registers after the first render change what the layout's items are: fit, draw and
  // check it again. The project itself is untouched, so nothing is lost or marked unsaved.
  const library = useSyncExternalStore(onLibraryChange, libraryVersion);
  const fit = useMemo(() => fitProject(project), [project, library]); // eslint-disable-line react-hooks/exhaustive-deps
  const packages = useMemo(() => currentLayoutPackages(project, receipts), [project, receipts]);
  // Expired files are gone (R12): no download or CAD mesh comes from them.
  const kept = useMemo(() => packages.filter(receipt => !filesExpired(receipt)), [packages]);
  const downloadable = member ? kept.at(-1) : undefined;
  const meshes = useMemo(() => kept.flatMap(receipt => inspectionMeshes(receipt, fit)), [kept, fit]);
  const done: Record<Step, boolean> = {
    build: project.routes.length > 0 && fit.geometryFeasible,
    drive: drivenLayout === project.layoutRevision, print: packages.length > 0
  };

  function openSetup(target: SetupTarget | null) {
    if (!setupRequest) setupOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSetupRequest({ target });
    if (setupSeen) return;
    setSetupSeen(true);
    try { localStorage.setItem(SETUP_SEEN_KEY, '1'); } catch { /* the cue just shows again next time */ }
  }
  const closeSetup = useCallback(() => {
    setSetupRequest(null);
    (setupOpener.current?.isConnected ? setupOpener.current : setupButton.current)?.focus();
  }, []);

  // Any call that finds the session gone signs the app out; the draft stays as it is.
  useEffect(() => onSignedOut(() => { setAccount(VISITOR); setNotice(SIGNED_OUT); }), []);
  const linkTaken = useRef(false);
  useEffect(() => {
    // Once per page, even when development mode mounts twice: a verify link works only once.
    if (linkTaken.current) return;
    linkTaken.current = true;
    const link = takeEmailLink();
    if (link?.kind === 'reset') setAuth({ mode: 'reset', token: link.token });
    // A browser already signed in must send its session's CSRF token with the verify link, so the account loads first.
    void loadAccount().then(async loaded => {
      setAccount(loaded);
      if (link?.kind !== 'verify') return;
      try {
        // The link only verifies: a browser not signed in as that member signs in itself, so a link sent by someone
        // else never puts this browser (and its draft) in their account.
        const verified = await verifyEmail(link.token);
        if (verified) { setAccount(verified); setAuth({ mode: 'verified' }); }
        else setAuth({ mode: 'sign-in', reason: 'Email verified. Sign in to continue.' });
      } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not verify the email.'); }
    });
  }, []);
  useEffect(() => {
    // Back in this tab: the account may have been verified, renamed or signed out in another one.
    const refresh = () => void loadAccount().then(next => {
      if (accountNow.current.status === 'member' && next.status === 'visitor') setNotice(SIGNED_OUT);
      setAccount(next);
    });
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const verifying = member !== null && !member.verified;
  useEffect(() => {
    // The header wraps to two rows on narrow screens, and the verify banner adds one; Setup and notices sit below both.
    const element = header.current, below = banner.current;
    if (!element) return;
    const observer = new ResizeObserver(() => element.parentElement?.style.setProperty('--topbar-height', `${element.offsetHeight + (below?.offsetHeight ?? 0)}px`));
    observer.observe(element);
    if (below) observer.observe(below);
    return () => observer.disconnect();
  }, [verifying]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ project: serializeProject(project), baseline, startDismissed })); }
    catch (error) {
      console.warn('Could not keep a browser copy of the project.', error);
      if (!draftWarned.current) setNotice('This browser can’t keep a copy of your work. Save it to keep it.');
      draftWarned.current = true;
    }
  }, [project, baseline, startDismissed]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!member) return;
    let active = true;
    void apiJson<ArtifactReceipt>(`packages/${encodeURIComponent(`${project.id}-${project.layoutRevision}`)}`, { fallback: 'Could not load the prepared plates.' })
      .then(receipt => { if (active) setReceipts(current => [...current.filter(item => item.id !== receipt.id), receipt]); })
      .catch(error => { if (active && !(error instanceof ApiError && error.status === 404)) setNotice(error instanceof Error ? error.message : 'Could not load the prepared plates.'); });
    return () => { active = false; };
  }, [project.id, project.layoutRevision, member?.id]);

  function measure(key: MeasurementKey, value: number | null) {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) return;
    setProject(current => setSetupMeasurement(current, key, value));
  }

  function replaceProject(next: WorkshopProject, saved: boolean) {
    setProject(next);
    setBaseline({ revision: next.revision, saved });
    setReceipts([]);
    setDrivenLayout('');
    setSetupRequest(null);
    setStep('build');
  }

  /** Tabs keyboard pattern: arrows (wrapping), Home and End move to a step and open it. */
  function stepKey(event: ReactKeyboardEvent, index: number) {
    const last = STEPS.length - 1;
    const keys: Record<string, number> = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    setStep(STEPS[target].id);
    stepTabs.current[target]?.focus();
  }

  function newProject() {
    if (dirty && !window.confirm('Discard unsaved changes and start a new project?')) return;
    replaceProject(freshStart(member?.id ?? null).project, false);
  }

  /** Actions that need an account open sign-up; the work in the browser stays as it is. */
  function needAccount(reason: string) {
    if (online) setAuth({ mode: 'sign-up', reason });
    else setNotice('The service is offline. Your work stays in this browser.');
  }

  /** To the gallery or a layout's page; links there (the start screen, cards) arrive through `hashchange`. */
  function showGallery(hash: string) {
    window.location.hash = hash;
    setGallery(galleryRoute(hash));
  }

  /** Back to the editor; the browser draft was never touched while the gallery showed. */
  function closeGallery() {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setGallery(null);
  }

  function showContribute() {
    window.location.hash = '#contribute';
    setGallery(null);
    setContribute({ view: 'contribute' });
  }

  /** Back to the editor from the contribute pages, which never touch the browser draft. */
  function closeContribute() {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setContribute(null);
  }

  /** Publishing needs a verified member (R14) and a layout with track. */
  function requestPublish() {
    if (!member) { needAccount('Create an account to publish your layout to the gallery. Your work stays in this browser meanwhile.'); return; }
    if (!member.verified) { setNotice('Verify your email to publish to the gallery.'); return; }
    if (!project.routes.some(route => route.pieces.length)) { setNotice('Lay some track before publishing.'); return; }
    closeGallery();
    setPublishing(true);
  }

  /** Remix is the only way a gallery layout reaches the editor. A member's unsaved changes are asked about as Open asks; a
   * visitor's layout lives only in this browser, so they may sign up to keep it first. */
  function requestRemix(layout: GalleryLayout, shared: WorkshopProject) {
    if (member) {
      if (!dirty || window.confirm('Discard unsaved changes and remix this layout?')) void remix(layout, shared);
    } else if (project.routes.some(route => route.pieces.length)) setRemixAsk({ layout, project: shared });
    else void remix(layout, shared);
  }

  /** The remix takes the remixer's own print setup and fit (R27) and credits the layout and its ancestors (R15). */
  async function remix(layout: GalleryLayout, shared: WorkshopProject) {
    setRemixAsk(null);
    try {
      const next = remixLayout(layout, shared, await remixSetup(member !== null), member?.id ?? null);
      replaceProject(next, false);
      // New work, unsaved until the remixer saves it; a visitor who then signs up has it saved (R6).
      setBaseline({ revision: '', saved: false });
      closeGallery();
      track('remix');
      setNotice(`Remixed “${layout.title}”. It’s yours to change; save it to keep it.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not remix the layout.'); }
  }

  /** `target` is now `saved` in `account`: the copy takes the project id and revision the service minted. `clean`: the
   * saved content is `target`'s, so `target` is the new baseline (edits made meanwhile stay unsaved). */
  function linkSaved(target: WorkshopProject, saved: SavedProject, account: string, clean: boolean) {
    setProject(current => current.id === target.id ? { ...current, id: saved.id, parentRevision: saved.revision, provenance: { account } } : current);
    setStartDismissed(current => current === target.id ? saved.id : current);
    if (clean) setBaseline({ revision: target.revision, saved: true });
  }

  /** Saves `target` (the current project unless a rename made a new revision): a new project the first time, then a new
   * revision on top of the one it derives from. A newer save made elsewhere meanwhile is never overwritten: the conflict
   * dialog offers both ways out. The project id and revision the account holds `target` under once saved; null if not. */
  async function save(target: WorkshopProject = project): Promise<SavedRevision | null> {
    if (!member) { needAccount('Create an account to save your project. Your work stays in this browser meanwhile.'); return null; }
    if (target.revision === baseline.revision && baseline.saved && target.parentRevision !== null) return { id: target.id, revision: target.parentRevision };
    const fallback = 'Could not save the project.';
    try {
      let saved: SavedProject;
      if (target.parentRevision === null) {
        const response = await apiFetch('projects', { body: serializeProject(target), fallback });
        saved = await response.json() as SavedProject;
        // This draft is already in the account, saved from another tab and maybe changed there since (signing in claims a
        // draft before any save): which content to keep is the member's choice.
        if (response.status === 200) { setConflict(saved); return null; }
      } else saved = await apiJson<SavedProject>(`projects/${encodeURIComponent(target.id)}/revisions`, { body: serializeProject(target), fallback });
      linkSaved(target, saved, member.id, true);
      setNotice('Project saved.');
      return { id: saved.id, revision: saved.revision };
    } catch (error) {
      const latest = error instanceof ApiError && error.status === 409 && error.body && typeof error.body === 'object' && 'latest' in error.body ? error.body.latest : null;
      if (isSavedProject(latest)) { setConflict(latest); return null; }
      if (error instanceof ApiError && error.status === 404 && target.parentRevision !== null) {
        setProject(current => current.id === target.id ? { ...current, parentRevision: null } : current);
        setNotice('This project is no longer in your account. Save again to keep it as a new project.');
        return null;
      }
      setNotice(error instanceof Error ? error.message : fallback);
      return null;
    }
  }

  /** "Keep both": this copy becomes a project of its own; the newer save stays as it is. */
  async function keepBoth() {
    setConflict(null);
    const copy = changeProject(project, draft => { draft.id = crypto.randomUUID(); draft.parentRevision = null; draft.name = `${draft.name} (copy)`; });
    setProject(copy);
    setStartDismissed(current => current === project.id ? copy.id : current);
    await save(copy);
  }

  /** Save under the name typed in the Save dialog; a changed name is part of the saved revision. */
  async function saveAs(name: string) {
    const next = name.trim();
    if (!next) return;
    const target = next === project.name ? project : changeProject(project, draft => { draft.name = next; });
    if (target !== project) setProject(target);
    if (await save(target)) setSaveName(null);
  }

  /** Deletes one older save, or a whole project with all of its saves; the open copy of a deleted project stays as unsaved work. */
  async function remove(item: SavedProject, whole: boolean, saves: number) {
    const label = item.name || 'Untitled layout';
    const question = whole ? `Delete "${label}"${saves > 1 ? ` and its ${saves - 1} older ${saves === 2 ? 'save' : 'saves'}` : ''}?`
      : `Delete this older save of "${label}" (${savedAgo(item.savedAt)})?`;
    if (!window.confirm(question)) return;
    try {
      const path = whole ? encodeURIComponent(item.id) : `${encodeURIComponent(item.id)}/${encodeURIComponent(item.revision)}`;
      await apiFetch(`projects/${path}`, { method: 'DELETE', fallback: 'Could not delete the save.' });
      if (item.id === project.id && whole) setProject(current => current.id === item.id ? { ...current, parentRevision: null } : current);
      if (item.id === project.id && (whole || item.revision === baseline.revision)) setBaseline(current => ({ ...current, saved: false }));
      await listSaved();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not delete the save.'); }
  }

  /** Renames every save of a project in the library; the open copy follows without becoming a new revision. */
  async function rename(item: SavedProject, name: string) {
    const next = name.trim();
    setRenaming(null);
    if (!next || next === item.name) return;
    try {
      await apiFetch(`projects/${encodeURIComponent(item.id)}`, { method: 'PATCH', json: { name: next }, fallback: 'Could not rename the project.' });
      if (item.id === project.id) setProject(current => current.id === item.id ? { ...current, name: next } : current);
      await listSaved();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not rename the project.'); }
  }

  async function listSaved() {
    try {
      setSavedGroups(groupSaved(await apiJson<SavedProject[]>('projects', { fallback: 'Could not list saved projects.' })));
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not list saved projects.'); }
  }

  /** Opens a save; `base`: the project's latest revision, which the next save goes on top of, so an older save that is
   * opened and saved becomes the newest. `ask`: confirm discarding unsaved changes ("Use newer" already asked). True once
   * it is open. */
  async function open(saved: SavedProject, base: string, ask = true): Promise<boolean> {
    if (!member || ask && dirty && !window.confirm('Discard unsaved changes and open this project?')) return false;
    try {
      const response = await apiFetch(`projects/${encodeURIComponent(saved.id)}/${encodeURIComponent(saved.revision)}`, { fallback: 'Could not open the project.' });
      const opened = parseProject(await response.text());
      replaceProject({ ...opened, provenance: { account: member.id }, parentRevision: base }, true);
      setSavedGroups(null);
      const missing = unavailablePieces(opened).length;
      if (missing) setNotice(unavailableNotice(missing));
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open the project.'); return false; }
  }

  /** Opens the latest save of the member's project `id` in Print, where its prepare is running (the Print step's link to
   * the project another prepare is for). */
  async function openLatest(id: string) {
    try {
      const latest = groupSaved(await apiJson<SavedProject[]>('projects', { fallback: 'Could not open the project.' })).find(([item]) => item.id === id)?.[0];
      if (!latest) setNotice('That project is no longer in your account.');
      else if (await open(latest, latest.revision)) setStep('print');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open the project.'); }
  }

  /** On signing in (R6, AE1): a visitor's edited draft is saved to the account as a new project; posting the same draft
   * again (another tab, signing in again) returns the project it already became. An untouched draft becomes the member's
   * without a save. Another account's draft is never saved here: the member gets a new project, and its unsaved work is
   * kept aside. */
  async function claimDraft(account: string) {
    const owner = project.provenance.account;
    if (owner === account) return;
    if (owner !== null) {
      const kept = dirty && keepAside(JSON.stringify({ project: serializeProject(project), baseline, startDismissed }));
      replaceProject(freshStart(account).project, false);
      setStartDismissed('');
      if (dirty) setNotice(kept ? 'Started a new project. The other account’s unsaved work is kept in this browser.' : 'Started a new project.');
      return;
    }
    const target = project;
    if (!dirty) { setProject(current => current.id === target.id ? { ...current, provenance: { account } } : current); return; }
    try {
      const response = await apiFetch('projects', { body: serializeProject(target), fallback: 'Could not save your layout to your account.' });
      linkSaved(target, await response.json() as SavedProject, account, response.status === 201);
      setNotice(response.status === 201 ? 'Your layout is saved in your account.' : 'This layout is already in your account.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save your layout to your account.'); }
  }
  /** The member whose draft claim has run, so it runs once per sign-in. */
  const claimedBy = useRef<string | null>(null);
  useEffect(() => {
    if (!member) { claimedBy.current = null; return; }
    if (claimedBy.current === member.id) return;
    claimedBy.current = member.id;
    void claimDraft(member.id);
  }, [member?.id]);

  /** Signing out clears this browser's stored copy, so unsaved changes are offered a save first. */
  function requestSignOut() {
    setAccountOpen(false);
    if (dirty) setSigningOut('ask');
    else void finishSignOut(false);
  }

  async function finishSignOut(saveFirst: boolean) {
    setSigningOut(current => current && 'busy');
    try {
      if (saveFirst && !await save()) return;
      await signOut();
      signedOutHere('Signed out.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not sign out.'); }
    finally { setSigningOut(null); }
  }

  /** After signing out or deleting the account: the service cleared the browser's storage; the editor starts fresh. */
  function signedOutHere(message: string) {
    setAccountOpen(false);
    setAccount(VISITOR);
    replaceProject(freshStart().project, false);
    setStartDismissed('');
    setNotice(message);
  }

  const savedRow = (item: SavedProject, saves: number, base: string, older = false) => <div className={`saved-line${older ? ' saved-line-older' : ''}`} key={item.revision}>
    {!older && renaming?.id === item.id ? <form className="saved-rename" onSubmit={event => { event.preventDefault(); void rename(item, renaming.name); }}>
      <input aria-label="Project name" autoFocus value={renaming.name} maxLength={120} onFocus={event => event.currentTarget.select()}
        onChange={event => setRenaming({ id: item.id, name: event.target.value })} onBlur={() => void rename(item, renaming.name)}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }} />
    </form> : <button className={`saved-row${older ? ' saved-row-older' : ''}`} onClick={() => void open(item, base)}>
      <strong>{item.name || 'Untitled layout'}</strong><small>{savedAgo(item.savedAt)}</small></button>}
    {!older && <button className="saved-icon" disabled={!member} onMouseDown={event => event.preventDefault()}
      onClick={() => setRenaming(renaming?.id === item.id ? null : { id: item.id, name: item.name })}
      aria-label={`Rename ${item.name || 'Untitled layout'}`} title="Rename">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 2.1l-8 8-3 .9.9-3z M10 3.6l2.1 2.1" /></svg></button>}
    <button className="saved-delete" disabled={!member} onClick={() => void remove(item, !older, saves)}
      aria-label={older ? `Delete older save of ${item.name || 'Untitled layout'} from ${savedAgo(item.savedAt)}` : `Delete ${item.name || 'Untitled layout'}`}
      title={older ? 'Delete this save' : saves > 1 ? 'Delete this project and all its saves' : 'Delete this project'}>Delete</button>
  </div>;
  const service = account.status === 'connecting' || account.status === 'offline' ? account.status : 'connected';
  const plainStatus = { connecting: 'Connecting to the service', connected: 'Service connected', offline: 'Service offline' }[service];

  return <div className="workshop-shell">
    <header ref={header} className="topbar">
      <div className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /></div>
        <ProjectName name={project.name} onRename={name => setProject(current => changeProject(current, draft => { draft.name = name; }))} />
        <span className="save-status">{dirty ? 'Unsaved changes' : baseline.saved ? 'Saved' : ''}</span>
      </div>
      <nav className="step-nav" role="tablist" aria-label="Workshop steps">{STEPS.map((item, index) => <button key={item.id}
        ref={element => { stepTabs.current[index] = element; }} id={`step-tab-${item.id}`} role="tab"
        className={`step-pill${step === item.id ? ' active' : done[item.id] ? ' done' : ''}`}
        aria-selected={step === item.id} aria-controls="workshop-stage" tabIndex={step === item.id ? 0 : -1}
        title={`${index + 1}. ${item.title}${done[item.id] ? ' (done)' : ''}`}
        onClick={() => setStep(item.id)} onKeyDown={event => stepKey(event, index)}>
        <span className="step-badge" aria-hidden="true">{done[item.id] ? '✓' : index + 1}</span>{item.title}
      </button>)}</nav>
      <div className="top-actions">
        <span className={`service-chip ${service}`} title={plainStatus} role="status" aria-label={plainStatus}><i />{service === 'offline' && 'Offline'}</span>
        <div ref={menu} className="top-menu">
          <button className="quiet-button top-menu-toggle" aria-expanded={menuOpen} aria-controls="top-menu-items"
            onClick={() => setMenuOpen(open => !open)}>Menu</button>
          {/* A choice closes the menu (the click bubbles here); its dialog or page opens as usual. */}
          <div id="top-menu-items" className={`top-menu-items${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)}>
            <button ref={setupButton} className="quiet-button" aria-haspopup="dialog" aria-expanded={setupRequest !== null}
              onClick={() => { if (setupRequest) closeSetup(); else openSetup(null); }}>Setup</button>
            <button className="quiet-button" onClick={newProject}>New</button>
            <button className="quiet-button" disabled={!online}
              onClick={() => { if (member) void listSaved(); else setAuth({ mode: 'sign-in', reason: 'Sign in to open your saved projects.' }); }}>Open</button>
            <button className="quiet-button" onClick={() => { if (member && project.parentRevision === null) setSaveName(project.name); else void save(); }} disabled={!online}
              title={!member ? 'Create an account to save' : project.parentRevision !== null ? 'Save a new revision' : 'Name and save this project'}>Save</button>
            <button className="quiet-button" disabled={!online} aria-haspopup="dialog" title="Browse and publish shared layouts"
              onClick={() => showGallery('#gallery')}>Gallery</button>
            <button className="quiet-button app-feedback-button" aria-haspopup="dialog" aria-expanded={feedbackOpen}
              title="Tell us what broke, confused you or is missing" onClick={() => setFeedbackOpen(true)}>Feedback</button>
          </div>
        </div>
        {member ? <button className="quiet-button account-button" aria-haspopup="dialog" aria-expanded={accountOpen} title={`Your account (${member.email})`}
          onClick={() => setAccountOpen(true)}>{member.displayName}</button> :
          account.status === 'visitor' && <button className="quiet-button" aria-haspopup="dialog" onClick={() => setAuth({ mode: 'sign-in' })}>Sign in</button>}
        {step === 'build' && <button className="quiet-button step-secondary" aria-label="Go to Print" title="Skip Test drive and go to Print (Test drive is recommended first)"
          onClick={() => setStep('print')}><span className="primary-wide">Go to Print</span><span className="primary-compact" aria-hidden="true">Print</span></button>}
        {previous && <button className="quiet-button step-secondary" aria-label={`Back to ${previous.title}`} onClick={() => setStep(previous.id)}>
          <span className="primary-wide">← {previous.title}</span><span className="primary-compact" aria-hidden="true">←</span></button>}
        {next ? <button className="primary-button" aria-label={next.title} onClick={() => setStep(next.id)}><span className="primary-wide">{next.title} →</span><span className="primary-compact" aria-hidden="true">→</span></button> :
          downloadable ? <a className="primary-button" aria-label="Download all" href={apiUrl(`packages/${encodeURIComponent(downloadable.id)}/plates.zip`)} download><span className="primary-wide">Download all ↓</span><span className="primary-compact" aria-hidden="true">↓</span></a> :
          <button className="primary-button" aria-label="Prepare plates" onClick={() => {
            const prepare = document.getElementById('prepare-plates');
            prepare?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            prepare?.focus({ preventScroll: true });
          }}><span className="primary-wide">Prepare plates</span><span className="primary-compact" aria-hidden="true">⚙</span></button>}
      </div>
    </header>
    {member && !member.verified && <div ref={banner}><VerifyBanner member={member} /></div>}
    {!covered && <SmallScreenNotice />}
    {!covered && <main className={`stage-content stage-${step}`}><div id="workshop-stage" className="stage-panel" role="tabpanel" aria-labelledby={`step-tab-${step}`}>
      {step === 'build' && <RouteEditor project={project} fit={fit} account={account} onChange={setProject}
        onOpenSetup={target => openSetup(target ?? 'track')} inventoryCue={!setupSeen && inventoryMatches(project, 'city')}
        startDismissed={startDismissed === project.id} onDismissStart={() => setStartDismissed(project.id)} />}
      {step === 'drive' && <DrivePanel project={project} fit={fit} meshes={meshes}
        onEditTrack={() => setStep('build')} onGoToPrint={() => setStep('print')}
        onOpenSetup={() => openSetup('car')} onDriven={() => setDrivenLayout(project.layoutRevision)}
        onSetState={(pieceId, state) => setProject(current => setPieceState(current, pieceId, state))} />}
      {step === 'print' && <ExportPanel project={project} fit={fit} account={account} onNeedAccount={needAccount} saveRevision={save}
        receipts={receipts} onChange={setProject} onEditTrack={() => setStep('build')}
        onTestDrive={() => setStep('drive')} driven={done.drive}
        onEditMeasurement={field => openSetup(field)}
        onOpenProject={id => void openLatest(id)}
        onReceipt={receipt => setReceipts(current => [...current.filter(item => item.id !== receipt.id), receipt])} />}
    </div></main>}
    {setupRequest && !covered && <SetupDrawer project={project} onChange={setProject} onMeasure={measure} hasSupports={fit.supports.length > 0}
      request={setupRequest} onClose={closeSetup} />}
    {notice && <div className="inline-notice" role="status">{notice}</div>}
    {savedGroups && <div className="dialog-backdrop" onClick={() => setSavedGroups(null)}><div className="saved-dialog" role="dialog" aria-modal="true" aria-label="Open project"
      onClick={event => event.stopPropagation()}>
      <div className="dialog-heading"><h2>Open project</h2><button aria-label="Close" onClick={() => setSavedGroups(null)}>×</button></div>
      {savedGroups.length ? savedGroups.map(([latest, ...older]) => <div className="saved-group" key={latest.id}>{savedRow(latest, older.length + 1, latest.revision)}
        {older.length > 0 && <details className="saved-older"><summary>{older.length} older {older.length === 1 ? 'save' : 'saves'}</summary>{older.map(item => savedRow(item, 1, latest.revision, true))}</details>}
      </div>) : <p>No saved projects yet.</p>}
    </div></div>}
    {saveName !== null && <div className="dialog-backdrop" onClick={() => setSaveName(null)}><form className="saved-dialog save-dialog" role="dialog" aria-modal="true" aria-label="Save project"
      onClick={event => event.stopPropagation()}
      onSubmit={event => { event.preventDefault(); void saveAs(saveName); }}>
      <div className="dialog-heading"><h2>Save project</h2><button type="button" aria-label="Close" onClick={() => setSaveName(null)}>×</button></div>
      <label className="save-name">Name<input autoFocus value={saveName} maxLength={120} onFocus={event => event.currentTarget.select()}
        onChange={event => setSaveName(event.target.value)} /></label>
      <p className="save-hint">Later saves keep this name; rename it any time with the pencil in Open.</p>
      <div className="save-actions"><button type="button" className="quiet-button" onClick={() => setSaveName(null)}>Cancel</button>
        <button type="submit" className="primary-button" disabled={!saveName.trim()}>Save</button></div>
    </form></div>}
    {conflict && <div className="dialog-backdrop" onClick={() => setConflict(null)}><div className="saved-dialog save-dialog" role="dialog" aria-modal="true"
      aria-label="Newer save exists" onClick={event => event.stopPropagation()}>
      <div className="dialog-heading"><h2>Newer save exists</h2><button aria-label="Close" onClick={() => setConflict(null)}>×</button></div>
      <p className="save-hint">“{conflict.name || 'Untitled layout'}” was saved {savedAgo(conflict.savedAt)} from another tab or device, after the
        save your changes started from. Keep both saves your changes as a new project; Use newer opens that save instead.</p>
      <div className="save-actions"><button type="button" className="quiet-button" onClick={() => void open(conflict, conflict.revision, false).then(() => setConflict(null))}>Use newer</button>
        <button type="button" className="primary-button" autoFocus onClick={() => void keepBoth()}>Keep both</button></div>
    </div></div>}
    {gallery?.view === 'browse' && <GalleryBrowser onPublish={requestPublish} onContribute={showContribute} onClose={closeGallery} />}
    {gallery?.view === 'layout' && <LayoutPage id={gallery.id} onRemix={requestRemix} onNotice={setNotice}
      onBack={() => showGallery('#gallery')} onClose={closeGallery} />}
    {contribute?.view === 'contribute' && <ContributePage member={member} onClose={closeContribute} onNotice={setNotice}
      onNeedAccount={() => needAccount('Create an account to contribute pieces, trains and furniture. Your work stays in this browser meanwhile.')} />}
    {contribute?.view === 'review' && <ReviewPage onClose={closeContribute} />}
    {contribute?.view === 'look' && <QuickLookPage id={contribute.id} onClose={closeContribute} onNotice={setNotice} />}
    {publishing && member && <PublishDialog project={project} member={member} onClose={() => setPublishing(false)}
      onPublished={layout => { setPublishing(false); setNotice('Published to the gallery.'); showGallery(layoutHash(layout.id)); }} />}
    {remixAsk && <ReplaceDraftDialog onCancel={() => setRemixAsk(null)} onReplace={() => void remix(remixAsk.layout, remixAsk.project)}
      onSignUp={() => { setRemixAsk(null); setAuth({ mode: 'sign-up', reason: 'Create an account and your current layout is saved to it. Then come back to remix this one.' }); }} />}
    {auth && <AuthDialog request={auth} onChange={setAuth} onClose={() => setAuth(null)}
      onSignedIn={(next, note) => { setAccount(next); setAuth(null); setNotice(note); }} />}
    {accountOpen && member && <AccountDialog member={member} onClose={() => setAccountOpen(false)}
      onRenamed={renamed => { setAccount({ status: 'member', member: renamed }); setNotice('Display name changed.'); }}
      onSignOut={requestSignOut} onDeleted={() => signedOutHere('Account deleted.')} />}
    {signingOut && <SignOutDialog busy={signingOut === 'busy'} onCancel={() => setSigningOut(null)}
      onSave={() => void finishSignOut(true)} onDiscard={() => void finishSignOut(false)} />}
    {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)}
      view={`${STEPS[currentStep].title}${window.location.hash ? ` ${window.location.hash}` : ''}`} />}
  </div>;
}
