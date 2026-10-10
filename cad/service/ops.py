"""The admin ops page: the upsize trigger (R24), aggregate usage, the sign-up funnel and retention, package downloads,
in-app feature counts, browser errors and the latest feedback (`feedback.py`).

The trigger fires when the p95 queue wait (started minus created) of the prepares started in the last 7 days is above
`QUEUE_LIMIT_SECONDS`: prepares wait for a worker too long, so the server is upsized.

Member usage is counted from what the tables hold, over the last 24 hours, 7 days, 30 days and all time: sign-ups,
active members, saves, prepares, downloads, the gallery and the library, plus daily series for 30 days. Anonymous use is
only what `usage.py` keeps: per-UTC-day totals of in-app features and browser errors, so their windows are UTC days
(the 7 days are today and the 6 days before it).

`python -m cad.service.ops status` prints the report the admin page shows.
"""
from __future__ import annotations

import argparse
import calendar
from collections.abc import Sequence
from contextlib import closing
from html import escape
import json
import math
import os
from pathlib import Path
import sys
import time

from cad.service import db
from cad.service.usage import EVENTS

DAY = 24 * 3600
WEEK = 7 * DAY
QUEUE_WINDOW = 7 * DAY
QUEUE_LIMIT_SECONDS = 10 * 60
# Usage windows: an event counts in a window when it happened after `now - span`; `all` has no start.
WINDOWS = (('24h', DAY), ('7d', 7 * DAY), ('30d', 30 * DAY))
ALL = 'all'
SERIES_DAYS = 30
JOB_KINDS = ('layout', 'coupon', 'grade')
OUTCOMES = {'succeeded': 'succeeded', 'failedMember': 'failed', 'failedSystem': 'failed_system',
            'failedTooLarge': 'failed_too_large'}
# Every sign of a member being active: a session's last use, a sign-in (`login` audit row) or a save. Sessions go when
# they are signed out or idle and keep only their last use, so sign-ins and saves keep the older activity. Audit rows
# go after 90 days (`accounts.AUDIT_TTL`), so sign-ins older than that no longer count.
ACTIVITY_EVENTS = ("(SELECT user_id, last_seen_at AS at FROM sessions "
                   "UNION ALL SELECT user_id, at FROM audit_events WHERE kind = 'login' AND user_id IS NOT NULL "
                   "UNION ALL SELECT owner_id, created_at FROM revisions)")
# The last time each member was active.
ACTIVITY = f'(SELECT user_id, max(at) AS at FROM {ACTIVITY_EVENTS} GROUP BY user_id)'
# Each project's latest save.
SAVES = '(SELECT project_id, max(created_at) AS at FROM revisions GROUP BY project_id)'
# The funnel's windows (rolling, as `WINDOWS`) and its member stages after sign-up, each "has ever ...".
FUNNEL_WINDOWS = (('7d', 7 * DAY), ('30d', 30 * DAY))
FUNNEL_STAGES = (
    ('verified', 'u.email_verified_at IS NOT NULL'),
    ('saved', 'EXISTS (SELECT 1 FROM revisions r WHERE r.owner_id = u.id)'),
    ('prepared', 'EXISTS (SELECT 1 FROM jobs j WHERE j.owner_id = u.id AND j.parent_id IS NULL)'),
    ('downloaded', 'EXISTS (SELECT 1 FROM package_downloads d WHERE d.owner_id = u.id)'),
)
RETENTION_COHORTS = 8
RETENTION_WEEKS = 3
DOWNLOAD_DAYS = 7
ERROR_DAYS = 7
TOP_ERRORS = 10
FEEDBACK_LATEST = 20


