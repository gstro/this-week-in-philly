#!/usr/bin/env python3
"""One-time LOCAL setup tool: runs the interactive Spotify OAuth consent flow
and prints a refresh token. The Spotify counterpart to oauth_bootstrap.py,
and NOT part of the automated pipeline -- Routines and GitHub Actions have no
browser and no durable home directory (G3), so this only ever runs once, by
hand, on a real machine with a browser.

This exists because scripts/spotify_playlist.py needs to write to a *user's*
account. spotify_lookup.py's Client Credentials flow is app-only and cannot
create or modify playlists; only the Authorization Code flow can.

Usage:
    1. At developer.spotify.com/dashboard, open the same app that already
       supplies SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET. Under Settings, add
       a Redirect URI -- http://127.0.0.1:8888/callback is what this script
       defaults to. Spotify tightened its redirect-URI rules and may reject a
       bare `localhost` host in favour of the explicit 127.0.0.1 loopback
       address; the dashboard says so on save. Whatever you register must
       byte-match SPOTIFY_REDIRECT_URI everywhere it's set.
    2. Export SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (or put them in
       .env and `set -a; . ./.env; set +a`).
    3. python scripts/spotify_oauth_bootstrap.py
    4. A browser opens; log in and approve playlist access.
    5. Copy the printed refresh token into SPOTIFY_REFRESH_TOKEN in the local
       .env and as a GitHub Actions repo secret. Set SPOTIFY_REDIRECT_URI in
       both places too.

The token does not expire on its own, so this doesn't need to run again
unless access is revoked or the requested scope changes.
"""

import argparse
import os
import sys
from pathlib import Path

import spotipy
from spotipy.cache_handler import MemoryCacheHandler
from spotipy.oauth2 import SpotifyOAuth

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

DEFAULT_REDIRECT_URI = "http://127.0.0.1:8888/callback"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--redirect-uri",
        default=os.environ.get("SPOTIFY_REDIRECT_URI", DEFAULT_REDIRECT_URI),
        help=(
            "Must byte-match a Redirect URI registered on the Spotify app "
            f"(default: {DEFAULT_REDIRECT_URI})"
        ),
    )
    args = parser.parse_args()

    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (they're "
            "already in .env for spotify_lookup.py -- the same app is reused "
            "for the user flow).",
            file=sys.stderr,
        )
        sys.exit(1)

    # MemoryCacheHandler for the same reason as common.get_spotify_user_client:
    # spotipy's default would drop a `.cache` token file in the CWD. Here it
    # also keeps a *user* refresh token from silently landing on disk next to
    # the repo -- it should only ever be pasted into .env / an Actions secret.
    cache_handler = MemoryCacheHandler()
    auth_manager = SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=args.redirect_uri,
        scope=common.SPOTIFY_PLAYLIST_SCOPE,
        cache_handler=cache_handler,
        open_browser=True,
    )

    # Run the consent flow for its side effect, then read the token info back
    # out of the cache handler rather than from the return value: spotipy 2.26
    # deprecates get_access_token's dict return and will hand back a bare
    # access-token string, which has no refresh_token in it -- the one thing
    # this script exists to print.
    auth_manager.get_access_token(check_cache=False)
    token = cache_handler.get_cached_token()

    user = spotipy.Spotify(auth=token["access_token"]).current_user()

    print()
    print(f"Consent complete for Spotify user: {user['id']} ({user.get('display_name')})")
    print()
    print("Set this as SPOTIFY_REFRESH_TOKEN -- in your local .env and as a")
    print("GitHub Actions repo secret. Never commit it:")
    print()
    print(token["refresh_token"])
    print()
    print(f"Also set SPOTIFY_REDIRECT_URI={args.redirect_uri} in both places.")


if __name__ == "__main__":
    main()
