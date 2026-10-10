"""Grant or revoke admin rights on the server: `python -m cad.service.set_admin <email> [--revoke]`.

No API route changes `users.is_admin`; this script, run by the operator on the server, is the only way.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import time

from cad.service import db


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('email')
    parser.add_argument('--revoke', action='store_true', help='remove admin rights instead of granting them')
    args = parser.parse_args(argv)
    path = db.database_path(Path(os.environ.get('TRAIN_PROJECT_DIR', '.projects')))
    if not path.is_file():
        print(f'No database at {path}', file=sys.stderr)
        return 1
    conn = db.connect(path)
    try:
        with db.transaction(conn):
            changed = conn.execute('UPDATE users SET is_admin = ? WHERE email = ?',
                                   (0 if args.revoke else 1, args.email)).rowcount
            if changed:
                conn.execute('INSERT INTO audit_events (at, kind, user_id) SELECT ?, ?, id FROM users WHERE email = ?',
                             (int(time.time()), 'admin_revoked' if args.revoke else 'admin_granted', args.email))
    finally:
        conn.close()
    if not changed:
        print(f'No account with email {args.email}', file=sys.stderr)
        return 1
    print(f"{args.email} is {'no longer' if args.revoke else 'now'} an admin")
    return 0


if __name__ == '__main__':
    sys.exit(main())