def percentile(values: Sequence[float], fraction: float) -> float | None:
    """The percentile by nearest rank (`fraction` 0.95 is the p95); None without values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[math.ceil(fraction * len(ordered)) - 1]


def is_admin(database: Path, user_id: str) -> bool:
    with closing(db.connect(database)) as conn:
        row = conn.execute('SELECT is_admin FROM users WHERE id = ?', (user_id,)).fetchone()
    return bool(row and row['is_admin'])


def report(database: Path, now: float) -> dict:
    """The queue trigger, whether it has fired, usage, and the analytics sections of the admin page."""
    now = int(now)
    with closing(db.connect(database)) as conn:
        waits = [row[0] for row in conn.execute(
            'SELECT started_at - created_at FROM jobs WHERE parent_id IS NULL AND started_at IS NOT NULL '
            'AND started_at > ?', (now - QUEUE_WINDOW,))]
        sections = {'usage': usage(conn, now), 'kpis': kpis(conn, now), 'funnel': funnel(conn, now),
                    'retention': retention(conn, now), 'downloads': downloads(conn, now), 'events': events(conn, now),
                    'errors': errors(conn, now), 'feedback': feedback(conn, now)}
    queue_p95 = percentile(waits, 0.95)
    return {'generatedAt': now,
            'queue': {'fired': queue_p95 is not None and queue_p95 > QUEUE_LIMIT_SECONDS,
                      'p95Seconds': queue_p95, 'jobs': len(waits), 'limitSeconds': QUEUE_LIMIT_SECONDS},
            **sections}


def _names() -> list[str]:
    return [name for name, _ in WINDOWS] + [ALL]


def _windowed(conn, since: Sequence[int], column: str, source: str, where: str = '1') -> dict:
    """How many rows of `source` (matching `where`) have `column` in each window; null `column`s count in none."""
    counts = ', '.join([f'coalesce(sum({column} > ?), 0)'] * len(since))
    row = conn.execute(f'SELECT {counts}, count({column}) FROM {source} WHERE {where}', since).fetchone()
    return dict(zip(_names(), row))


def _distinct(conn, since: Sequence[int], value: str, column: str, source: str) -> dict:
    """How many distinct `value`s of `source` have `column` in each window."""
    counts = ', '.join([f'count(DISTINCT CASE WHEN {column} > ? THEN {value} END)'] * len(since))
    row = conn.execute(f'SELECT {counts}, count(DISTINCT {value}) FROM {source}', since).fetchone()
    return dict(zip(_names(), row))


def _prepares(conn, since: Sequence[int]) -> dict:
    """Whole prepares (a layout prepared in parts is one) by kind: enqueued by when they were created, outcomes and run
    times (started to finished, succeeded only) by when they finished."""
    names = _names()
    counts = ', '.join(['coalesce(sum(created_at > ?), 0)'] * len(since) + ['count(*)']
                       + ['coalesce(sum(finished_at > ?), 0)'] * len(since) + ['count(finished_at)'])
    result = {kind: {key: dict.fromkeys(names, 0) for key in ('enqueued', *OUTCOMES)} for kind in JOB_KINDS}
    for kind, state, *row in conn.execute(f'SELECT kind, state, {counts} FROM jobs WHERE parent_id IS NULL '
                                          'GROUP BY kind, state', (*since, *since)):
        for name, created in zip(names, row[:len(names)]):
            result[kind]['enqueued'][name] += created
        for key, outcome in OUTCOMES.items():
            if state == outcome:
                result[kind][key] = dict(zip(names, row[len(names):]))
    runs = conn.execute("SELECT kind, finished_at, finished_at - started_at FROM jobs WHERE parent_id IS NULL "
                        "AND state = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL").fetchall()
    for kind in JOB_KINDS:
        for key, fraction in (('p50Seconds', 0.5), ('p95Seconds', 0.95)):
            result[kind][key] = {
                name: percentile([seconds for run_kind, finished, seconds in runs
                                  if run_kind == kind and (start is None or finished > start)], fraction)
                for name, start in zip(names, [*since, None])}
    return result


def _date(day: int) -> str:
    return time.strftime('%Y-%m-%d', time.gmtime(day * DAY))


def _series(per_day: dict[int, int], today: int) -> list[dict]:
    """`SERIES_DAYS` UTC days up to today, oldest first, with each day's count (0 when absent)."""
    return [{'date': _date(day), 'count': per_day.get(day, 0)} for day in range(today - SERIES_DAYS + 1, today + 1)]


def _per_day(conn, source: str, column: str = 'created_at', where: str = '1', value: str = 'count(*)',
             since: int = 0) -> dict[int, int]:
    return dict(conn.execute(f'SELECT {column} / {DAY} AS day, {value} FROM {source} '
                             f'WHERE {column} >= ? AND {where} GROUP BY day', (since,)).fetchall())


def _daily(conn, now: int) -> list[dict]:
    """Sign-ups and prepares enqueued per UTC day, the last `SERIES_DAYS` days up to today."""
    today = now // DAY
    first = (today - SERIES_DAYS + 1) * DAY
    signups, prepares = _per_day(conn, 'users', since=first), _per_day(conn, 'jobs', where='parent_id IS NULL',
                                                                         since=first)
    return [{'date': _date(day), 'signups': signups.get(day, 0), 'prepares': prepares.get(day, 0)}
            for day in range(today - SERIES_DAYS + 1, today + 1)]


def usage(conn, now: int) -> dict:
    """Aggregate usage from the existing tables, per window (`WINDOWS` and all time); no personal data."""
    since = [now - span for _, span in WINDOWS]

    def count(column: str, source: str, where: str = '1') -> dict:
        return _windowed(conn, since, column, source, where)

    live = conn.execute("SELECT count(DISTINCT id) FROM library_items WHERE state = 'live'").fetchone()[0]
    return {
        'accounts': {'signups': count('created_at', 'users'), 'verified': count('email_verified_at', 'users')},
        'members': {'active': count('at', ACTIVITY)},
        'projects': {'saved': count('at', SAVES), 'revisions': count('created_at', 'revisions')},
        'prepares': _prepares(conn, since),
        'gallery': {'published': count('published_at', 'gallery_layouts'),
                    'remixes': count('published_at', 'gallery_layouts', 'json_array_length(ancestors) > 0'),
                    'reports': count('created_at', 'reports')},
        # Approved: Alex's quick look passed it (a later close or withdrawal keeps that); merged: its pull request was
        # merged; published: its item reached the library index; live: in the Community palette now.
        'library': {'uploads': count('created_at', 'submissions'),
                    'approved': count('reviewed_at', 'submissions', "state <> 'rejected'"),
                    'merged': count('updated_at', 'submissions', "state = 'merged'"),
                    'published': count('created_at', 'library_items'),
                    'live': live},
        'daily': _daily(conn, now),
    }


def _event_days(conn, name: str, first: int | None = None) -> dict[int, int]:
    """A feature's daily totals by day number (days since the epoch), from `first` on."""
    rows = conn.execute('SELECT day, count FROM event_counts WHERE name = ? AND day >= ?',
                        (name, _date(first) if first is not None else '')).fetchall()
    return {_day_number(day): count for day, count in rows}


def _day_number(date: str) -> int:
    """Days since the epoch of a `YYYY-MM-DD` UTC day."""
    return calendar.timegm(time.strptime(date, '%Y-%m-%d')) // DAY


def _days_total(per_day: dict[int, int], first: int, last: int) -> int:
    return sum(count for day, count in per_day.items() if first <= day <= last)


