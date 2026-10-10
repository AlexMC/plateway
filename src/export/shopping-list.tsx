import { useMemo, useState } from 'react';
import { serviceOnline, type Account } from '../account/account';
import type { WorkshopProject } from '../domain/project';
import type { FitResult } from '../fitting/fit';
import { CommunityRows, communityItems } from '../editor/community-mark';
import { hardwareCsv, hardwareEmpty, hardwareGroups, hardwareRequest, hardwareText, useHardware, type HardwareRequest } from './hardware';
import './hardware.css';

/** The bought parts the whole layout needs, from the service; it follows every layout edit. */
export function ShoppingList({ project, fit, account }: { project: WorkshopProject; fit: FitResult; account: Account }) {
  const body = useMemo(() => hardwareRequest(fit.partInstances, project.routes.flatMap(route => route.pieces)), [project.routes, fit]);
  const { data, error, pending } = useHardware(body, serviceOnline(account));
  const [copied, setCopied] = useState(false);
  const community = communityItems(project).pieces;
  const title = `Shopping list — ${project.name || 'Untitled layout'}`;
  const copy = () => {
    if (!data) return;
    void navigator.clipboard.writeText(hardwareText(data, title)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  };
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([hardwareCsv(data)], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(project.name || 'layout').replace(/[^\w-]+/g, '-')}-shopping-list.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return <section className={`export-hardware ${pending ? 'is-pending' : ''}`} aria-label="Shopping list" aria-busy={pending}>
    <div className="export-hardware-title"><h3>Shopping list</h3>
      {data && !hardwareEmpty(data) && <div className="export-hardware-actions">
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy list'}</button>
        <button type="button" onClick={download}>Download CSV</button></div>}</div>
    {error ? <p className="export-hardware-quiet">{error}</p> : !data ? <p className="export-hardware-quiet">Loading…</p> : <>
      {data.warnings.map(warning => <p key={warning} className="export-hardware-warning" role="alert">{warning}</p>)}
      {hardwareEmpty(data) ? <p className="export-hardware-quiet">This layout needs no extra hardware</p> : <>
        {hardwareGroups(data).map(group => <div key={group.id} className="export-hardware-group">
          <h4>{group.label}<span>{group.total}</span></h4>
          <ul>{group.lines.map(line => <li key={line.name}><details><summary><strong>{line.quantity} ×</strong> {line.name}</summary>
            <small>{line.pieces.join(', ')}</small></details></li>)}</ul>
        </div>)}
        {data.control.length > 0 && <div className="export-hardware-group is-once">
          <h4>Control gear</h4>
          <ul>{data.control.map(item => <li key={item.name}><strong>{item.quantity} ×</strong> {item.name}
            <small> · {[item.scope, item.note].filter(Boolean).join('; ')}</small></li>)}</ul>
        </div>}
      </>}
      {data.notes.length > 0 && <ul className="export-hardware-notes">{data.notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </>}
    {community.length > 0 && <div className="export-hardware-group is-community">
      <h4>Community parts<span>{community.reduce((sum, item) => sum + item.count, 0)}</span></h4>
      <CommunityRows items={community} label="Community parts in this layout"/>
    </div>}
  </section>;
}

/** The bought parts one piece needs (palette options, selected piece): nothing when it needs none. */
export function AlsoNeeds({ body, account }: { body: HardwareRequest | null; account: Account }) {
  const { data, error, pending } = useHardware(body, serviceOnline(account));
  if (error) return <small className="hardware-also-quiet">{error}</small>;
  if (!data || hardwareEmpty(data) && !data.warnings.length) return null;
  return <section className={`hardware-also ${pending ? 'is-pending' : ''}`} aria-label="Also needs">
    <span className="hardware-also-label">Also needs</span>
    <ul>
      {data.lines.map(line => <li key={line.name}>{line.quantity} × {line.name}</li>)}
      {data.control.map(item => <li key={item.name} className="is-once">+ {item.name} — {item.scope}</li>)}
    </ul>
    {data.warnings.map(warning => <p key={warning} className="hardware-also-warning" role="note">{warning}</p>)}
  </section>;
}
