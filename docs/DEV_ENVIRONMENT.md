# Dev environment

How to work on this repo, whether you are a person at a terminal or Claude Code (local, cloud, or the
Selection Routine). The repo has two stacks:

- **Python 3.12** (`scripts/`, `tests/`). This is what production runs today.
- **TypeScript on Node 24** (`src/`). This is the in-progress port that will replace the Python tier by tier.

Everything below is committed to the repo unless a section says it's manual.

## Quick start (local, macOS)

```sh
npm run setup           # npm ci + .venv (Python 3.12) with dev + collection requirements
npm run setup:browsers  # only if you'll touch fetch_page_text.py/fetchPageText.ts / run the full test suites
cp .env.example .env    # fill in; only needed to run scripts against real Google/Spotify
direnv allow            # loads .env and puts .venv/bin on PATH whenever you cd in
npm run check           # everything CI checks, both stacks
```

`npm run setup` needs `python3.12` on PATH (`brew install python@3.12`), because the system `python3` is newer.
It also needs Node 24 (`.nvmrc`). With nvm, run `nvm use`. Homebrew's `node` also works as long as it's ≥ 22.

## Where each tool works

| Tool | Local CLI / IDE | Cloud session | Selection Routine | GitHub Actions |
|---|---|---|---|---|
| `.python-version` / `.nvmrc` pins | ✓ (pyenv/uv/mise/nvm read them) | ✓ if setup script honors them | n/a | ✓ (`*-version-file`) |
| npm scripts (`check`, `setup`, …) | ✓ | ✓ after setup script | not used | `check:ts` in `lint.yml` |
| `scripts/dev/py.sh` | ✓ uses `.venv` | ✓ falls back to PATH | not used | not used |
| `.claude/settings.json` permissions | ✓ | ✓ | ✓ (loaded! see Routine safety) | n/a |
| SessionStart hook | ✓ (one status line) | silent | silent | n/a |
| PostToolUse lint hook | ✓ | ✓ if deps installed | ✓ no-op on JSON edits | n/a |
| LSP plugins (`enabledPlugins`) | ✓ | ✗ never loaded | ✗ | n/a |
| Playwright MCP (`.mcp.json`) | ✓ after one-time approval | ✗ in practice (browser CDN blocked) | ✗ unapproved, not loaded | n/a |
| Google Calendar / Drive / Gmail MCPs | ✓ (claude.ai connectors) | ✓ | ✓ available, unused | n/a |
| Subagents (`.claude/agents/`) | ✓ | ✓ | available, unused | n/a |
| `@claude` Action (`claude.yml`) | n/a | n/a | n/a | ✓ once a secret is set |
| direnv (`.envrc`) | ✓ | n/a | n/a | n/a |
| VS Code (`.vscode/`) | ✓ | n/a | n/a | n/a |

## Routine safety (read before touching `.claude/` or `.mcp.json`)

The Selection Routine is a Claude Code cloud session running against this repo. It loads the project
`.claude/settings.json` and hooks. During its run it edits `data/<week>/_selection_annotations.json`
and then runs `git add`, `git commit`, and `git push` (see
`.claude/skills/philly-events-selection/SKILL.md`, "Commit and push"). That push is what fires
Presentation. So:

- **No deny or ask rule may match** git add, commit, or push, or edits under `data/`.
- **Hooks must be fast and must `exit 0`** on anything they don't handle. Neither hook installs anything.
- **Heavy installs** (npm, pip, Playwright) go in the cloud environment's setup script (below), never in a hook.

The `pipeline-contracts-reviewer` subagent checks for this, among other things.

## Cloud sessions (claude.ai/code)

Repo settings, hooks, and `.mcp.json` load. Plugins and your `~/.claude/` user settings do not.
`CLAUDE_CODE_REMOTE=true` is set. The image ships Python, Node, pip, and npm, but not this repo's
dependencies. For each environment you use for dev work, configure it in claude.ai → environment
settings:

- **Setup script** (runs once per environment and is cached):
  ```sh
  #!/bin/bash
  set -e
  cd /home/user/this-week-in-philly
  node --version | grep -q '^v2[4-9]' || { . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm alias default 24; } || true
  npm ci
  pip install -r scripts/requirements-dev.txt -r scripts/requirements-collection.txt
  ```
  The script starts in `/home/user`, not the repo, so the `cd` is required. Without it `npm ci` fails
  with a misleading "needs an existing package-lock.json" error. The nvm line is best-effort and assumes the image provides nvm. Check it the first time with
  `node --version`. If Node 24 isn't available, the image's Node works as long as it is ≥ 22
  (`engines`). CI still tests on 24.