def kpis(conn, now: int) -> dict:
    """The headline numbers: the last 7 days against the 7 before, with 30 days of daily values. Members count by rolling
    windows as `usage`; app opens are daily totals, so their 7 days are today and the 6 UTC days before it."""
    today = now // DAY
    first = (today - SERIES_DAYS + 1) * DAY

    def rolling(column: str, source: str, value: str = 'count(*)', where: str = '1') -> dict:
        current, previous = conn.execute(
            f'SELECT (SELECT {value} FROM {source} WHERE {where} AND {column} > ?), '
            f'(SELECT {value} FROM {source} WHERE {where} AND {column} > ? AND {column} <= ?)',
            (now - WEEK, now - 2 * WEEK, now - WEEK)).fetchone()
        return {'value': current, 'previous': previous,
                'daily': _series(_per_day(conn, source, column, where, value, first), today)}

    opens = _event_days(conn, 'app_open', today - max(SERIES_DAYS, 14) + 1)
    return {
        'signups': rolling('created_at', 'users'),
        'activeMembers': rolling('at', ACTIVITY_EVENTS, 'count(DISTINCT user_id)', 'user_id IS NOT NULL'),
        'prepares': rolling('created_at', 'jobs', where='parent_id IS NULL'),
        'appOpens': {'value': _days_total(opens, today - 6, today), 'previous': _days_total(opens, today - 13, today - 7),
                     'daily': _series(opens, today)},
    }


def funnel(conn, now: int) -> dict:
    """Per window: app opens (daily totals: the window's UTC days, today included), then the members who signed up in
    the window and how many of them have since verified, saved a project, queued a prepare and downloaded a package."""
    today = now // DAY
    opens = _event_days(conn, 'app_open')
    stages = ', '.join(f'coalesce(sum({condition}), 0)' for _, condition in FUNNEL_STAGES)
    result = {}
    for name, span in (*FUNNEL_WINDOWS, (ALL, None)):
        start = now - span if span is not None else None
        row = conn.execute(f'SELECT count(*), {stages} FROM users u WHERE ? IS NULL OR u.created_at > ?',
                           (start, start)).fetchone()
        days = span // DAY if span is not None else None
        result[name] = {'appOpens': sum(opens.values()) if days is None else _days_total(opens, today - days + 1, today),
                        'signups': row[0], **{stage: value for (stage, _), value in zip(FUNNEL_STAGES, row[1:])}}
    return result


def retention(conn, now: int) -> dict:
    """Members by the UTC week (Monday to Sunday) they signed up in, the last `RETENTION_COHORTS` weeks: for each of the
    weeks +1 to +3 after a member's own sign-up (+1 is days 7 to 13), how many were active then, out of the members
    for whom that week has ended."""
    today = now // DAY
    monday = today - (today + 3) % 7  # day 0 (1970-01-01) was a Thursday
    first = monday - (RETENTION_COHORTS - 1) * 7
    members = conn.execute('SELECT id, created_at FROM users WHERE created_at >= ?', (first * DAY,)).fetchall()
    activity: dict[str, list[int]] = {}
    for user, at in conn.execute(f'SELECT a.user_id, a.at FROM {ACTIVITY_EVENTS} a JOIN users u ON u.id = a.user_id '
                                 'WHERE u.created_at >= ?', (first * DAY,)):
        activity.setdefault(user, []).append(at)
    cohorts = []
    for week in range(RETENTION_COHORTS):
        start = (first + week * 7) * DAY
        joined = [(user, created) for user, created in members if start <= created < start + WEEK]
        cells = []
        for offset in range(1, RETENTION_WEEKS + 1):
            eligible = [(user, created) for user, created in joined if created + (offset + 1) * WEEK <= now]
            active = sum(any(created + offset * WEEK <= at < created + (offset + 1) * WEEK
                             for at in activity.get(user, ())) for user, created in eligible)
            cells.append({'active': active, 'eligible': len(eligible),
                          'share': active / len(eligible) if eligible else None})
        cohorts.append({'week': _date(first + week * 7), 'members': len(joined), 'weeks': cells})
    return {'weeks': cohorts}


def downloads(conn, now: int) -> dict:
    """Package downloads per window, and the share of succeeded layout prepares downloaded within `DOWNLOAD_DAYS` of
    finishing, counting only prepares whose days have passed: those that finished in the 30 days before that, and all."""
    since = [now - span for _, span in WINDOWS]
    within = DOWNLOAD_DAYS * DAY
    shares = {}
    for name, start in (('30d', now - within - 30 * DAY), (ALL, None)):
        prepared, downloaded = conn.execute(
            "SELECT count(*), coalesce(sum(EXISTS (SELECT 1 FROM package_downloads d WHERE d.package_id = j.package_id "
            "AND d.at <= j.finished_at + ?)), 0) FROM jobs j WHERE j.parent_id IS NULL AND j.kind = 'layout' "
            "AND j.state = 'succeeded' AND j.package_id IS NOT NULL AND j.owner_id IS NOT NULL "
            "AND j.finished_at <= ? AND (? IS NULL OR j.finished_at > ?)",
            (within, now - within, start, start)).fetchone()
        shares[name] = {'prepared': prepared, 'downloaded': downloaded,
                        'share': downloaded / prepared if prepared else None}
    return {'packages': _distinct(conn, since, 'package_id', 'at', 'package_downloads'),
            'zip': _windowed(conn, since, 'at', 'package_downloads', "kind = 'zip'"),
            'file': _windowed(conn, since, 'at', 'package_downloads', "kind = 'file'"),
            'members': _distinct(conn, since, 'owner_id', 'at', 'package_downloads'),
            'layoutsWithin7d': shares}


