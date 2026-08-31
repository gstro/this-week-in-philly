# Selection Improvements — Brainstorm

## Context

`personal-interests` and `event-selection-philosophy` are the entire judgment layer of the
pipeline. Everything else — 29 source parsers, `prepare_selection_input.py`, `html_render.py`,
`calendar_create.py` — is mechanical. These two files are what decide whether the report is
*good*.

They are also the least-maintained files in the repo:

| File | Lines | Edits since v1 import |
|---|---|---|
| `.claude/skills/philadelphia-sources/SKILL.md` | 589 | many (recalibration, parser fixes, source drops) |
| `.claude/skills/philly-events-selection/SKILL.md` | 235 | several |
| `.claude/skills/event-selection-philosophy/SKILL.md` | **43** | **0 — content never edited** |
| `.claude/skills/personal-interests/SKILL.md` | **23** | **0 — content never edited** |

`git log` confirms both were added in `cbb406d`, path-renamed in `9cb35e5`, copied to
`.claude/skills/` in `5bb6018`, and never touched again. Every recalibration commit in this
repo's history went to collection.

The reason is structural and worth naming, because it shapes the whole list below: **collection
failures are loud** (0 events, HTTP 429, `check_yield.py` fails the build) while **judgment
failures are silent** — a mediocre Top 3 pick renders exactly like a great one.

Evidence base for everything below: `data/2026-08-03/` (561 candidates, 21 Top 3 picks),
`data/2026-08-10/` (570 candidates, 21 picks — the week that ran after this brainstorm was
drafted, used as a holdout check), `data/2026-06-22/_selections.json`, and
`docs/v1/Data/event-picks-log.csv` (164 rows, 17 weeks). Both skill files remain untouched
since `5bb6018`, so 08-10 is a second independent sample of the same judgment layer.

---

## What the evidence actually shows

Findings that drive the proposals. Each is reproducible from the files in the repo.

**1. Venue Elevation is behaving as a whitelist, not a tiebreak.**
11 of 21 Top 3 slots went to three venues. Iffy Books supplied **9 of 561 candidates (1.6%)** and
won **5 of 21 slots (24%)**. Wooden Shoe supplied 4 candidates and won 3 slots — a 75% hit rate.
The philosophy says "Elevate events at these venues **when breaking ties**." That is not what is
happening.

**2. Half the Venue Elevation list is unreachable.**
Candidates matching each elevated venue in the 2026-08-03 pool:

| Venue | Candidates |
|---|---|
| PhilaMOCA | 17 |
| Iffy Books | 9 |
| Wooden Shoe Books | 4 |
| The Rotunda | 1 |
| **Harriet's Bookshop** | **0** |
| **First Unitarian Church** | **0** |
| **Lightbox Film Center** | **0** |
| **Hive76** (recurring-deprioritize list) | **0** |

Four of the eight venues named across the philosophy's two lists produced nothing. `free-library`,
`harriets-bookshop`, and `hive76` have no source file in the 08-03 run at all. The tie-break list
and the deprioritize list are both partly addressed to venues Collection cannot see.

**3. Near-duplicate series evade the recurring rule.**
Thursday #1 = "Beginner Soldering: Li-Ion Battery Pack" @ Iffy Books.
Friday #3 = "Beginner Soldering: LED Spinning Top" @ Iffy Books.
Same venue, same series, same beginner level, back-to-back days, two of 21 slots.
`prepare_selection_input.py`'s `recurrence_count` only collapses **identical title + venue on 3+
dates**, so a series with varying titles is invisible to it, and the philosophy has no
same-series rule of its own.

**4. A prior defect in `time` handling has already been fixed — noted for context, not as a live
problem.** `archive/2026-08-03-manual-run/_selections.json` (a manual pipeline test superseded by
the real cron run) has 5 of 21 picks with unparseable `time` values (`"7:00, 7:30"`,
`"6:00 PM (doors), 7:00 PM (show)"`, a range) — each of those silently loses its calendar entry in
`calendar_create.py`. Commit `9bbd592` ("Selection skill: time must be a single clean start time")
fixed this before the real 2026-08-03 run; the live `data/2026-08-03/_selections.json` has **0**
unparseable times across all 21 picks. Included because it is a real instance of a judgment failure
that shipped silently until someone happened to check the calendar — the same failure mode D2 below
proposes guarding against generally.

**5. The `cost` field has become a prose scratchpad with invented values.**
Real strings written to a structured field this week:

- `"$3.99–$4.31 for the battery pack kit, plus a notaflof ($0–$30 suggested) instructor donation"` (90 chars)
- `"Free (typical for NLG trainings; not listed on page)"`
- `"~$12–14 (standard PFS ticket price; not listed)"`
- `"Free (typical for Wooden Shoe programming)"`
- `"Free (confirm details — listing shows \"$15\", likely a scrape of the $15M renovation cost rather than an admission fee)"`

Three of these are **inferred prices presented as data**. The last one is good reasoning in the
wrong field. The philosophy's `*(confirm details)*` convention is scoped only to "events with no
verifiable source"; nothing governs cost fidelity.

**6. Three selection-time rules live in `events-report-format` and are being missed.**
That skill is loaded at *render* time, after judgment is done:

- *"include neighborhood/SEPTA access for venues outside Center City"* — **1 of 21** blurbs
  contains an actual transit or access term. Missed for The Dell Music Center (Strawberry Mansion,
  ~5 mi out), Spruce Street Harbor, Liberty Point, Cobbs Creek Rec Center, Philadelphia Ethical
  Society. (Several picks name their neighborhood incidentally via the venue name, but that is not
  access guidance.)
- *"Online events are excluded from Top 3 unless exceptional"* — 9 online candidates in the pool;
  neither judgment skill mentions the rule.
- *"Verification Before Finalizing Top 3: search `[event] Philadelphia [date] postponed`"* — a
  selection-time obligation filed under output formatting.

**7. Nothing tells Selection to distrust its inputs.**
Do215 supplied **440 of 561 candidates (78%)** and its data is visibly dirty:
`"Food: Philly Cinco de Mayo Food Truck"` dated **Aug 6**; `"$5 Nitro Cocktails in the Yard"` at
**12:00 AM**; a `"$15"` cost scraped from a `$15M` renovation figure; `Babalouie BBQ` and
`EF: Babalouie BBQ` as separate candidates. The 06-22 week has a punk show listed at 7:00 AM.
Selection caught the `$15M` one by luck; there is no checklist that would make catching it routine.

**8. Three of nine canonical categories got zero slots** — 🎨 Arts & Workshops, 🌿 Markets &
Outdoors, 🎪 Festivals & Major Events. Category spread of the 21 picks: Literary 4, Tech & Maker 4,
Community & Politics 4, Music 4, Film 3, Horror & Occult 2.

**9. Output homogeneity suggests template-following, not judgment.**
All 21 `why` blurbs are 3–4 sentences and 387–563 characters — every one at the spec's stated
maximum. Every one of the 7 days has exactly 3 honorable mentions, though `events-report-format`
says "2–3 max… omit entirely if nothing came close." Exactly 3 every day for 7 days reads as
quota-filling.