- **Network access:** the default *Trusted* level covers npm and PyPI. Playwright's browser download
  is not on that list. If you need `npm run setup:browsers` or the network pytest suite in the cloud,
  switch to *Custom* and add the Playwright CDN hosts, or to *Full*. Otherwise leave it at Trusted.
  Without a browser, the offline pytest suite fails only in `tests/test_fetch_page_text.py`, which
  drives real Chromium against file:// fixtures. Run it as `npm run test:py -- --ignore tests/test_fetch_page_text.py`.
  Likewise vitest fails only in `src/fetchPageText.test.ts`: `npm test -- --exclude src/fetchPageText.test.ts`.
  `npm run check:ts` never needs a browser.
- **Secrets:** none are needed to run the tests. Don't put real Google or Spotify tokens into a
  cloud environment for dev work, because environment variables are visible to anyone using that
  environment.
- **Keep the Selection Routine's environment lean.** It needs none of the above. Give it its own
  environment, or accept a setup script that only adds time.

## Tool reference

### Runtime pins: `.python-version`, `.nvmrc`
- **What:** Python `3.12` and Node `24`. CI reads both through `python-version-file` and `node-version-file`, so changing a pin changes CI.
- **Use:** pyenv, uv, mise, and nvm pick them up automatically. Without a version manager, call `python3.12` explicitly (`npm run setup:py` does).
- **Why pin:** the macOS system `python3` is 3.14 and CI is 3.12. The pin keeps a local venv from drifting.

### npm scripts (task runner for both stacks)
| Script | Runs |
|---|---|
| `npm run check` | `check:ts` then `check:py`, the full CI-equivalent gate |
| `npm run check:ts` | `typecheck` (tsc) → `lint` (eslint) → `test` (vitest) |
| `npm run check:py` | `lint:py` (`ruff check scripts/`) → `typecheck:py` (mypy) → `test:py` (pytest, offline) |
| `npm run setup` | `npm ci` + `setup:py` |
| `npm run setup:py` | creates `.venv` with 3.12, installs dev + collection requirements |
| `npm run setup:browsers` | `playwright install chromium` for both the venv and Playwright for Node (each pins its own browser build) |
| `npm run test:watch` | vitest watch mode |
| `npm run build` | tsc → `dist/` |

To run one test file, use `npx vitest run src/checkYield.test.ts` or `scripts/dev/py.sh pytest tests/test_common.py -k week`.
Network tests: `scripts/dev/py.sh pytest -m network`. These are manual only and hit real sources.

### `scripts/dev/py.sh`
Runs a Python tool from `.venv/bin` if it exists, otherwise from PATH. Usage: `scripts/dev/py.sh <tool> [args…]`.
It lets the same npm scripts work locally, in CI, and in cloud sessions.

### CI: `.github/workflows/lint.yml`
Four jobs: `ruff`, `mypy`, `pytest` (installs Chromium), and `typescript` (`npm ci` + `check:ts`).
Pip and npm downloads are cached. It triggers on changes to Python, TS, config, pins, or `tests/**`.
It does not trigger on `data/**`, which changes weekly. `collection.yml` and `presentation.yml` read the
same Python pin and cache pip downloads. Nothing else about them changed.

### Claude Code project settings: `.claude/settings.json`
- **Allow list:** the test, lint, and typecheck commands for both stacks, plus read-only `git` and `gh` (PR, run, and check views).
  Anything else still prompts. Put personal additions in `.claude/settings.local.json` (gitignored), or run the
  built-in `/fewer-permission-prompts` skill to mine your transcripts for more.
- **Deny list:** reading `.env`, `credentials.json`, and `token.json`.
- **Personal overrides:** `.claude/settings.local.json` (yours, uncommitted) layers on top.

### Hook: SessionStart (`.claude/hooks/session-start.sh`)
Locally, it prints one status line into Claude's context: whether `node_modules` and the Python dev
tools are present. It exits silently in any cloud session (`CLAUDE_CODE_REMOTE=true`), so even a
descriptive "deps missing" line can't nudge the Selection Routine into installing things. It never
installs and always exits 0.

### Hook: PostToolUse lint (`.claude/hooks/lint-edited.sh`)
After every Edit or Write, it lints only the edited file:
- `scripts/**.py` goes through `ruff check`.
- `src/**.ts` goes through eslint.

On errors it exits 2, so Claude sees the output and fixes it in the same turn. Every other path is a no-op.
It never formats: the codebase isn't `ruff format`-clean (49 files would change), and there's no prettier.
Test it by hand with `echo '{"tool_input":{"file_path":"'$PWD'/scripts/common.py"}}' | bash .claude/hooks/lint-edited.sh; echo $?`.

### LSP plugins: `pyright-lsp`, `typescript-lsp`
- **What:** declared in `enabledPlugins` from the official `claude-plugins-official` marketplace. They give Claude go-to-definition, references, and diagnostics without grepping. They work locally only.
- **Setup:** accept the install prompt the first time you open the repo, or run `/plugin`. The language servers
  must be on PATH, per each plugin's README: `npm i -g pyright typescript-language-server typescript`.