def events(conn, now: int) -> list[dict]:
    """Each in-app feature (`usage.EVENTS`): page loads that used it today, in the last 7 and 30 UTC days, its daily
    series, and its 30-day count per app open (the share of page loads that used it)."""
    today = now // DAY
    first = today - SERIES_DAYS + 1
    per_name: dict[str, dict[int, int]] = {}
    for day, name, count in conn.execute('SELECT day, name, count FROM event_counts WHERE day >= ?', (_date(first),)):
        per_name.setdefault(name, {})[_day_number(day)] = count
    opens = _days_total(per_name.get('app_open', {}), first, today)
    rows = []
    for name in EVENTS:
        days = per_name.get(name, {})
        month = _days_total(days, first, today)
        rows.append({'name': name, 'today': days.get(today, 0), '7d': _days_total(days, today - 6, today), '30d': month,
                     'perAppOpen': None if name == 'app_open' else month / opens if opens else 0,
                     'daily': _series(days, today)})
    return rows


def errors(conn, now: int) -> dict:
    """Browser errors in the last `ERROR_DAYS` UTC days: the total, distinct fingerprints and the `TOP_ERRORS` most
    frequent, each with its latest message, place, version and time."""
    first = _date(now // DAY - ERROR_DAYS + 1)
    total, fingerprints = conn.execute('SELECT coalesce(sum(count), 0), count(DISTINCT fingerprint) FROM client_errors '
                                       'WHERE day >= ?', (first,)).fetchone()
    top = conn.execute(
        'SELECT e.fingerprint, e.count, l.message, l.where_, l.version, e.last_at FROM '
        '(SELECT fingerprint, sum(count) AS count, max(last_at) AS last_at FROM client_errors WHERE day >= ? '
        'GROUP BY fingerprint) e JOIN client_errors l ON l.fingerprint = e.fingerprint AND l.last_at = e.last_at '
        'AND l.day >= ? GROUP BY e.fingerprint ORDER BY e.count DESC, e.last_at DESC, e.fingerprint LIMIT ?',
        (first, first, TOP_ERRORS)).fetchall()
    return {'total': total, 'fingerprints': fingerprints, 'days': ERROR_DAYS,
            'top': [{'fingerprint': mark, 'count': count, 'message': message, 'where': where, 'version': version,
                     'lastAt': last} for mark, count, message, where, version, last in top]}


def feedback(conn, now: int) -> dict:
    """Feedback sent in the last 7 and 30 days (rolling, as `WINDOWS`), and the `FEEDBACK_LATEST` newest with the sender's
    current display name when they were signed in."""
    week, month = conn.execute('SELECT coalesce(sum(created_at > ?), 0), coalesce(sum(created_at > ?), 0) FROM feedback',
                               (now - 7 * DAY, now - 30 * DAY)).fetchone()
    latest = conn.execute('SELECT f.id, f.message, f.page, f.version, f.email, u.display_name, f.created_at '
                          'FROM feedback f LEFT JOIN users u ON u.id = f.member_id '
                          'ORDER BY f.created_at DESC, f.id DESC LIMIT ?', (FEEDBACK_LATEST,)).fetchall()
    return {'7d': week, '30d': month,
            'latest': [{'id': row_id, 'message': message, 'page': page, 'version': version, 'email': email,
                        'member': member, 'createdAt': at}
                       for row_id, message, page, version, email, member, at in latest]}


# Friendly names for the in-app features, in `usage.EVENTS` order.
EVENT_LABELS = {
    'app_open': 'App opened', 'start_example': 'Started from an example', 'start_describe': 'Started with Describe',
    'start_hand': 'Started by hand', 'describe_run': 'Describe track run', 'test_drive': 'Test drive opened',
    'print_open': 'Print step opened', 'prepare_request': 'Prepare clicked', 'gallery_open': 'Gallery opened',
    'gallery_layout_open': 'Shared layout opened', 'remix': 'Remix confirmed', 'contribute_open': 'Contribute opened',
    'community_item_placed': 'Community item placed', 'signup_open': 'Sign-up opened', 'signin_open': 'Sign-in opened',
    'feedback_open': 'Feedback opened',
}
WINDOW_LABELS = ('Last 24\u00a0h', '7\u00a0days', '30\u00a0days', 'All time')
SVG = 'xmlns="http://www.w3.org/2000/svg"'
DASH, DOT = '\u2013', '\u00b7'
EMPTY_SPLIT = '<rect class="meter-track" width="100" height="10"/>'


def _seconds(value: float | None) -> str:
    return DASH if value is None else f'{value / 60:.1f} min' if value >= 120 else f'{value:.2f} s'


def _percent(value: float | None, digits: int = 0) -> str:
    if value is None:
        return DASH
    shown = f'{value * 100:.{digits}f}'
    return '<1%' if value and float(shown) == 0 else f'{shown}%'


def _ratio(part: int, whole: int) -> float | None:
    return part / whole if whole else None


def _time(at: int) -> str:
    return time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(at))


def _ago(at: int, now: int) -> str:
    seconds = max(now - at, 0)
    for unit, size in (('d', DAY), ('h', 3600), ('min', 60)):
        if seconds >= size:
            return f'{seconds // size} {unit} ago'
    return 'just now'


def _cells(values: dict, format=str) -> str:
    return ''.join(f'<td>{escape(format(values[name]))}</td>' for name in _names())


