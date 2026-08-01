#!/usr/bin/env python3
"""One-time LOCAL setup tool: runs the interactive Google OAuth consent flow
and prints a refresh token. NOT part of the automated pipeline -- Routines
and GitHub Actions have no browser and no durable home directory (G3), so
this only ever runs once, by hand, on a real machine with a browser.

Usage:
    1. In Google Cloud Console (APIs & Services > Credentials): create an
       OAuth 2.0 Client ID, type "Desktop app". Download the JSON and save
       it as credentials.json in the repo root (already gitignored --
       never commit it).
    2. python scripts/oauth_bootstrap.py
    3. A browser opens; log in and approve Calendar access.
    4. Copy the printed refresh token into GOOGLE_REFRESH_TOKEN wherever it's
       needed: a local .env for testing scripts, the Collection Routine's
       environment, and a GitHub Actions repo secret. GOOGLE_CLIENT_ID and
       GOOGLE_CLIENT_SECRET come from the same credentials.json.
    5. Delete credentials.json when done -- this script doesn't need to run
       again unless the refresh token is revoked.
"""

import argparse
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--credentials",
        type=Path,
        default=Path("credentials.json"),
        help="OAuth client secret file downloaded from Google Cloud Console",
    )
    args = parser.parse_args()

    if not args.credentials.exists():
        print(
            f"{args.credentials} not found. Download it from Google Cloud "
            "Console (APIs & Services > Credentials > OAuth 2.0 Client IDs, "
            "type: Desktop app) first.",
            file=sys.stderr,
        )
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(
        str(args.credentials), scopes=common.CALENDAR_SCOPES
    )
    creds = flow.run_local_server(port=0)

    print()
    print("Consent complete. Set this as GOOGLE_REFRESH_TOKEN -- in your local")
    print(".env, the Collection Routine's environment, and a GitHub Actions")
    print("repo secret. Never commit it:")
    print()
    print(creds.refresh_token)
    print()
    print(
        f"(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET should match {args.credentials}.)"
    )


if __name__ == "__main__":
    main()
