/**
 * Partial port of scripts/check_selection.py -- currently just
 * `loadRecentWeeks`, the one function `prepare_selection_input.ts` needs
 * (see that file's `buildRecentPicks`). The rest of check_selection.py (its
 * nine mechanical post-condition checks on a week's _selections.json) lands
 * here too when its own turn in the Tier A build order comes, rather than
 * living in a second file -- this mirrors Python's actual module structure,
 * where prepare_selection_input.py imports this same function from
 * check_selection.py despite the import direction running backwards
 * relative to the pipeline's data flow (Collection importing from a
 * Presentation-stage module). That's deliberate there, and here: Selection
 * and check_selection.ts must never be able to disagree about which weeks
 * count as "recent".
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const RECENT_WEEKS_LOOKBACK = 3;

/**
 * The `lookback` most recent week directories before `weekDir` that
 * actually contain a _selections.json, newest first.
 *
 * Counted in *directories*, not calendar weeks: data/ has real gaps (e.g.
 * a Collection-only week with no selections at all), so a date-window
 * would silently reach back further than intended whenever the data is
 * sparse. Directory names are YYYY-MM-DD, so lexicographic order is
 * chronological.
 *
 * Reads the week directories directly and must keep doing so -- it
 * deliberately does NOT read _recent_picks.json, which is a token-saving
 * convenience for Selection that can legitimately be missing or stale. Two
 * independent readers of the same source of truth is the point.
 */
export function loadRecentWeeks(weekDir: string, lookback: number = RECENT_WEEKS_LOOKBACK): unknown[] {
  const resolvedWeekDir = resolve(weekDir);
  const parent = dirname(resolvedWeekDir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return [];
  const weekDirName = basename(resolvedWeekDir);
  const prior = readdirSync(parent)
    .filter((name) => statSync(join(parent, name)).isDirectory())
    .filter((name) => name < weekDirName)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const weeks: unknown[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const path = join(parent, prior[i]!, "_selections.json");
    if (!existsSync(path) || !statSync(path).isFile()) continue; // Collection-only week, no selections to compare against
    weeks.push(JSON.parse(readFileSync(path, "utf8")));
    if (weeks.length === lookback) break;
  }
  return weeks;
}