def _spark(values: list[int], label: str, kind: str = 'spark') -> str:
    """A line with a filled area under it, as inline SVG stretched to its box by the stylesheet."""
    width, height = 120, 32
    peak = max(max(values, default=0), 1)
    step = width / max(len(values) - 1, 1)
    points = [f'{index * step:.1f},{height - 2 - value / peak * (height - 4):.1f}' for index, value in enumerate(values)]
    area = f'M0,{height} L{" L".join(points)} L{width},{height} Z'
    return (f'<svg {SVG} class="{kind}" viewBox="0 0 {width} {height}" preserveAspectRatio="none" role="img" '
            f'aria-label="{escape(label)}"><title>{escape(label)}</title><path class="spark-area" d="{area}"/>'
            f'<polyline class="spark-line" points="{" ".join(points)}" vector-effect="non-scaling-stroke"/></svg>')


def _meter(fraction: float | None, kind: str = 'meter') -> str:
    """A horizontal bar filled to `fraction` (0 to 1)."""
    filled = max(min(fraction or 0, 1), 0) * 100
    return (f'<svg {SVG} class="{kind}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">'
            f'<rect class="meter-track" width="100" height="8"/>'
            f'<rect class="meter-fill" width="{filled:.2f}" height="8"/></svg>')


def _bars(label: str, days: list[dict], key: str) -> str:
    """A bar per day as inline SVG (no script, no style attribute), each with its date and count as a tooltip."""
    width, height, step = 8, 40, 10
    peak = max(day[key] for day in days)
    total = sum(day[key] for day in days)
    rects = []
    for index, day in enumerate(days):
        bar = max(round(day[key] / max(peak, 1) * height), 1)
        kind = 'bar' if day[key] else 'bar bar-empty'
        rects.append(f'<rect class="{kind}" x="{index * step}" y="{height - bar}" width="{width}" height="{bar}" rx="1">'
                     f'<title>{escape(day["date"])}: {day[key]}</title></rect>')
    summary = f'{label}, last {len(days)} days: {total} in all, at most {peak} a day'
    return (f'<figure class="chart"><figcaption><span>{escape(label)}</span><span class="muted">{total:,} in 30 days'
            f'</span></figcaption><svg {SVG} class="bars" viewBox="0 0 {len(days) * step - 2} {height}" '
            f'preserveAspectRatio="none" role="img" aria-label="{escape(summary)}">{"".join(rects)}</svg>'
            f'<div class="axis"><span>{escape(days[0]["date"][5:])}</span><span>today</span></div></figure>')


def _section(anchor: str, title: str, lede: str, body: str) -> str:
    return (f'<section class="section" id="{anchor}" aria-labelledby="{anchor}-title"><header class="section-head">'
            f'<h2 id="{anchor}-title">{escape(title)}</h2><p class="lede">{lede}</p></header>{body}</section>')


def _window_table(caption: str, rows: list[tuple[str, str]]) -> str:
    head = ''.join(f'<th scope="col">{label}</th>' for label in ('', *WINDOW_LABELS))
    body = '\n'.join(f'<tr><th scope="row">{escape(name)}</th>{cells}</tr>' for name, cells in rows)
    return (f'<div class="table-card"><div class="scroll"><table class="windows"><caption>{escape(caption)}'
            f'</caption><thead><tr>{head}</tr></thead><tbody>\n{body}\n</tbody></table></div></div>')


def _delta(value: int, previous: int) -> str:
    change = value - previous
    if not change:
        return '<p class="delta flat">\u00b10 <span>vs previous 7 days</span></p>'
    direction, arrow = ('up', '\u25b2') if change > 0 else ('down', '\u25bc')
    relative = f' ({change / previous:+.0%})' if previous else ''
    return (f'<p class="delta {direction}">{arrow} {abs(change):,}{relative} <span>vs previous 7 days</span></p>')


def _kpis(kpis: dict) -> str:
    cards = []
    for key, label, note in (('signups', 'Sign-ups', 'New accounts'), ('activeMembers', 'Active members',
                                                                      'Signed in, used a session or saved'),
                             ('prepares', 'Prepares', 'Queued, all kinds'), ('appOpens', 'App opens',
                                                                              'Page loads of the app, UTC days')):
        kpi = kpis[key]
        values = [day['count'] for day in kpi['daily']]
        cards.append(f'<article class="kpi"><h3>{label}</h3><p class="kpi-value">{kpi["value"]:,}</p>'
                     f'{_delta(kpi["value"], kpi["previous"])}'
                     f'{_spark(values, f"{label} per day, last {len(values)} days: {sum(values):,} in all")}'
                     f'<p class="kpi-note">{note} \u00b7 30 days</p></article>')
    return f'<section class="kpis" aria-label="Last 7 days">{"".join(cards)}</section>'


def _funnel(funnel: dict) -> str:
    stages = (('signups', 'Signed up'), ('verified', 'Verified their email'), ('saved', 'Saved a project'),
              ('prepared', 'Queued a prepare'), ('downloaded', 'Downloaded a package'))
    panels = []
    for name, title in (('7d', 'Last 7 days'), ('30d', 'Last 30 days'), (ALL, 'All time')):
        counts = funnel[name]
        opens, signups = counts['appOpens'], counts['signups']
        rows = [f'<li class="stage stage-visits"><div class="stage-head"><span>App opens</span>'
                f'<strong>{opens:,}</strong></div>{_meter(1 if opens else 0)}'
                f'<p class="conv">Anonymous page loads</p></li>']
        previous = opens
        for key, label in stages:
            value = counts[key]
            conversion = _ratio(value, previous)
            of = 'of app opens' if key == 'signups' else 'of the stage above'
            rows.append(f'<li class="stage"><div class="stage-head"><span>{label}</span><strong>{value:,}</strong></div>'
                        f'{_meter(_ratio(value, signups) if key != "signups" else (1 if signups else 0))}'
                        f'<p class="conv"><b>{_percent(conversion, 1 if key == "signups" else 0)}</b> {of}</p></li>')
            previous = value
        panels.append(f'<article class="panel funnel"><h3>{title}</h3><ol class="stages">{"".join(rows)}</ol></article>')
    lede = ('App opens are daily totals of anonymous page loads. The members are those who signed up in the window, '
            'and how many of them have since reached each stage; bars are relative to the sign-ups.')
    return _section('funnel', 'Funnel', lede, f'<div class="grid-3">{"".join(panels)}</div>')