**10. The feedback loop is dead — noted, not built on (per Greg's call).**
Of 164 picks-log rows: **4 `attended=true`**, 58 `false`, 71 blank (including all 38 rows of the
most recent week), and **31 rows where tag values landed in the `attended` column** — weeks
2026-06-15→06-21 used comma-delimited unquoted tags, so 2-tag rows split into an extra field.
Separately, `common.picks_log_path()` resolves to `data/event-picks-log.csv`, which **does not
exist**; the only real log is the v1 file, last updated 2026-07-06. `runner.sh` deliberately does
not run `attendance_check.py` or `csv_log.py`.
**Consequence for this work:** no proposal below may depend on attendance data. The 4 `true` rows
are usable as anecdote, not as calibration.

---

## Holdout check: the 2026-08-10 week

That week ran after this document was first drafted, with both skill files unchanged. It is the
closest thing to a second sample. Some findings held, some did not, and the priority order below
is adjusted accordingly.

**First, a confound to state up front.** Between the two weeks Selection was refactored
(`a38fec2` token-optimization, `8fec1ec` single-session / no subagent fan-out). It now writes
`_selection_annotations.json` — only `id, rank, time, category, address, is_music, sold_out, why` —
and `scripts/merge_selections.py` fills `title, venue, cost, url, source` from the candidate record.
So Selection's authored surface shrank, and any behavioral difference between the weeks may be the
refactor rather than judgment drift. Findings are labeled below accordingly.

**Held — structural, and independent of the refactor:**

- **Venue concentration (#1).** The top four venues took **9 of 21 slots**. Two weeks, same shape.
- **Unreachable venues (#2).** Harriet's Bookshop, First Unitarian, Lightbox, and Hive76 produced
  **zero candidates for a second consecutive week**. Four of eight named venues are dead entries.
  This is the cleanest finding in the document.
- **Aggregator dominance (#7).** Do215 was **436 of 570 (76%)**, essentially unchanged.
- **Category gaps (#8).** 🎨 Arts & Workshops, 🌿 Markets & Outdoors, and 🎪 Festivals took **zero
  slots again**. Same three, two weeks running.
- **Uniform honorable mentions (#9, partly).** Exactly **2** per day for all 7 days. The count
  changed; the mechanical uniformity did not.

**Held, but the explanation needs revising.** On 08-03 the concentration was entirely in
Venue-Elevation-listed venues, which is why finding #1 reads as "the tiebreak is acting as a
whitelist." On 08-10 the single largest concentrator is **Philadelphia Film Society — 3 slots, all
three at 1412 Chestnut St, and not on the elevation list at all**. The elevated three (PhilaMOCA,
Iffy, Wooden Shoe) took 6 more, so 9 of 21 sit in four rooms. That points at a broader cause than
the elevation list: with no stated ranking axis in `personal-interests`, the model clusters on
whatever venue it has learned to trust. **C1's per-venue cap is still the right fix — and it now
matters more, because it is the only proposal that bounds a non-elevated venue too.** But C3
(demote elevation to a true tiebreak) can no longer be sold as the whole answer, and B1/A2 —
giving the model a real ranking axis so it stops proxying quality through venue — rise in
importance.

**Did not recur, or was never a skill problem:**

- **Invented cost strings (#5) — now structurally impossible.** Selection no longer emits `cost`
  at all; `merge_selections.py:138,211` copies `candidate.get("cost", "")`. The refactor killed
  this failure mode, not the prose. Correspondingly, **13 of 21 blank costs on 08-10 vs 0 on
  08-03 is not a judgment regression** — it is source data with no price, faithfully passed
  through, where previously Selection filled the gap by inventing. The blank is a rendering
  question (a `"Not listed"` default in the merge or the template), **not a skill edit**. C7 is
  rescoped accordingly and drops out of the first tranche.
- **Blurb homogeneity (#9, partly).** Lengths were 219–390 chars vs 387–563. Changed; cause
  unattributed — the single-session refactor is at least as likely an explanation as improved
  judgment. C17 drops in priority but is not retired on one confounded sample.
- **`time` parsing (#4).** 0 of 21 unparseable. `time` **is** still Selection-authored, so
  `9bbd592`'s rule is holding on its own and D2's guard remains a live regression test.

**Net effect on priorities:** cost drops out of the skill work entirely; venue concentration and
the dead lists move to first; B1/A2 gain weight as the root-cause fix rather than a nicety.

**Consequence for D2:** `check_selection.py` must run **after** `merge_selections.py` — before the
merge, `title`, `venue`, and `cost` do not exist to check.

---

## The food / market / coffee / whiskey question

**2026-08-03 supply:**

**Markets (3)** — After Hours Farmers Market @ Star|Bolt (Tue 5pm) · Harvest Crown Flower Bar @
Cherry Street Pier ($23–39) · **Farmers Market @ Clark Park (Sat 10am)**

**Food (7 real, after collapsing a dedupe miss)** — Babalouie BBQ @ Wissahickon Brewing ·
Pizza Night @ Buttonwood Grill, *Peddler's Village* · **Shells of Liberty Oyster Bash @
Carpenter's Hall (Wed 5:30pm)** · Philly Cinco de Mayo Food Truck @ Pentridge Station *(dated Aug 6
— bad data)* · Shanté Chefé @ MilkBoy ($15–20, 21+) · Roosters & Deke's BBQ @ Wissahickon Brewing

**Drink (5)** — **Agave Spirits: The Past, Present, and Future of Mezcals @ Penn Museum (Tue 3:30pm)** ·
Courtside & Cocktails @ Ballers ($23–$215) · $5 Nitro Cocktails @ South Bowl *(12:00 AM)* ·
Stop and Smell The Rosé Rooftop Wine Festival @ Sunset Social · Throwback Cookout @ XOX Beer Garden ($28–66)

**Coffee (2)** — ☕️ Coffee Talk @ Iffy Books (Mon 6pm, *demoted to honorable mention*) ·
OG Coffee&Code *(online)*

Real in count but thin in quality — mostly commercial venue promos (nitro cocktail specials,
brewery food trucks, a $215 courtside package), one item outside Philadelphia entirely (Peddler's
Village is in Lahaska, Bucks County), and one with corrupt data.

**2026-08-10 holdout supply**, pulled as a second sample: **Farmers Market @ Clark Park** again
(the only market; a stable weekly anchor two weeks running) · **Amada's Annual Summer Cava y
Cochinillo Event** (signature cava + suckling pig event) · **Milk Jawn — Levain Cookie Cart Pop-Up**
· **Bacardi Rum Tasting @ Cuba Libre Restaurant & Rum Bar** · a run of **drag brunches** at various
clubs, ranging from small-venue shows to a $55–$567 bottle-service "spectacular show" · five
separate brewery food-truck promos at Wissahickon Brewing · the usual quizzo/trivia noise. None of
the good items — Clark Park, the rum tasting, the cava event, the cookie pop-up — were picked, not
even as honorable mentions, in either week.

**Where the first-draft carve-out broke.** The original proposal was: a *talk, tasting, or
institution-run market* is Top-3-eligible, a *venue drink special* is not. Tested against 08-10,
that rule **admits the Bacardi Rum Tasting and excludes drag brunch** — backwards. Greg's
correction: the rum tasting is corporate, brand-driven, sales pressure; drag brunch is unique and
subversive. **Format was the wrong axis.** A liquor brand's promotional tasting and a museum
lecture are both "a tasting/talk" by format, but one exists to sell product and the other doesn't
— and a recurring commercial-venue drag show can be more genuinely distinctive than either. The
real line is **content orientation: brand-sponsored/sales-oriented vs. subversive, countercultural,
or community-distinct** — independent of whether it's called a tasting, a brunch, or a market.

**Resolved recommendation** (implemented as B3/B4 below): still split by context — full weight for
restaurant/shop discovery, flavor weight for the weekly event report — carved out by orientation,
not format:
- **Hard no**, regardless of format: content whose organizing purpose is selling a brand or
  product — spirits/wine-brand tastings, VIP club pickup parties, "presented by [sponsor]" promos,
  luxury/bottle-service packaging (the $215 courtside package, the $567 "spectacular show" drag
  brunch at a bottle-service club). Corporate sponsorship, not format, is the tell.
- **Positive signal**, regardless of format: subversive, countercultural, or community-distinct
  content — drag/queer nightlife, DIY food or craft pop-ups, punk-adjacent food culture — even
  hosted at a commercial venue on a recurring schedule, subject to C1's per-venue cap so it doesn't
  crowd out everything else.
- **Neutral, stays low**: routine commercial programming with no distinguishing angle — brewery
  food trucks, generic quizzo/trivia, standard brunch specials.

One nuance worth naming rather than papering over: not every drag brunch on the list is the same —
"Drag Brunch: Sunday's Most Spectacular Show," $55–$567 at a bottle-service club, reads closer to
luxury spectacle than subversion. The rule above catches that on the sponsorship/price-tier signal,
not by treating "drag brunch" as a blanket yes. The three items from 08-03 that read as defensible
under the *old* rule — the Penn Museum mezcal talk, the Carpenter's Hall oyster bash, Clark Park
Farmers Market — still pass under the *new* one; none of them are brand promotions.

---

## The brainstorm

Cost tags: **[N]** schema-neutral (prose edits only) · **[S]** touches `_selections.json` or
`scripts/` · **[X]** cross-cutting (canonical strings, multiple files).

### A. Structure and division of labor

**A1 · Give `personal-interests` a stated purpose that matches its description. [N]**
The frontmatter claims general-purpose use (restaurants, record stores, content curation), but the
body opens with `"Rank candidates higher when they touch any of the following"` — an event-ranking
imperative. *Rationale:* the file is doing two jobs badly. Split it into a durable **taste profile**
(facts about Greg that are true regardless of task) and let ranking verbs live only in the
philosophy. This also stops future event-ranking machinery from migrating into the profile.

**A2 · Add explicit interest tiers. [N]**
Fourteen bullets, flat, unordered — "Bees" carries the same nominal weight as "Film." *Rationale:*
a flat list gives Sonnet no way to resolve a bee-keeping workshop against a repertory screening,
so it falls back on the philosophy's venue list, which is finding #1. Proposed tiers: **Core**
(film, punk/hardcore, leftist politics, horror/occult, literature) · **Strong** (DIY electronics,
soul/jazz/gospel, software) · **Flavor** (coffee, cuisine, pastries, whiskey, bees, independent art)
— where Flavor is tie-break and honorable-mention material.

**A3 · Add per-context weights. [N]**
Same interest, different weight depending on task: coffee ranks high for shop discovery and low for
event picks. *Rationale:* this is the honest resolution of finding #8 and the food/market question
above, and it preserves the file's advertised general-purpose value instead of quietly narrowing it
to events.

**A4 · Fix the dangling cross-reference. [N]**
The description points at `event-selection-philosophy.md`; the actual target is
`event-selection-philosophy/SKILL.md`. *Rationale:* trivial, but it is a literal path that does not
resolve from either tree.

**A5 · Decide the fate of the `docs/v1/Skills/` twins. [X]**
Both files are byte-identical to the live `.claude/skills/` copies today. `philadelphia-sources` has
already drifted (680 vs 589 lines). *Rationale:* the moment you edit the live philosophy, the v1
copy silently becomes a second, wrong source of truth for anyone reading `docs/v1/`. Either add a
one-line "frozen v1 snapshot, see `.claude/skills/` for current" banner or delete them.

**A6 · Note the knowledge duplicated into code. [X]**
`scripts/prepare_selection_input.py` hardcodes venue/recurrence knowledge that also lives in the
philosophy, and `data/expected_yield.json` encodes per-source floors. *Rationale:* editing the
philosophy's venue lists will not propagate; the plan should say so out loud so the divergence is
deliberate.

### B. `personal-interests` — content

**B1 · Add anti-preferences / hard nos. [N]** ← *highest leverage in this file*
The profile currently has **no negative space at all**. With Do215 at 78% of the pool, the model is
wading through trivia nights, bar specials, brunch promos, cover bands, sports watch parties, and
$215 courtside packages with no stated basis for rejecting any of them. Include **brand-sponsored
or sales-oriented content generally** (spirits/wine-brand tastings, "presented by [sponsor]"
promos, VIP club pickups, luxury/bottle-service packaging) as a named no — not just as a food/drink
carve-out under B3, since the same corporate-activation pattern can show up anywhere the profile is
thin (a sponsored film screening, a brand-run "maker" event). *Rationale:* a taste profile
without hard nos forces the model to infer dislikes from the absence of likes, which is exactly the
failure that pushes it back onto the venue whitelist. The sponsorship distinction was surfaced by a
direct correction (see B3/B15) and generalizes past food and drink.

**B2 · Add named-entity anchors. [N]** ← *highest-leverage add overall*
No artists, labels, directors, authors, or publishers are named anywhere. *Rationale:* category
words ("punk," "film") match thousands of candidates; proper nouns discriminate. The picks log
already supplies real ones — Béla Tarr, Saetia (an `attended=true` row), Sun Ra, Le Guin, the AACM,
Czech New Wave, screamo, free jazz, Wooden Shoe's political-ed line. Anchors let Sonnet recognize a
Touki Bouki or a Sun Ra documentary as core, not as generic "film."

**B3 · Reclassify food / coffee / whiskey / markets by context and orientation, not format. [N]**
Full weight for discovery curation, flavor weight for events, with a carve-out keyed on
**brand-sponsored/sales-oriented vs. subversive/countercultural/community-distinct** — not on
whether the event is a tasting, a talk, or a brunch. *Rationale:* addresses finding #7 without the
failure mode the 08-10 holdout exposed: a format-based rule (talk/tasting = yes, venue special =
no) admits a liquor brand's promotional tasting and excludes a drag brunch, which is backwards for
what Greg actually values. Sponsorship and price-tier are better tells than format.

**B4 · Name subversive / countercultural nightlife as an explicit interest. [N]** *(surfaced by
the 08-10 holdout)*
Drag and queer nightlife are not named anywhere in the current profile, yet a direct correction
from Greg ranked drag brunch above a corporate spirits tasting on exactly the axis the punk/DIY
bullet already gestures at (subversive, community, anti-corporate) without saying so explicitly.
*Rationale:* this is the same underlying value as B1's hard-nos and the punk bullet — reward
countercultural/DIY framing, penalize brand-sponsorship — but it was invisible until tested against
real candidates. Naming it directly (rather than leaving it to be inferred from "punk/hardcore")
prevents the same mis-carve-out from recurring elsewhere the profile is thin: film, art, literature
could all have a corporate-sponsored-activation version worth excluding on the same grounds.

**B5 · Name the high-value interest intersections explicitly. [N]**
The philosophy rewards "multi-interest overlap" abstractly. The profile should name the specific
intersections that actually win: film × horror × repertory (PhilaMOCA's whole line), politics ×
literature × independent bookstore (Wooden Shoe), punk × benefit × all-ages (the Saetia and Break
Free Fest `true` rows), electronics × DIY × leftist (Iffy). *Rationale:* concrete conjunctions are
checkable; "multi-interest overlap" is not.

**B6 · Encode benefit / fundraiser / community-stakes as a first-class signal. [N]**
Three of the four `attended=true` rows are benefit or community-stakes shows. `events-report-format`
already requires naming the beneficiary for R5 fundraisers, but neither judgment file says
benefits matter. *Rationale:* the strongest signal in the only ground truth that exists, currently
unencoded.

**B7 · Add temporal shape. [N]**
Nothing states weeknight vs weekend energy or daytime availability. This week produced a Wednesday
**10:30 AM** #3 pick and a Thursday **2:30 PM** #1 pick. *Rationale:* if weekday-daytime picks are
unattendable, three slots this week were wasted; if they are fine, the profile should say so so the
model stops hedging.

**B8 · Add geography / travel radius. [N]**
No home neighborhood, no radius, no transit constraint anywhere in either file. The pool contained
Peddler's Village (Bucks County, ~40 min drive, outside Philadelphia); picks spanned Cobbs Creek to
Northwest Regional Library to Penn's Landing. *Rationale:* also the missing precondition for the
SEPTA-note rule in finding #6 — the model cannot flag "outside Center City" without knowing where
the center is.

**B9 · Add a price model. [N]**
"cheap or free preferred" appears only inside the punk bullet. *Rationale:* free/PWYW is clearly
weighted in practice (11 of 21 picks are free or PWYW) but that weight is nowhere stated, so it is
being applied by vibe. State a soft ceiling and when to break it.

**B10 · Add participatory vs. spectator preference. [N]**
Iffy Books workshops (5 slots this week) are hands-on; screenings and shows are not. *Rationale:*
this single axis explains a large share of the Iffy saturation, and the profile is silent on it.

**B11 · Add solo vs. social context. [N]**
Reading groups, meetups, and canvasses have different social overhead than a screening.
*Rationale:* affects real attendance, which is the thing the report is optimizing.

**B12 · Add a novelty-vs-comfort statement. [N]**
How much repetition is welcome? *Rationale:* the profile should state the intent that C1's numeric
cap enforces, so the cap reads as principle rather than as an arbitrary constant.

**B13 · Note recurring annual anchors. [N]**
Break Free Fest appears in an `attended=true` row. *Rationale:* seasonal fixtures deserve
recognition rather than rediscovery each year.

**B14 · Reconsider the archival framing on soul/jazz/gospel. [N]**
The bullet reads as repertory-and-reissue-only, yet The Isley Brothers (a living legacy act at a
large venue) took a Top 3 slot. *Rationale:* either the bullet or the pick is wrong; the file should
resolve it.

**B15 · Add a maintenance/staleness clause. [N]**
*Rationale:* four months of production with zero edits is the root cause of this whole document.
State what should trigger a revision (a category with no picks for N weeks; a venue saturating; a
new source landing).

### C. `event-selection-philosophy` — content

**C1 · Cap venue repetition per week. [N]**
Max ~2 Top 3 slots per venue per week, where "venue" means **same `address`** (see the
prerequisite note in the tranche section — raw venue strings are not normalized and a
string-keyed cap will not fire). *Rationale:* bounds the Iffy×5 / PhilaMOCA×3 / Wooden Shoe×3
concentration on 08-03 *and* the PFS×3 concentration on 08-10, which no other proposal touches
because PFS is on neither the elevation list nor the deprioritize list. Cheap to state, and
mechanically verifiable (D2/D3) once the key is fixed.

**C2 · Add a same-series rule that does not rely on `recurrence_count`. [N]**
No two Top 3 picks from the same series, format, or organizer-run program in one week, regardless
of title. *Rationale:* the two Beginner Soldering workshops (finding #3) are invisible to the
mechanical collapser and to every rule currently written.

**C3 · Demote Venue Elevation to a genuine last-resort tiebreak, and say what that means. [N]**
State that elevation may only decide between candidates already judged equal on merit — it may never
lift a weaker event over a stronger one. *Rationale:* the current wording already says "when
breaking ties" and is being over-applied anyway, so the fix is to make the constraint operational
rather than adjectival.

**C4 · Prune or annotate the unreachable venues. [N]**
Harriet's Bookshop, First Unitarian, Lightbox, and Hive76 produced zero candidates (finding #2).
*Rationale:* either re-enable those sources or mark the entries "elevate if present — source
currently not collected," so the list stops implying coverage that does not exist. Harriet's has no
source file at all.

**C5 · Refresh the recurring-deprioritize list. [N]**
The Rotunda contributed exactly 1 candidate this week; Hive76 contributed none. *Rationale:* the
list is calibrated against a v1 source set that no longer matches reality.

**C6 · Establish explicit tie-break precedence. [N]**
The file lists Prioritize 1/2/3, Also Include, Avoid, and Venue Elevation, but never says what
outranks what. *Rationale:* with no stated ordering, the model picks its own — and the observed
choice is venue-first, which is finding #1. Proposed order: interest-tier alignment → uniqueness /
easy-to-miss → community stakes → multi-interest overlap → free/PWYW → venue elevation.

**C7 · ~~Cost-fidelity rules~~ — mostly obsolete; what remains is a script fix. [S]**
*Superseded by the `a38fec2` refactor.* Selection no longer writes `cost`;
`merge_selections.py:138,211` copies it from the candidate. The three invented prices in finding #5
cannot recur through this path, so **no skill edit is warranted**. What is left is real but
mechanical: 13 of 21 costs on 08-10 render as an empty string. Fix by defaulting to `"Not listed"`
in `merge_selections.py` or the Jinja template. *Rationale:* recording this explicitly so the
finding is not "fixed" twice — once correctly in code and once uselessly in prose. The judgment-side
survivor of finding #5 is C18, which governs price claims in the `why` prose, and that is still
live because `why` is still Selection's.

**C8 · Add a data-plausibility checklist. [N]**
Flag and re-derive: a 7:00 AM or 12:00 AM start; a holiday name that does not match the date; a cost
that looks like a budget figure; a venue outside Philadelphia; near-identical titles differing only
by a prefix. *Rationale:* finding #7 — every one of these is a real defect from a real week, and the
`$15M` catch currently depends on luck rather than procedure.

**C9 · Define "large corporate venue." [N]**
The Avoid rule names no venues. The Dell Music Center took a #3 slot this week — under the current
text it is impossible to say whether that was a violation or the "truly unmissable" exception.
*Rationale:* an unenforceable rule is worse than no rule; name the venues and name the exception
bar.

**C10 · Relocate the online-events exclusion. [N]**
Currently only in `events-report-format`; 9 online candidates were in the pool. *Rationale:* it is a
selection decision, and the skill that makes selections never sees it.

**C11 · Relocate the pre-finalization verification rule. [N]**
The "search `[event] Philadelphia [date] postponed`" step is filed under output formatting.
*Rationale:* same — it gates a Top 3 pick, so it belongs where picks are made.

**C12 · Relocate and enforce the neighborhood/SEPTA access note. [N]**
Honored in 4 of 21 blurbs. *Rationale:* finding #6; depends on B8 establishing a center of gravity.

**C13 · State how `sold_out` affects ranking. [N]**
The schema carries the flag and the selection task says "still include if worth attending," but the
philosophy — which owns ranking — is silent. *Rationale:* a sold-out event occupying a Top 3 slot
and a calendar entry is a real judgment call that no rule currently governs.

**C14 · State how all-ages / 21+ affects ranking. [N]**
`personal-interests` mentions all-ages for punk; the philosophy never uses it. The pool contained
21+ events. *Rationale:* cheap, and it is already half-stated.

**C15 · Replace "events that would be talked about afterward." [N]**
*Rationale:* unfalsifiable; it justifies any pick and excludes none.

**C16 · Add a real thinness rule. [N]**
The selection task says "fewer than 3 qualifying events is acceptable," yet both weeks on record
produced exactly 3 picks and exactly 3 honorable mentions for all 7 days — including the 06-22 week
with as few as 6 candidates on a day. *Rationale:* finding #9. State what a day with nothing worth
recommending should look like, and give the model explicit permission to ship 2, or 1.

**C17 · Add anti-formula guidance for `why` blurbs. [N]** *(lowered priority after the holdout week)*
On 08-03 all 21 blurbs were 3–4 sentences at 387–563 characters — the spec's three-part shape
(what / why-now / practical) executed as a template. On 08-10 they ranged 219–390, which is real
variation, so this is less acute than it looked. *Rationale:* the blurbs are the only
prose in the entire pipeline and the main reason Selection still runs on Sonnet; uniform output is
the one failure mode that wastes that spend. Permit 2 sentences, set a soft ceiling, and name a few
tic constructions to avoid — the 06-22 week has *"which is already a meaningful signal about what
kind of film this is,"* the sort of venue-implies-quality hedge that fills space without informing.

**C18 · Add an explicit no-fabrication rule for blurb claims. [N]**
*Rationale:* "typical for Wooden Shoe programming" and "standard PFS ticket price" are inferences
rendered as fact in a published report.

**C19 · Add soft category-coverage guidance. [N]**
*Rationale:* finding #8 — three of nine categories at zero, two weeks running. Now that B3/B4 give
the profile a real basis for admitting food/market/drink/nightlife content, this becomes a light
"prefer spread when merit is close" nudge rather than a quota.

**C20 · Say something about aggregator provenance. [N]**
Do215 is 76–78% of the pool and the origin of nearly every dirty record. *Rationale:* a stated
default — aggregator-only listings for commercial venue promotions are low-signal absent
corroboration — would let the model discount an entire class of noise cheaply.

**C21 · Add worked good-pick / bad-pick examples from real weeks. [N]**
*Rationale:* the file is 43 lines of abstract rules with one parenthetical example. For a task
running on Sonnet, two or three grounded contrasts (the Saetia benefit vs. the nitro cocktail
special; the Bacardi rum tasting vs. a drag brunch) will outperform another paragraph of rules.

**C22 · Note cross-week anti-repetition as a deferred option. [N]**
Per-week cap (C1) is the chosen fix over cross-week memory. Recording why: the only cross-week store
is the picks log, which is broken and unwired (finding #10). *Rationale:* worth revisiting if and
when the log is repaired — "Coffee Talk @ Iffy Books" was a rank-2 pick on 2026-07-06 and
reappeared in the 08-03 pool, so the pattern is real.

### D. Making judgment failures observable

This bucket exists because of the framing at the top: collection failures fail the build, judgment
failures ship silently.

*Scope note: D1 and D3 are edits to skill prose. **D2 and D4 are not** — they are a new script and
a new test fixture, included because the central problem with these two files is that nothing
tells you when they are drifting, and no amount of prose fixes that. Treat them as supporting
infrastructure, separable from the rest.*

**D1 · Add a self-check block to the end of the Selection task. [N]**
Have Selection print its own venue / category / source histograms, the count of `*(confirm details)*`
flags, and the count of cost fields over 40 characters. *Rationale:* zero infrastructure, and it
surfaces "Iffy Books: 5" at authoring time, when the model can still act on it.

**D2 · Add `scripts/check_selection.py`, modeled on `check_yield.py`. [S]**
Runs **after `merge_selections.py`** — before the merge, `title`/`venue`/`cost` do not exist.
Deterministic post-conditions: no `address` over the C1 cap; no empty `cost` (should be
`"Not listed"`); every pick outside the B8 radius carries an access note; a
**regression guard** for the `time` defect fixed in `9bbd592` (single `%I:%M %p`, no ranges or
doors/show pairs — currently enforced only by skill prose); category histogram emitted.
*Rationale:* this is the real structural fix — it converts silent judgment drift into a loud CI
failure, exactly as `check_yield.py` did for collection. The `time` case is the proof it works:
that defect was caught by hand, and nothing today would catch its recurrence.

**D3 · Emit a `_selection_notes.md` sidecar. [N]**
Runners-up per day and one line on why each lost. Not consumed by any script, so it does not touch
the `_selections.json` contract. *Rationale:* makes near-misses reviewable, and gives future
philosophy edits something to diff against besides the winners.

**D4 · Add a selection golden week. [S]**
`tests/golden/` already holds a rendered-HTML golden for 2026-06-22. *Rationale:* a companion
selection golden would let a philosophy edit be evaluated by re-running Selection against a frozen
`_candidates.json` and diffing the picks — the only way to tell whether a rule change helped.

---

## Recommended first tranche

Ordered, reweighted after the holdout week. All schema-neutral except D2, all independently
shippable.

**Prerequisite for C1 — define what counts as "a venue."** Venue strings are not normalized:
`"Iffy Books, 404 S. 20th St., Philadelphia, 19146, United States"` vs `"PhilaMOCA, Philadelphia,
PA"`, and on 08-03 `"Ortlieb's, Philadelphia, PA"` vs `"Ortlieb's"`. A cap stated against raw
strings will silently fail to fire, in the skill and in D2 alike. Use **`address`** as the key —
Selection already authors it, and it is what proves the three PFS screenings share one room
(1412 Chestnut St). Fall back to a normalized venue prefix when `address` is absent. Settle this
before C1 ships.

1. **C1 + C2 + C4 + C5** — venue cap (keyed on `address`), same-series rule, and prune the dead
   venue/recurring lists. *The concentration reproduced in both weeks: 9 of 21 slots in four rooms
   on 08-10, while four of the eight named venues produced zero candidates twice running. C4/C5 are
   nearly free and stop the file from asserting coverage that does not exist.*
2. **B1 + A2** — hard nos and interest tiers. *Promoted: with PFS — an unelevated venue — as
   08-10's top concentrator, the root cause reads less like a bad tiebreak rule and more like the
   model having no ranking axis and proxying quality through venue. This is the fix for that.*
3. **C6** — explicit tie-break precedence. *Makes 1 and 2 enforceable rather than aspirational.*
4. **B2 + B5** — named-entity anchors and named interest intersections. *The concrete half of 2;
   highest-leverage single addition to the taste profile.*
5. **B3 + B4** — reclassify food/drink/market by orientation, and name subversive/countercultural
   nightlife directly. *Resolved: replaces the earlier format-based carve-out with the
   sponsorship/price-tier-based one, per Greg's correction above.*
6. **C8 + C18 + C20** — data-plausibility checklist, no fabricated claims in `why`, and an
   aggregator-provenance default. *Do215 held at 76% of the pool. C18 is the surviving
   judgment-side half of the cost finding.*
7. **C10 + C11 + C12** — relocate the three orphaned selection-time rules out of
   `events-report-format`.
8. **D1**, then **D2**. *Start with the free self-check; graduate to CI enforcement once the new
   rules have settled. D2 must be wired after `merge_selections.py`, not after Selection.*

Out of the skill work entirely: **C7**'s blank-cost half, which is a one-line default in
`merge_selections.py` or the template.

Still deferred: **C22** (cross-week memory) and everything downstream of the attendance loop, per
Greg's call to note but not build on the feedback loop while it's broken.

## Files

- `.claude/skills/personal-interests/SKILL.md` — A1–A4, B1–B15
- `.claude/skills/event-selection-philosophy/SKILL.md` — C1–C22
- `.claude/skills/philly-events-selection/SKILL.md` — D1, and the landing spot for C10–C12 procedure
- `.claude/skills/events-report-format/SKILL.md` — source of the three rules relocated by C10–C12
- `scripts/check_selection.py` (new), `scripts/merge_selections.py` (D2 runs after it),
  `scripts/runner.sh`, `.github/workflows/presentation.yml` — D2
- `docs/v1/Skills/{personal-interests,event-selection-philosophy}/SKILL.md` — A5

## Verification

There is no unit test for taste. The check is a re-run against frozen input:

1. Re-run Selection against **both** frozen weeks — `data/2026-08-03/` (561 candidates) and
   `data/2026-08-10/` (570) — with the edited skills, writing to a scratch path so the committed
   `_selections.json` files are preserved. Two weeks matter here: several findings looked acute in
   one week and self-corrected in the other, so a single-week diff will mislead.
2. Diff the picks. Expected, if the tranche works: no `address` above 2 slots in either week (this
   would have caught PFS×3 and Iffy×5); only one Beginner Soldering workshop (08-03); no inferred
   price presented as fact in any `why`; access notes on every pick outside the B8 radius; no
   regression on `time` parsing (all 42 clean today).
3. Run `scripts/html_render.py` on the result and eyeball the report against
   `docs/weeks/2026-08-03.html` — confirm the long `cost` strings no longer overflow the cards.
4. `pytest tests/` — must stay green; `_selections.json` shape is unchanged by everything except D2.

The judgment half cannot be unit-tested. Step 2 is a diff you read, not an assertion that passes —
the question it answers is whether the new picks are *better*, and only Greg can score that.

---
---

# Tranche 2 — make the guards bite (shipped)

Tranche 1 shipped as PR #25 (merged `ed320c0`, 12 commits). Then the week of **2026-08-17** ran —
the first Selection with those skills in place, and the holdout this document never had. Measuring
it reordered the work: the prose held wherever something mechanical was checking it and drifted
wherever nothing was, and the one guard that caught a live defect (`time_format`) was set to WARN,
so the bad report published anyway. Tranche 2, on branch `selection-hardening`, is mechanical
hardening, not more paragraphs.

**What tranche 1 actually did, measured:**

| | 08-03 | 08-10 | 08-17 | verdict |
|---|---|---|---|---|
| Max Top 3 slots at one address | 5 (Iffy) | 3 (PFS) | 2 | held — but by luck (venue_cap's key wasn't normalized) |
| Blank `cost` warnings | 93 | 67 | 0 | fixed by `7540385` |
| Categories represented | 6/9 | 6/9 | 7/9 | improved |
| `time_format` trips | 0 | 0 | 2 | regressed, and shipped |
| Blurbs with an access term | 2/21 | 3/21 | 3/21 | rule shipped, not followed |
| Top 3 per day | 3×7 | 3×7 | 3×7 | thinness rule never exercised |

**Two real defects found by measuring 08-17, both fixed:**

- The venue cap never actually fires against real spelling variance — Iffy Books took 5 of 21 top3
  slots on 08-03, but the address was spelled three ways across the picks, splitting the cap's key
  4+1 and letting it pass silently. `check_selection.py`'s `_venue_key()` now strips punctuation.
- Two 08-17 top3 picks (`c0467`, `c0468`, a PhilaMOCA double-header) omitted their `time` override,
  so the merge fell through to the raw candidate value `"7:00, 7:30"` — unparseable, so both picks
  silently lost their calendar entry. `check_selection.py` only flagged it as WARN. `merge_selections.py`
  now raises `MergeError` on an unparseable resolved `time`, before `_selections.json` is even written.

**Severity promotions:** `cost_blank` and `time_format` promoted WARN → FAIL (both have run clean
against a real week, satisfying PR #25's review condition). `venue_cap` stays WARN — it had never run
with a normalized key, so a quiet week wasn't yet evidence. `implausible_time` and `same_series` stay
WARN by design.

**New check:** `check_outside_philadelphia` (WARN) — 08-10 shipped two top3 picks outside city
limits (Glenside and Oaks, PA, ~25 mi) with nothing flagging it.

**Judgment gaps closed with real answers, not assumptions:** `personal-interests` gained a
`## Geography` section anchored on Point Breeze (home base) with a proximity-based access-note rule
(not rail-line-based — Point Breeze isn't on the El/BSL, so an El-served neighborhood like Fishtown
still needs a note), and a `## Timing` section stating weekday-daytime picks are genuinely
attendable. The free/PWYW ranking weight was removed from `personal-interests` entirely (Greg: "I no
longer have this preference") — consistent with `b120fa8` already dropping it from Tie-Break
Precedence in tranche 1.

**Findings closed with no work needed:** C19 (category coverage) — 🎨 Arts & Workshops and
🌿 Markets & Outdoors are both Flavor-tier interests after tranche 1's B3 carve-out, so zero Top 3
slots is the tier system working as designed. C17 (blurb homogeneity) — 08-17 ran 272–526 chars vs
08-10's 219–390; real variation across two independent weeks. C7 (blank cost) — already closed by
`7540385`, confirmed by zero warnings on 08-17.

**A4/A5 also landed:** the two dangling cross-references (`event-selection-philosophy.md` →
`event-selection-philosophy/SKILL.md`; `philly-sources` → `philadelphia-sources`) are fixed, and all
four `docs/v1/Skills/*/SKILL.md` twins — now genuinely diverged from their live counterparts while
carrying identical frontmatter `name:` fields — carry a one-line frozen-snapshot banner.

**Verification, actually run:** address-key normalization checked against all 33 distinct top3
addresses across three real weeks (one correct collapse, no false merges); `check_selection.py`
re-run against 08-03/08-10/08-17 confirmed `venue_cap` now trips Iffy×5 and PFS×3 while staying
silent on 08-17, and `cost_blank`/`time_format` FAIL exactly where expected; the merge was replayed
on a scratch copy of the un-backfilled 08-17 annotations and confirmed to raise `MergeError` naming
`c0467`. `data/2026-08-17/_selection_annotations.json` was then backfilled with the two missing
`time` overrides (`"7:30 PM"`, the representative show start) and re-merged in place — the only diff
in the regenerated `_selections.json` beyond the two `time` fields was `generated_at`. Full test
suite: 388 passing (was 382; +6 new cases), `ruff` and `mypy` clean on all changed scripts.

**Deferred:** A1, A3, A6, B9–B14, C9, C13–C16 (beyond the thinness note), C21, C22, D3, D4.
`venue_cap`'s FAIL promotion waits for a clean week under the normalized key.

---

## Tranche 3 — the calendar write guard (shipped)

**Tranche 2's own merge caused a data-loss incident, and this tranche fixes it.**

`presentation.yml` is path-filtered to `data/**/_selection_annotations.json`. Tranche 2's data-repair
commit `f24dbec` edited `data/2026-08-17/_selection_annotations.json` to backfill two `time`
overrides. That file matched the filter, so merging PR #26 fired Presentation against a week that had
already ended: `runner.sh` ran `calendar_create.py` with no `--dry-run`, `clear_target_week()` swept
every event in the 2026-08-17 window — including the ones Greg had deliberately deleted, which *were*
the attendance record — and re-inserted all 21 picks. Verified against the live calendar: every event
in that window carries `created`/`updated` of `2026-08-23T03:38:35Z`–`03:38:45Z`.

`CLAUDE.md` stated the invariant ("clear only the *target* (upcoming) week, never the prior week");
the code's guard was "clear the week being rendered," which equals the upcoming week **only when the
run is on-schedule**. This one wasn't. It is also a recurrence — `presentation.yml:22-27` already
documented a prior unintended calendar write (the 2026-08-02 incident); adding `branches: [main]`
closed one path, and this was a second through the same door.

**Blast radius, and the call.** Nothing downstream consumed it: `attendance_check.py` and
`csv_log.py` are deliberately shelved out of `runner.sh:10-16`, and Collection runs only
`collect_week.py`/`check_yield.py`/`prepare_selection_input.py`. No CSV was corrupted; only the
calendar is wrong. **08-17 accepted as lost** — recorded, not reconstructed.

**What shipped:**
- `calendar_create.py` — `week_has_already_begun()`. Refuses when the target Monday is in the past
  (Eastern, via `today_eastern()`, *not* the runner's UTC date — Actions cron is UTC and can't follow
  DST). Comparison is `<` not `!=` so a Sunday-evening-Eastern run that has crossed into Monday UTC
  still passes. The guard runs **before Google auth and before `--dry-run`**, so the exact command
  that caused the incident cannot reach the network. It returns 0 rather than failing: that same
  off-schedule run *also* repaired two malformed times in the live 08-17 report, and only the
  destructive half should be suppressed. `--force-calendar` overrides.
- `tests/test_calendar_create.py` — 7 new cases (23 total; suite 388 → 395), including the literal
  incident replay: `calendar_create.py data/2026-08-17` with no flags, on a frozen 2026-08-23, must
  make zero calls on the injected fake service.
- `presentation.yml` — week derivation no longer `| head -1`-drops other weeks *silently*: it picks
  the newest (dir names are `YYYY-MM-DD`, so lexicographic = chronological) and warns with the full
  list. Deliberately a warning, not a failure — a PR that backfills a historical week while a current
  week is live is routine (tranche 2's own PR had that shape), and failing there would block the
  legitimate publish. Publishing a past week is no longer dangerous now that the guard above makes it
  a report-only re-render. The publish commit also names the week rather than `$(date +%F)` — which
  is why `e16d455 "Publish report for 2026-08-23"` actually rendered `data/2026-08-17`.
- `philly-events-selection/SKILL.md:131` — dropped `free/PWYW` from the Prioritize echo. Tranche 2
  removed that weight everywhere else, leaving Selection instructed to apply a criterion that
  resolved nowhere. Purely descriptive mentions (The Rotunda's Venue Elevation entry,
  `philadelphia-sources`' cinespeak note) are correct and stay.
- `CLAUDE.md` — the attendance-loop paragraph now states what the guard *does*, not just the rule.

### What `data/2026-08-24` says — the first week selected under tranche 2's prose

`check_selection.py`: **0 fail, 0 warn.**

**C12 closes — the Point Breeze rewrite worked.** Blurbs containing an access term, by week:

| 06-22 | 08-03 | 08-10 | 08-17 | **08-24** |
|---|---|---|---|---|
| 2/21 | 2/21 | 0/21 | 2/21 | **7/21** |

On the denominator that matters: of the 5 picks on 08-24 genuinely outside the no-note zone (South
Philly / Center City / University City by ZIP), **4 carry an access note** — ~10% → 80% compliance on
the picks that need one. This tranche was originally drafted around "two tranches of prose failed to
move the access note, so it needs a mechanical check." Measuring 08-24 falsified that; no check was
written. Worth recording as a case where the prose *did* land on its own.

**Two findings recorded, not acted on:**
- *Cap-hugging.* 08-17 and 08-24 both land on **exactly 2 slots at each of the top four venues** —
  precisely the cap, twice running — alongside 3×7 Top 3 picks for **five consecutive weeks**. Reads
  like stated limits being treated as targets, the same tell as the old "exactly 3 honorable mentions
  every day." Judgment work; needs its own hypothesis.
- *Degenerate venue keys.* 08-24's cap histogram contains `philadelphia`, `workersunited`,
  `askapunkaskapunk`, `club624`, `kingsessingrecreationcenter`, `pentridgestation` — fallbacks minted
  when `address` is missing or junk. `philadelphia` is the dangerous one: two unrelated venues whose
  address is just the city collide into one cap bucket. Same class as the punctuation split tranche 2
  fixed, and it also makes `check_outside_philadelphia` trivially satisfiable.

**`venue_cap` stays WARN, now for a better-stated reason.** Its docstring criterion is met several
times over (trips 06-22 ×5/×4, 08-03 ×5/×3/×3, 08-10 ×3; silent on 08-17 and 08-24). Promotion is
blocked on two things: the degenerate keys above must be fixed first, and promoting would make
`06-22`/`08-03`/`08-10` hard-fail — which, given this tranche's finding that historical weeks *do*
get re-processed, would swap a data-loss trap for a build-breaking trap on the identical trigger.

**Deferred:** everything above plus the standing list — A1, A3, A6, B9–B14, C9, C13, C14, C15, C21,
C22, D3, D4, and a provenance filter inside `clear_target_week` (real defense-in-depth, but it would
not have prevented this incident — the events it deleted were its own).

> **Correction (tranche 4).** The `venue_cap` paragraph above is wrong where it says "historical
> weeks *do* get re-processed." They can't. `presentation.yml` runs **Merge selections → Check
> selection**, so CI never reads a stale `_selections.json` — it checks a freshly re-merged one. Only
> 08-10, 08-17 and 08-24 have a `_selection_annotations.json` (the only file that fires the trigger),
> and all three re-merge to 0 fails. `06-22` and `08-03` cannot fire the workflow at all and would
> crash at the merge step for missing inputs anyway. `venue_cap` is still deferred, but for the
> reason given in tranche 4, not this one.

---

## Tranche 4 — cross-source duplicate candidates (shipped)

The first tranche to fix Selection's **input** rather than its judgment or the machinery around it —
and a defect this document never named.

`prepare_selection_input.py`'s `collapse_exact_duplicates()` keys on `(title, venue, date)`. Sources
spell the same room differently, so cross-source duplicates never collapsed:

| week | raw | after exact-dup | after cross-source | redundant records |
|---|---|---|---|---|
| 2026-08-03 | 642 | 616 | 594 | **22** |
| 2026-08-10 | 641 | 619 | 589 | **30** |
| 2026-08-17 | 610 | 589 | 570 | **19** |
| 2026-08-24 | 677 | 657 | 633 | **24** |

~5% of everything Selection reads was a duplicate of something else it read.

**The safety argument, which is the whole design.** Grouping four real weeks on
`(date, normalized title)` gives 122 multi-record groups:

| classification | count | disposition |
|---|---|---|
| cross-source, venue strings compatible | 66 | collapsed |
| cross-source, venue strings look unrelated | 29 | collapsed — all 29 inspected, all true duplicates |
| **same-source**, venue strings differ | **19** | **left alone — genuinely different rooms** |
| same-source, compatible | 8 | already handled by the exact key |

The 29 "unrelated-looking" ones are one venue under two names (`Philadelphia Film Society` ↔ `PFS
Film Society Center, 1412 Chestnut Street…`; `Highmark Mann` ↔ `TD Pavilion at The Mann Center`;
`Upper Merion Township Building Park` ↔ `Concerts Under the Stars`). The 19 dangerous ones — five
Dave & Buster's locations sharing "1 / 2 Price Games Wednesdays", "Wellness Walks" at two Awbury
sites, PFS's own Film Society Center vs Bourse Theater — are **all single-source**. Restricting the
collapse to multi-source groups excludes every one of them. That is why the rule is what it is.

### The motivating defect, and how much of it this actually fixes

`data/2026-08-10` published *REPO MAN X CIRCLE JERKS* with `venue: "PhilaMOCA, 531 N 12th St,
Philadelphia, PA 19123"` and `address: "291 N Keswick Ave, Glenside, PA 19038"` — **the report card
named a Philadelphia venue for an event 25 miles away in Glenside, while the calendar entry pointed
correctly to Glenside.** Three candidate records existed:

| id | source | venue | |
|---|---|---|---|
| `c0508` | R5 Productions | `Keswick Theatre` | ✅ |
| `c0215` | Do215 | `Keswick Theatre, Glenside, Pe` | ✅ |
| `c0491` | PhilaMOCA | `PhilaMOCA, 531 N 12th St, …` | ❌ self-stamped |

PhilaMOCA's feed stamps its own address onto offsite co-presentations; its own description says "At
the Keswick Theatre… Presented by … PhilaMOCA". Selection picked that record. Its authored `address`
was *right* — it read the description and overrode the venue — but `merge_selections.py` copies
`venue` from the candidate, so the report shipped the wrong one.

**Honest scope: this tranche fixes that group only partially.** `c0215` and `c0508` share a
normalized title and collapse to R5's correct record. `c0491`'s title is genuinely different
(`repomanxcirclejerksscreeningperformance` vs `circlejerksxrepoman`), so it survives as a second
record with the wrong venue — 3 records became 2, not 1. Selection could still pick it. Catching
that needs fuzzy title matching, which has not been safety-analysed the way exact normalized-title
matching has, and is not worth guessing at. **The self-stamping parser behaviour is the more direct
fix and is deferred, not solved here.**

### Findings recorded, not acted on

**Cap-hugging, with a corrected timeline.** Tranche 3 called 08-10 a post-rule week; it isn't.
`0d19b2f` (the cap rule) landed 2026-08-11 and 08-10's selections were generated 2026-08-09. The real
split is 3 pre-rule weeks vs 2 post-rule, and the pattern is *starker* than tranche 3 recorded:

| week | rule | Top 3 per venue, sorted | over cap | exactly at cap |
|---|---|---|---|---|
| 06-22 | pre | `[5, 4, 2, 1×10]` | 2 | 1 |
| 08-03 | pre | `[5, 3, 3, 1×10]` | 3 | 0 |
| 08-10 | pre | `[3, 2, 2, 2, 1×12]` | 1 | 3 |
| **08-17** | **post** | `[2, 2, 2, 2, 1×13]` | **0** | **4** |
| **08-24** | **post** | `[2, 2, 2, 2, 1×13]` | **0** | **4** |

Every pre-rule week has an over-cap venue, peaking at 5. Both post-rule weeks land on exactly four
venues × exactly 2. Supply was not the constraint: on 08-17 PhilaMOCA had 19 candidates and PFS 18;
on 08-24 City Winery had 23 and PFS 20. These are two independent Selection runs a week apart.
Alongside it: **five weeks, 35 of 35 days, exactly 3 Top 3 picks** — C16's "real permission, not a
theoretical one" has never once been exercised. Recorded rather than fixed because the only lever on
offer is more prose, which is exactly what C16 already tried.

**Venue keys.** No key currently fuses two different venues, but two could: `philadelphia` (Do215
flattens a venue object whose `title` is literally "Philadelphia" — 11 unrelated events across four
weeks) and `askapunkaskapunk` (`philly_ask_a_punk.py:44-45`, when `place` carries no real venue).
Unrealized only because at most one such candidate was ever promoted to Top 3. The inverse also
happens — one venue splitting across keys (Kingsessing Rec Center → 3 keys, Johnny Brenda's → 3,
Underground Arts → 2 differing only in ZIP) — though every observed split is *across* weeks, and the
cap is per-week, so none has actually under-counted. Root cause for all of it: `write_event()` in
`event_parsers/base.py` flattens away structured venue data several parsers already hold (PFS's
stable `theater_url` slug, Ask A Punk's `place.name`/`place.address`, Do215's venue object). That is
the real fix for venue identity and it is a schema change touching every parser — a tranche of its
own.

**`venue_cap` stays WARN.** Its criterion is met (trips 06-22, 08-03, 08-10; silent on 08-17,
08-24), and the trap tranche 3 cited doesn't exist (see the correction above). Deferred for a better
reason: this tranche changes which candidates Selection sees, so promoting a cap check in the same
PR would make any regression ambiguous. Promote after one clean week under the new candidate pool.

### Known sharp edge, documented rather than fixed

**Re-running Collection for an already-selected week is destructive.** `collection.yml` exposes
`workflow_dispatch` with a free-text `week_start` and no past-week guard, and `assign_ids` numbers
positionally (`c{i:04d}`), so ids shift whenever the candidate list changes. Re-collecting a past
week overwrites its raw source files with whatever the sources return today — likely nothing, for a
week gone by — and renumbers every id, after which that week's committed
`_selection_annotations.json` references ids that no longer resolve and `merge_selections.py` raises
`MergeError: unknown id`. This is **pre-existing**; this tranche widens it (re-running the new dedupe
over 08-10/08-17 would collapse `c0204`, `c0379`, `c0470`, which their annotations reference). It is
not reachable from the normal pipeline: `_candidates.json` is written by Collection and frozen, and
`presentation.yml` only ever re-runs `merge_selections.py` against it. If this needs closing, the fix
is a past-week guard in `collection.yml` mirroring `calendar_create.py`'s `week_has_already_begun()`.

**Deferred:** the above, plus PhilaMOCA's self-stamping parser, fuzzy cross-source title matching,
the `event_parsers/base.py` venue-schema expansion, and the standing list — A1, A3, A6, B9–B14, C9,
C13, C14, C15, C16, C21, C22, D3, D4.

---

## Tranche 5 — stop repeating last week's picks (shipped)

**C22 is closed, and its stated reason for deferral was wrong.** This document deferred cross-week
anti-repetition with *"the only cross-week store is the picks log, which is broken and unwired."*
True of v1's CSV; **not** true of v2 — `data/<week>/_selections.json` is committed for every week and
sits in the repo that both Selection and CI check out. The store has existed since the v2 data layout
landed. Same shape of falsified premise as tranche 3's "historical weeks get re-processed."

**The rule was already written and was being violated in every report.** `event-selection-philosophy`
already said *"Recurring weekly events as a Top 3 pick unless there's a special guest or specific
reason to highlight this instance"* — but nothing had ever looked at a prior week:

| week | Top 3 slots recycled from an earlier report |
|---|---|
| 2026-08-03 | 3 / 21 (14%) |
| 2026-08-10 | 1 / 21 (5%) |
| 2026-08-17 | **5 / 21 (24%)** |
| 2026-08-24 | 3 / 21 (14%) |

- **Rustin's Challenge Reading Group** @ Philadelphia Ethical Society — a Top 3 pick in **all four**
  of the last four reports
- **West Philly Canvass for Chris Rabb** — three consecutive weeks
- **Killer Of Sheep** @ PFS — the same film two weeks running
- **Beginner Soldering: Li-Ion Battery Pack** @ Iffy Books — 08-03 and again 08-17
- *(out of scope)* Dekalog Parts 1&2 → 3&4 → 5&6 — a series, genuinely different content each week

Why nothing caught it: `group_recurring()` collapses the same `(title, venue)` on **3+ dates within
one week**, and a weekly event appears exactly once per week, so `recurrence_count` is empty for
every one of those picks. Verified.

**Shipped:** `check_repeat_of_recent_pick()` (WARN) in `check_selection.py`, reproducing the history
above exactly; `load_recent_weeks()` counting the 3 most recent prior week *directories* that
actually have a `_selections.json` (directories, not calendar weeks — `data/` has real gaps, and
`2026-07-20`/`-07-27` are Collection-only); a `_recent_picks.json` sidecar from
`prepare_selection_input.py` so Selection doesn't have to open ~1400-line files; and the skill edits
making the Avoid rule explicitly cross-week.

**A finding that corrected an earlier note in this document.** Tranche 4 recorded that one venue
splitting across several `_venue_key`s was harmless because "every observed split is *across* weeks,
and the cap is per-week." True for the cap — **false for this check**, which is cross-week by
construction. The West Philly canvass ran three consecutive weeks under one identical `venue` string
but three different model-written addresses (`5140 Chester Ave…`, `4901 Kingsessing Ave…`, and none
at all), and an address-keyed check missed two of the three repeats. `_repeat_key` therefore keys on
the **source-derived venue name**, not the model-authored address — the opposite tradeoff from
`check_venue_cap`, and for the opposite reason. Caught by verifying against real history rather than
by the unit tests, which is why that case is now a test.

**The week of 2026-08-31 is this tranche's holdout**, the way 2026-08-17 was tranche 2's. Its
`_recent_picks.json` will carry 08-10/08-17/08-24 — including *Rustin's Challenge Reading Group*,
now four weeks running. If the 08-31 report still features it, the Phase 3 instruction failed the
same way C16's thinness note has, and the honest conclusion is that prose alone doesn't move this
either. Check `check_selection.py`'s `repeat_pick` warnings on that week before assuming the tranche
worked.

### Recorded for the next tranche

- **The report lists ~14% of what it collects, and the cap meant to prevent over-inclusion has never
  fired.** `philly-events-selection`'s "at most 10 annotated candidates per category per day"
  justifies itself against "~640 raw events collected most weeks" — the raw figure checks out
  (642/641/610/677), but the observed maximum in any category-day is **5**, and output is ~80 listed
  events from ~570 candidates. The prose guards against over-inclusion while the behaviour is
  aggressive under-inclusion. Likely upstream of the next two items.
- **🎨 Arts & Workshops is 0-for-84 Top 3 slots** while carrying listed events every week and being
  the second-largest supply category; 👻 Horror & Occult took 8 off a smaller pool. Tranche 3 closed
  C19 because the zero-slot categories were Flavor-tier — that holds for 🌿 Markets & Outdoors but
  **not** for 🎨, whose scope overlaps Core interests. Reads like a category-boundary problem.
- **C9 is live.** "Events at large corporate venues unless the act is truly unmissable" still names
  no venues and sets no bar, and **City Winery — a national chain — took 3 Top 3 slots across four
  weeks, two of them in 2026-08-24 alone**, sitting exactly at the venue cap.
- **The sold-out signal is collected and then dropped.** No event has ever been flagged `sold_out` in
  any week (0 across 84 Top 3, 66 honorable mentions and 726 listed events), yet 8 candidates across
  four weeks carry "sold out" in their title or description — one titled literally `SOLD OUT – WXPN
  Homegrown Live!`. None reached a listing. So C13's ranking question is moot for now, but
  `events-report-format`'s "always note if a show is sold out" asserts an authority the pipeline has
  never exercised.

### Venue-schema expansion — scoped and deliberately not done

Recorded so it isn't re-scoped from scratch:

- **It would buy key stability, not data correctness.** Where a pick's `venue` string embeds a street
  number, the model's independently-authored `address` **agrees 21 times and disagrees once** across
  five weeks — and that one disagreement is the Circle Jerks case where the model was *right*. The
  model supplies an address on 77 of 84 August picks (92%).
- **Do215 is the gating unknown.** It supplies ~55% of Top 3 picks, and its API's venue object shows
  only `{title, city, state}` in the only copy of that payload in the repo — a trimmed fixture.
  Whether the live API returns a street address decides whether the project covers ~30% of picks or
  ~85%. Answer that before costing anything.
- **A venue→address table already exists and is dead.** `philadelphia-sources/SKILL.md:566-583` has a
  12-row "Venue Address Lookup" that nothing reads: it lives in the Collection skill, but Collection
  never authors addresses — Selection does, in a stage that never loads that file. It is also
  Markdown, so no script can consume it, and it duplicates addresses already present as Python
  constants in `collect_source.py`. The cheap first move is wiring up what is already written down.

**Deferred:** all of the above, plus series-repeats and venue-repeat-dominance (considered and left
out of scope for this tranche), `venue_cap`'s FAIL promotion, PhilaMOCA's self-stamping parser, the
degenerate-key guard, a past-week guard for `collection.yml`, and the standing list — A1, A3, A6,
B9–B14, C9, C13, C14, C15, C16, C21, D3, D4.

---

# Tranche 6 — venue identity as data quality (and no hard venue cap)

## The 2026-08-31 holdout

First week selected under **both** tranche 4's cross-source dedupe and tranche 5's cross-week repeat
check. `check_selection.py`: **0 fail, 0 warn**.

| | 08-10 | 08-17 | 08-24 | **08-31** |
|---|---|---|---|---|
| `repeat_pick` warnings | 1 | 4 | 2 | **0** |
| Top 3 picks with no `address` | 0 | 0 | 6 | **0** |
| candidates (raw → deduped) | 641→570 | 610→551 | 677→619 | **472→415** |

**Tranche 5 worked on its first live week.** "Rustin's Challenge Reading Group" — a Top 3 pick in
**four consecutive reports** — is gone, as is the Chris Rabb canvass (three straight). Zero repeats.
🎨 Arts & Workshops also took its **first-ever Top 3 slot** after 0-for-84.

## The venue cap: cancelled, not deferred

Measuring the key to cash in tranche 4's promotion precondition produced the number that settles it.
Over all 126 published Top 3 slots: **Iffy Books 16, PhilaMOCA 14, Wooden Shoe 13 — three venues hold
34% of every slot ever published.**

**Greg's call: that is fine when the events are good, and no hard cap should exist.** Those three are
an anarchist bookstore, a DIY cinema and a radical bookshop — Core-tier interests per
`personal-interests`. A venue is not a proxy for event quality in either direction.

So `venue_cap` stays **WARN permanently**, recorded as a decision in `check_selection.py`'s docstring
so it isn't reopened on mechanical grounds a fifth time. The hard-cap prose is removed from
`event-selection-philosophy` (its "Weekly Caps" section is now "Weekly Patterns") and replaced by a
softly-worded nudge in `philly-events-selection` Phase 3: notice venue repetition, re-check that each
pick earned its slot on the event, and **never drop a better event to even out the venues**. The
prose deliberately states no number — tranche 4 measured the model treating stated limits as targets
(five straight weeks of exactly 3×7 picks; two of exactly-2-at-four-venues).

**This tranche is therefore about venue data being *correct*, not about limiting anything.**

## Tranche 5's gating unknown, answered

Tranche 5 deferred all venue-identity work on one question: whether Do215's API returns a real
address. It does. Fetched live 2026-08-30:

```json
{"id": 511812, "title": "Nikki Lopez", "permalink": "/venues/nikki-lopez",
 "address": "304 South St, Philadelphia, PA 19147", "city": "Philadelphia",
 "state": "PA", "zip": "19147", "latitude": null, "capacity": false}
```

`id` is always present and address-stable (0 of 145 ids varied across one week); `address` is present
on ~78% of venues but can be `null`, `""`, padded or ALL-CAPS. The repo's only copy of the payload
was a trimmed fixture showing `{title, city, state}`, which is why the project looked unaffordable.
**Do215 is 48.4% of all 126 Top 3 picks.**

What the object does *not* carry is any quality signal — `latitude` null 145/145, `capacity` false
145/145, `popularity` 1.0 on 142/145. "Nikki Lopez" is metadata-identical to Union Transfer.

## Three defects, all shipped (plus one non-defect, corrected below)

**Wrong calendar pin (false merge).** Selection authored "301 S Christopher Columbus Blvd" for *both*
Spruce Street Harbor and Cherry Street Pier on 08-31 — one key for two venues, and wrong for Cherry
Street Pier, which Do215 puts at **121 N**. The live calendar entry for that Sheer Mag show pins
about a mile away, at the wrong pier.

**Hidden false split.** "1412 Chestnut St" and "1412 Chestnut Street" were two keys, so PFS's real
**10 slots across 4 weeks** showed as 7 and 3. Same for Ortlieb's, Johnny Brenda's, Underground Arts
(one street under two ZIPs) and Cousin Danny's. Every venue number computed before this fix was
undercounted.

**Unpinned entries and degenerate keys.** 08-24 shipped **6 of 21** picks with no address, so six
calendar entries had no location at all, and the cap fell back to venue names — minting `philadelphia`
(from Do215's "Philadelphia, Philadelphia, Pe", which covers 11 unrelated events across four weeks),
`askapunkaskapunk`, `workersunited`.

**Not a defect, corrected during review.** A draft of this tranche described Do215 venue 511812
("Nikki Lopez", covering six shows at 304 South St, two of which shipped as Top 3 cards) as "a
person's name published as a venue" — the assumption behind D4 below and the append-not-replace
parser design. Greg caught this on the PR: Nikki Lopez is a real, distinctively-named DIY venue, not
junk data — it's appeared as a plain venue name in this project's own real weekly reports since
2026-06-10 (`docs/v1/Data/event-picks-log.csv`) with no confusion, the same category as "Johnny
Brenda's" or "Ortlieb's". There was never a display defect to fix here. The append-not-replace design
itself is unaffected — its real justification is that no signal (API-side or lexical) reliably tells
an unusually-named real venue apart from an actually bad title, so replacing risks erasing a good
name to "fix" one that was never broken — but the specific example was wrong and has been corrected
everywhere it appeared (`event_parsers/do215.py`, `tests/test_parse_events.py`).

## What shipped

`write_event()` gains optional keyword-only `venue_address`/`venue_id`, omitted when empty so no other
parser changes. Populated from Do215 and Ask A Punk. `merge_selections.py` resolves a pick's `address`
as **source first, Selection second**, and `check_selection.py`'s `_street_key()` folds abbreviation
and ZIP variants while discarding locality.

Two design points worth not re-deriving:

- **The key must never be the venue id.** PhilaMOCA reaches Top 3 via its own source *and* via Do215
  in the same week (06-22, 08-03); an id-based key would split it. Discarding locality is what keeps
  a bare source street ("531 N 12th St") comparable with Selection's full address. Verified: 126
  picks 57→52 keys, 51 distinct addresses 51→44, seven merges, all correct, zero false.
- **A bad venue title is not reliably classifiable, so titles are never replaced, only appended to.**
  No API signal exists, and a lexical "looks like a person's name" rule fires on 57 of 312 real venue
  strings — including *Nikki Lopez itself* and *Spruce Street Harbor*, both real venues. Corrected
  during review (see above): there is no known example of an actually-bad Do215 title in this data —
  the design choice is precautionary, not a fix for a confirmed defect. Appending is still the safer
  default because it cannot erase a real, unusual venue name to "fix" a title that was never broken.
- **Selection never sees the new fields.** `split_by_day()` strips them, because Selection reads the
  per-day files while the merge reads the monolithic one. That keeps the skill's "candidates never
  carry an address" accurate, keeps the token-optimized payloads from growing, and — the real reason —
  keeps Selection's address an *independent* second opinion rather than an echo, which is what makes
  the new `address_conflict` WARN worth anything.

Verified end to end by joining a live re-fetch of the 08-31 week onto its committed candidates: the
two piers separate, and `address_conflict` fires exactly once, on the real defect.

**Known and accepted false merge:** Moshulu and Spirit of Philadelphia are two boats at 401 S Columbus
Blvd. Of 5 Do215 key collisions in 108, the other 4 are genuine repairs. At WARN it costs a line.

## Deferred

The three findings tranche 5 nominated — under-inclusion (~14% of collected events listed), the 🎨
Arts & Workshops category boundary (weakened by 08-31's first slot), and C9's unnamed "large corporate
venues". Plus: the dead `philadelphia-sources/SKILL.md:566-583` venue table (**explicitly out of
scope**, so it isn't re-scoped a third time), C16 thinness, PhilaMOCA's self-stamping parser, a
past-week guard for `collection.yml`, and the standing list — A1, A3, A6, B9–B14, C13, C14, C15, C21,
D3, D4.

**Recorded, not acted on:** 🎵 Music & Concerts took **10 of 21** slots on 08-31 (48%; Friday and
Saturday were entirely music) against 6–7 in prior weeks. One week is not a trend — if it recurs it is
a category-balance question, not a venue one.
