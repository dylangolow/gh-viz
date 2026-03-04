# gh-viz (`gh viz`)

Terminal commit activity explorer for GitHub CLI.

`gh-viz` uses your existing `gh` auth/session and supports:

- interactive TUI ranked activity preview with keyboard filters
- readable terminal table output (width-aware)
- markdown and JSON exports
- post-output action loop for interactive text sessions
- grouping by org, repo, or both
- org/repo include and exclude filters
- switch analyzed user by GitHub handle inside TUI
- refetch + save/load filter presets in TUI

No AI summarization is included. This focuses on commit history and grouped metrics.

## Install

Install directly from GitHub:

```bash
gh extension install dylangolow/gh-viz
```

If already installed:

```bash
gh extension upgrade viz
```

Install from local checkout (for development):

```bash
git clone git@github.com:dylangolow/gh-viz.git
cd gh-viz
gh extension install .
```

## Run

```bash
gh viz
```

If you run without args in an interactive terminal, startup prompts you for:

1. `Quick wizard (range, filters, visualization)`
2. `TUI`
3. `Text output (defaults)`

Use `↑/↓` to move selection and `Enter` to confirm (number keys `1/2/3` also work).

After text output completes in interactive startup mode, a next-action menu appears:

1. `Print again with current settings`
2. `Run wizard again (change filters/output)`
3. `Open TUI with current settings`
4. `Quit`

## What You Get

- summary window totals (commits, non-merge, repos, orgs)
- grouped org table
- grouped repo table
- markdown visuals:
  - 7-day heat row
  - 4-week mini heatstamp (28 days by default)
  - daily bar chart
- TUI panes:
  - large ranked preview pane (orgs + repos by commit share)
  - filter editor
  - 28-day intensity strip inside preview
  - refetch freshness indicator (`REQUIRED` when window needs older data)

## Options

- `--author <login>`: GitHub user to analyze (default: current `gh` user)
- `--mode <auto|text|tui>`: run mode (default `auto`)
- `--days-summary <n>`: summary/grouping window days (default `28`)
- `--days-chart <n>`: chart window days (default `28`)
- `--end-date YYYY-MM-DD`: end date in UTC
- `--group-by <org|repo|both>`: summary grouping (default `both`)
- `--include-org <a,b>` and `--exclude-org <a,b>`
- `--include-repo <owner/name>` and `--exclude-repo <owner/name>`
- `--public-only`: hide private repos
- `--exclude-merges`: remove merge commits
- `--top-repos <n>`: repo rows to keep (default `20`)
- `--format <auto|table|markdown|json>`
- `--viz <summary|heat|bars|heatstamp|all|json>`: choose visualization output
- `--output <path>`: write to file instead of stdout

## TUI Keys

- `Up/Down` or `j/k`: move in focused pane
- `Tab`: switch focus between preview and filters
- `u`: apply/refetch data for current filters
- `p`: print current table view to stdout and exit TUI
- `Enter`:
  - preview pane: select highlighted org/repo row (then `o` to open)
  - filters pane: apply/edit selected filter
- `Esc` (filters pane): clear selected filter
- `o`: open selected org/repo in browser
- `r`: reset all filters
- `q`: quit

TUI fetch model:
- filters do not auto-fetch on every move/edit
- adjust filters first, then press `u` or run the `Refetch data` filter action
- the `Refetch data` row shows `REQUIRED` when your current date window needs older data than what is cached
- this keeps navigation responsive and avoids fetch stalls while tuning

TUI color cues:
- active pane border/label is color-highlighted
- selected rows are color-highlighted as you move
- filter toggles show `ON` in green and `OFF` in red
- commit rows include per-day intensity color markers (`·░▒▓█`)

TUI diagnostics:
- default log file: `/tmp/gh-viz-tui.log`
- override log path: `GH_VIZ_TUI_LOG=/path/to/log gh viz --mode tui`
- cap fetched commits (to reduce memory/load): `GH_VIZ_MAX_COMMITS=400 gh viz --mode tui`

## Examples

Start interactive mode selector (`Quick wizard` / `TUI` / `Text defaults`):

```bash
gh viz
```

Open straight into TUI:

```bash
gh viz --mode tui
```

Table output for terminal:

```bash
gh viz --mode text --viz summary --days-summary 7 --days-chart 28 --format table
```

Heat row visualization:

```bash
gh viz --mode text --viz heat --days-summary 7 --days-chart 28 --format table
```

Bar chart visualization:

```bash
gh viz --mode text --viz bars --days-summary 7 --days-chart 28 --format table
```

Markdown report to file:

```bash
gh viz \
  --author dylangolow \
  --days-summary 7 \
  --days-chart 28 \
  --group-by both \
  --format markdown \
  --output context/github_activity.md
```

JSON for downstream tooling:

```bash
gh viz --viz json --group-by repo --public-only --exclude-merges --format json
```

Filter to specific orgs:

```bash
gh viz --include-org dylangolow,Conduit-BTC --group-by both
```

Filter to a specific repo and date window:

```bash
gh viz \
  --include-repo inklingdevelopers/inkling \
  --end-date 2026-03-04 \
  --days-summary 14 \
  --days-chart 28 \
  --format markdown
```

## Notes

- Data source: `gh api /search/commits` using the commit search preview header.
- GitHub commit search can cap broad queries around 1000 results.
- For high-volume windows, narrow with `--include-org`, `--include-repo`, or shorter day ranges.