def _heat(share: float | None) -> str:
    return 'heat-na' if share is None else f'heat-{min(int(share * 5), 4) + (1 if share else 0)}'


def _retention(retention: dict) -> str:
    rows = []
    for cohort in reversed(retention['weeks']):
        week = time.strftime('%d %b<span class="year"> %Y</span>', time.strptime(cohort['week'], '%Y-%m-%d'))
        cells = ''.join(
            f'<td class="heat {_heat(cell["share"])}" title="{cell["active"]} of {cell["eligible"]} members">'
            f'{_percent(cell["share"]) if cell["share"] is not None else DOT}</td>' for cell in cohort['weeks'])
        rows.append(f'<tr><th scope="row">{week}</th><td class="size">{cohort["members"]:,}</td>{cells}</tr>')
    head = ''.join(f'<th scope="col">Week +{offset}</th>' for offset in range(1, RETENTION_WEEKS + 1))
    table = (f'<div class="table-card"><div class="scroll"><table class="heatmap"><caption>Share of each sign-up week '
             f'active again</caption><thead><tr><th scope="col">Sign-up week</th><th scope="col">Members</th>'
             f'{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
             '<p class="legend"><span class="key heat-1"></span>under 20%<span class="key heat-3"></span>40\u201360%'
             '<span class="key heat-5"></span>80% and over<span class="key heat-na"></span>not over yet</p></div>')
    lede = ('Members by the UTC week (Monday to Sunday) they signed up in. Week +1 is days 7\u201313 after each '
            'member\u2019s own sign-up; a cell counts only the members whose week has ended. Active: signed in, used '
            'a session (its last use only) or saved a project.')
    return _section('retention', 'Weekly retention', lede, table)


def _usage_tables(used: dict) -> str:
    accounts = _window_table('Accounts and projects', [
        ('Sign-ups', _cells(used['accounts']['signups'])), ('Verified', _cells(used['accounts']['verified'])),
        ('Active members', _cells(used['members']['active'])), ('Projects saved', _cells(used['projects']['saved'])),
        ('Revisions', _cells(used['projects']['revisions']))])
    charts = (f'<div class="panel charts">{_bars("Sign-ups per day", used["daily"], "signups")}'
              f'{_bars("Prepares per day", used["daily"], "prepares")}</div>')
    lede = 'Counts from the members\u2019 own tables, for accounts still open.'
    return _section('usage', 'Usage', lede, f'<div class="grid-2 wide-first">{accounts}{charts}</div>')


def _features(rows: list[dict]) -> str:
    lines = []
    for row in rows:
        values = [day['count'] for day in row['daily']]
        share = row['perAppOpen']
        usage_cell = ('<td class="share muted" data-label="Share of app opens">every page load</td>' if share is None else
                      f'<td class="share" data-label="Share of app opens">{_meter(share)}<span>{_percent(share, 1)}</span></td>')
        label = EVENT_LABELS.get(row['name'], row['name'])
        lines.append(f'<tr><th scope="row">{escape(label)}<code>{escape(row["name"])}</code></th>'
                     f'<td data-label="Today">{row["today"]:,}</td><td data-label="7 days">{row["7d"]:,}</td>'
                     f'<td data-label="30 days">{row["30d"]:,}</td>{usage_cell}'
                     f'<td class="trend">{_spark(values, f"{label}, last 30 days: {sum(values):,}", "spark spark-small")}'
                     f'</td></tr>')
    table = ('<div class="table-card"><div class="scroll"><table class="features stack"><caption>Page loads that used each '
             'feature</caption><thead><tr><th scope="col">Feature</th><th scope="col">Today</th><th scope="col">7 days'
             '</th><th scope="col">30 days</th><th scope="col">Share of app opens, 30 days</th><th scope="col">30-day '
             f'trend</th></tr></thead><tbody>{"".join(lines)}</tbody></table></div></div>')
    lede = ('The app counts each feature at most once per page load, as anonymous daily totals: a count is page loads '
            'that used it. Days are UTC; 7 days is today and the 6 before.')
    return _section('features', 'In-app features', lede, table)