### MCP: Playwright (`.mcp.json`)
- **What:** `@playwright/mcp` runs headless and isolated, so Claude can drive a real browser.
- **When to use it:** debugging a source parser, seeing what a JS-rendered source page actually serves before
  writing a `scripts/event_parsers/*.py` or TS port, and eyeballing a rendered report (`docs/weeks/*.html`) at phone width.
- **Setup:** approve it once when Claude prompts (`claude mcp get playwright` shows the status).
  It downloads its own browser on first use.
- **Where it works:** not in cloud sessions or the Routine.

### MCP: Google Calendar / Drive / Gmail (claude.ai connectors)
- **What:** these are already connected at the account level. They are not in the repo.
- **Useful here:** checking what `calendar_create.py` actually wrote, e.g. "list events on the Curated Events
  calendar for the week of 2026-09-28".
- **Rule:** keep it read-only. Deleting entries by hand has the same effect as the attendance signal (see CLAUDE.md, "Attendance feedback loop").

### Subagents: `.claude/agents/`
- **`ts-port-parity`:** ports one `scripts/*.py` module to `src/`. It follows the existing conventions (`src/lib/json.ts` for
  byte-identical JSON, shared `tests/fixtures`, a "Divergences from the Python" header). It then diffs the port's
  output against the Python on the committed weeks. Invoke with "use ts-port-parity to port scripts/html_render.py".
- **`pipeline-contracts-reviewer`:** a read-only reviewer that checks a branch against CLAUDE.md's Key contracts
  and Routine safety. Run it before opening a PR that touches `scripts/`, `src/`, `templates/`, workflows, or `.claude/`.

### Slash commands and skills worth knowing
- **`/next-task`** (yours, in `~/.claude/commands/`): pulls `main` and starts the next chunk on a new branch. It pairs well with `ts-port-parity`.
- **`/code-review`** reviews the current diff for bugs. `/simplify` does a quality pass. `/security-review` covers anything touching auth or secrets.
- **`/fewer-permission-prompts`** grows the allow list from your actual usage.
- **`/schedule`** manages cloud Routines, the same system Selection runs on. Don't create a second
  Collection Routine; see SETUP.md §4 for the incident.
- **`/run`** drives the app to see a change working. For this repo that means rendering a report with
  `scripts/html_render.py` and opening it.
- **Project skills** (`.claude/skills/`) are the Selection Routine's domain knowledge. They aren't dev tools, so edit them with care.

### GitHub: `@claude` Action (`.github/workflows/claude.yml`)
- **What:** mention `@claude` in an issue, PR comment, or review, and `anthropics/claude-code-action@v1` answers or pushes a fix.
- **Who can trigger it:** only the repo owner. The repo is public, so this restriction matters.
- **Setup:** it's inert until you add a secret (SETUP.md §3). Either run `/install-github-app` in Claude Code, or run
  `claude setup-token` and store the result as `CLAUDE_CODE_OAUTH_TOKEN`.
- **In cloud sessions:** you can also enable PR auto-fix from the CI status bar. That needs no workflow.

### direnv: `.envrc`
Loads `.env` (if present) and adds `.venv/bin` to PATH on `cd`. Run `direnv allow` once, and again after
editing `.envrc`. This replaces SETUP.md's manual `set -a; . ./.env; set +a`.

### VS Code: `.vscode/`
- **`extensions.json`:** recommends Ruff, Python, Mypy, ESLint, Vitest, and EditorConfig.
- **`settings.json`:** points the interpreter at `.venv` and turns on pytest discovery.

### `.editorconfig`
Sets UTF-8, LF, a final newline, and 2-space indentation, with 4 spaces for Python. This matches the existing code.

## Considered, not adopted

| Tool | Why not |
|---|---|
| uv / lockfile / `[project]` in pyproject | The Python tree is scheduled for deletion (port Tier D). A pin plus pip caching is enough until then. |
| mise, just | Not installed locally or in CI. npm scripts cover the same ground, and Node is where the code is heading. |
| lefthook / pre-commit | CI plus the PostToolUse lint hook cover it. Git hooks would also run inside the Selection Routine's commit. |
| devcontainer | Podman locally, and cloud sessions bring their own sandbox. |
| prettier / `ruff format` | The codebase isn't formatter-clean, so adopting one means a repo-wide reformat. That should be its own PR if wanted. |
| GitHub MCP | `gh` covers local work, and cloud sessions have a built-in GitHub proxy. |
| Context7 docs MCP | Unverified third party. The LSP plugins and package source cover API lookup. |

## Changing this setup
Keep the matrix above current. If a change touches `.claude/settings.json`, hooks, or `.mcp.json`,
walk it past the Routine safety rules. After merging, watch the next Sunday Selection run or trigger it
manually (SETUP.md §4).
