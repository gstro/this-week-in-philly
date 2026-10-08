# Real page captures (2026-10-07)

Full, unmodified HTML responses from the seven HTML sources, fetched on
2026-10-07 with `scripts/fetch_raw.py` (the same client Collection uses, but
without its 200,000-character cap). They're gzipped (`gzip -9n`) because the
Lightbox pages are ~900 KB each of Wix markup; read them with
`gzip.decompress` / `zlib.gunzipSync`.

`_sources.json` maps each file to the URL it came from. The Rotunda is captured
for both October and November 2026 (its grid is per month); Lightbox is its
homepage index plus every detail page that index linked to.

`expected/` is what the Python parsers (`scripts/event_parsers/`) extracted
from these pages on the same day, using the window 2026-10-01 to 2026-12-31
(the Rotunda with `context_date` set to the first of its month; Lightbox's
index via `parse_index`, and its detail pages fed to `parse` the way
`collect_source.collect_lightbox` builds them). The TypeScript parsers are
checked against these as "same events", not byte-for-byte; any intentional
difference is listed in that parser's "Divergences from the Python".

These pages go stale as the sites change. To refresh, re-fetch every URL in
`_sources.json` (for Lightbox, re-run `parse_index` on the new homepage, since
its detail links change), regenerate `expected/` from the Python parsers while
they still exist, and update the date above.