def _printing(queue: dict, prepares: dict) -> str:
    if queue['fired']:
        badge = '<span class="badge badge-alert">Upsize the server</span>'
    elif queue['jobs']:
        badge = '<span class="badge badge-ok">Queue healthy</span>'
    else:
        badge = '<span class="badge badge-idle">No prepares this week</span>'
    trigger = (f'<article class="panel queue"><h3>Queue trigger (R24)</h3>{badge}<dl class="facts">'
               f'<div><dt>Wait p95, 7 days</dt><dd>{_seconds(queue["p95Seconds"])}</dd></div>'
               f'<div><dt>Prepares started</dt><dd>{queue["jobs"]:,}</dd></div>'
               f'<div><dt>Fires above</dt><dd>{_seconds(queue["limitSeconds"])}</dd></div></dl></article>')
    cards = [trigger]
    outcomes = (('succeeded', 'Succeeded'), ('failedMember', 'Member error'), ('failedSystem', 'System error'),
                ('failedTooLarge', 'Too large'))
    for kind in JOB_KINDS:
        stats = prepares[kind]
        counts = [(key, label, stats[key]['30d']) for key, label in outcomes]
        finished = sum(count for _, _, count in counts)
        x, segments = 0.0, []
        for key, label, count in counts:
            if count:
                width = count / finished * 100
                segments.append(f'<rect class="seg seg-{key}" x="{x:.2f}" width="{width:.2f}" height="10">'
                                f'<title>{label}: {count}</title></rect>')
                x += width
        split = (f'<svg {SVG} class="split" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" '
                 f'aria-label="Outcomes, 30 days">{"".join(segments) or EMPTY_SPLIT}'
                 '</svg>')
        legend = ''.join(f'<li><span class="key seg-{key}"></span>{label} <b>{count:,}</b></li>'
                         for key, label, count in counts)
        cards.append(
            f'<article class="panel prepare"><h3>{kind.capitalize()} prepares</h3><p class="big">'
            f'{stats["enqueued"]["30d"]:,}<span> queued, 30 days</span></p>'
            f'<p class="rate">{_percent(_ratio(stats["succeeded"]["30d"], finished))} of finished succeeded</p>'
            f'{split}<ul class="legend-list">{legend}</ul><dl class="facts">'
            f'<div><dt>Run p50</dt><dd>{_seconds(stats["p50Seconds"]["30d"])}</dd></div>'
            f'<div><dt>Run p95</dt><dd>{_seconds(stats["p95Seconds"]["30d"])}</dd></div></dl></article>')
    rows = []
    for kind in JOB_KINDS:
        stats = prepares[kind]
        rows += [(f'{kind.capitalize()}: enqueued', _cells(stats['enqueued'])),
                 (f'{kind.capitalize()}: succeeded', _cells(stats['succeeded'])),
                 (f'{kind.capitalize()}: failed (member)', _cells(stats['failedMember'])),
                 (f'{kind.capitalize()}: failed (system)', _cells(stats['failedSystem'])),
                 (f'{kind.capitalize()}: failed (too large)', _cells(stats['failedTooLarge'])),
                 (f'{kind.capitalize()}: run p50', _cells(stats['p50Seconds'], _seconds)),
                 (f'{kind.capitalize()}: run p95', _cells(stats['p95Seconds'], _seconds))]
    details = (f'<details class="more"><summary>Every window</summary>{_window_table("Prepares", rows)}</details>')
    lede = ('A prepare in parts counts once; outcomes and run times (succeeded only) count when it finished. The '
            'queue trigger fires when the p95 wait of the week\u2019s prepares passes the limit.')
    return _section('printing', 'Printing', lede, f'<div class="grid-4">{"".join(cards)}</div>{details}')


def _downloads(downloads: dict) -> str:
    tiles = []
    for key, label in (('packages', 'Packages downloaded'), ('members', 'Members who downloaded'),
                       ('zip', 'ZIP downloads'), ('file', 'Single-file downloads')):
        counts = downloads[key]
        tiles.append(f'<article class="panel stat"><h3>{label}</h3><p class="big">{counts["7d"]:,}<span> 7 days</span>'
                     f'</p><p class="sub">{counts["30d"]:,} in 30 days \u00b7 {counts[ALL]:,} all time</p></article>')
    shares = []
    for key, title in (('30d', 'Finished 8\u201337 days ago'), (ALL, 'All time')):
        share = downloads['layoutsWithin7d'][key]
        shares.append(f'<div class="share-row"><div class="stage-head"><span>{title}</span>'
                      f'<strong>{_percent(share["share"])}</strong></div>{_meter(share["share"])}'
                      f'<p class="conv">{share["downloaded"]:,} of {share["prepared"]:,} succeeded layout prepares</p>'
                      '</div>')
    within = (f'<article class="panel stat-wide"><h3>Layouts downloaded within 7 days of preparing</h3>{"".join(shares)}'
              '</article>')
    lede = ('Each download of a member\u2019s package: a whole ZIP, or one file. The share counts layout prepares '
            'whose 7 days have passed.')
    return _section('downloads', 'Downloads', lede, f'<div class="grid-4">{"".join(tiles)}</div>{within}')


def _library(used: dict) -> str:
    gallery, library = used['gallery'], used['library']
    galleries = _window_table('Gallery', [('Published', _cells(gallery['published'])),
                                          ('Remixes', _cells(gallery['remixes'])),
                                          ('Reports', _cells(gallery['reports']))])
    libraries = _window_table('Library', [
        ('Uploads', _cells(library['uploads'])), ('Approved', _cells(library['approved'])),
        ('Merged', _cells(library['merged'])), ('Published', _cells(library['published'])),
        ('Live items now', f'<td colspan="4">{library["live"]:,}</td>')])
    lede = ('Approved: the quick look passed it; merged: its pull request was merged; published: it reached the library '
            'index; live: in the Community palette now.')
    return _section('library', 'Library and gallery', lede, f'<div class="grid-2">{galleries}{libraries}</div>')


def _errors(errors: dict, now: int) -> str:
    stats = (f'<div class="grid-2 compact"><article class="panel stat"><h3>Errors, {errors["days"]} days</h3>'
             f'<p class="big">{errors["total"]:,}</p></article><article class="panel stat"><h3>Distinct errors</h3>'
             f'<p class="big">{errors["fingerprints"]:,}</p></article></div>')
    if errors['top']:
        rows = ''.join(
            f'<tr><td class="count">{row["count"]:,}</td><td class="message"><span>{escape(row["message"])}</span>'
            f'<code>{escape(row["fingerprint"])}</code></td><td class="where" data-label="Where"><code>{escape(row["where"] or DASH)}</code>'
            f'</td><td data-label="Version"><code>{escape(row["version"] or DASH)}</code></td>'
            f'<td class="when" data-label="Last seen" title="{_time(row["lastAt"])}">{_ago(row["lastAt"], now)}</td></tr>'
            for row in errors['top'])
        table = ('<div class="table-card"><div class="scroll"><table class="errors stack"><caption>Most frequent</caption>'
                 '<thead><tr><th scope="col">Count</th><th scope="col">Message</th><th scope="col">Where</th>'
                 f'<th scope="col">Version</th><th scope="col">Last seen</th></tr></thead><tbody>{rows}</tbody></table>'
                 '</div></div>')
    else:
        table = '<p class="empty">No browser errors reported in the last 7 days.</p>'
    lede = (f'Errors the app reported, counted per UTC day and fingerprint: the last {errors["days"]} days, the '
            f'{TOP_ERRORS} most frequent.')
    return _section('errors', 'Browser errors', lede, stats + table)


def _feedback(feedback: dict, now: int) -> str:
    stats = (f'<div class="grid-2 compact"><article class="panel stat"><h3>Feedback, 7 days</h3>'
             f'<p class="big">{feedback["7d"]:,}</p></article><article class="panel stat"><h3>Feedback, 30 days</h3>'
             f'<p class="big">{feedback["30d"]:,}</p></article></div>')
    if feedback['latest']:
        def sender(row: dict) -> str:
            who = escape(row['member']) if row['member'] else 'Visitor'
            email = (f'<a href="mailto:{escape(row["email"])}">{escape(row["email"])}</a>' if row['email'] else
                     '<small>No email</small>')
            return f'{who}<br>{email}'
        rows = ''.join(
            f'<tr><td class="message">{escape(row["message"])}</td><td class="from" data-label="From">{sender(row)}</td>'
            f'<td data-label="Page"><code>{escape(row["page"] or DASH)}</code></td>'
            f'<td data-label="Version"><code>{escape(row["version"] or DASH)}</code></td>'
            f'<td class="when" data-label="Sent" title="{_time(row["createdAt"])}">{_ago(row["createdAt"], now)}</td></tr>'
            for row in feedback['latest'])
        table = ('<div class="table-card"><div class="scroll"><table class="feedback stack"><caption>Latest</caption>'
                 '<thead><tr><th scope="col">Message</th><th scope="col">From</th><th scope="col">Page</th>'
                 f'<th scope="col">Version</th><th scope="col">Sent</th></tr></thead><tbody>{rows}</tbody></table>'
                 '</div></div>')
    else:
        table = '<p class="empty">No feedback yet.</p>'
    lede = (f'What testers sent with the Feedback form in the app and on the site, newest first: the latest '
            f'{FEEDBACK_LATEST}. Each one is also emailed to the admins; feedback is deleted after a year.')
    return _section('feedback', 'Feedback', lede, stats + table)


def render(view: dict) -> str:
    """The admin page: headline numbers, then each section; styled only by `/admin/ops.css` (no inline style or
    script, so the Content-Security-Policy holds)."""
    used, now = view['usage'], view['generatedAt']
    nav = ''.join(f'<li><a href="#{anchor}">{label}</a></li>' for anchor, label in (
        ('funnel', 'Funnel'), ('retention', 'Retention'), ('usage', 'Usage'), ('features', 'Features'),
        ('printing', 'Printing'), ('downloads', 'Downloads'), ('library', 'Library'), ('errors', 'Errors'),
        ('feedback', 'Feedback')))
    queue = view['queue']
    status = ('<span class="badge badge-alert">Upsize the server</span>' if queue['fired'] else
              '<span class="badge badge-ok">Queue healthy</span>' if queue['jobs'] else
              '<span class="badge badge-idle">Queue idle</span>')
    footer = ('<footer class="notes wrap"><p>Active members signed in, used a session or saved a project in the window. '
              'Sign-in history older than 90 days is not kept, so all-time active members count the last 90 days of '
              'sign-ins plus sessions and saves. '
              'A prepare in parts counts once; its outcome and run time count when it finished. Counts cover accounts '
              'still open. Days are UTC.</p><p>Package downloads are recorded per member and package, and deleted with '
              'the account. Anonymous use is measured as daily totals only: in-app features and browser errors, with no '
              'cookie, identifier or IP address, kept for 400 days.</p></footer>')
    body = ''.join([
        _kpis(view['kpis']), _funnel(view['funnel']), _retention(view['retention']), _usage_tables(used),
        _features(view['events']), _printing(queue, used['prepares']), _downloads(view['downloads']), _library(used),
        _errors(view['errors'], now), _feedback(view['feedback'], now)])
    return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="robots" content="noindex"><title>Plateway \u00b7 Operations</title>'
            '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
            '<link rel="stylesheet" href="/admin/ops.css"></head><body>\n'
            '<header class="topbar"><div class="wrap topbar-row"><a class="wordmark" href="/">'
            '<span class="mark" aria-hidden="true"><span></span><span></span></span>Plateway</a>'
            f'<span class="crumb">Operations</span>{status}</div></header>\n'
            f'<main class="wrap"><div class="title-row"><div><p class="eyebrow">Admin</p><h1>Operations</h1></div>'
            f'<p class="stamp">Updated <time datetime="{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}">'
            f'{_time(now)}</time><br><span>Headline numbers: the last 7 days against the 7 before</span></p></div>'
            f'<nav class="jump" aria-label="Sections"><ul>{nav}</ul></nav>\n{body}</main>\n{footer}</body></html>\n')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='The R24 upsize trigger and usage.')
    parser.add_argument('command', choices=('status',))
    parser.parse_args(argv)
    database = db.database_path(Path(os.environ.get('TRAIN_PROJECT_DIR', '.projects')))
    db.migrate(database)
    print(json.dumps(report(database, time.time()), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
