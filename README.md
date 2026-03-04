# gh-activity-viz (`gh activity-viz`)

Terminal commit activity explorer for GitHub CLI.

`gh-activity-viz` uses your existing `gh` auth/session and supports:

- interactive TUI commit browsing with keyboard filters
- readable terminal table output (width-aware)
- markdown and JSON exports
- grouping by org, repo, or both
- org/repo include and exclude filters

No AI summarization is included. This focuses on commit history and grouped metrics.

## Install

Install directly from GitHub:

```bash
gh extension install dylangolow/gh-activity-viz
```

If already installed:

```bash
gh extension upgrade activity-viz
```

Install from local checkout (for development):

```bash
git clone git@github.com:dylangolow/gh-activity-viz.git
cd gh-activity-viz
gh extension install .
```

## Run

```bash
gh activity-viz
```

If you run without args in an interactive terminal, startup prompts you for:

1. `TUI`
2. `Guided text output`
3. `Text output (defaults)`

## What You Get

- summary window totals (commits, non-merge, repos, orgs)
- grouped org table
- grouped repo table
- markdown visuals:
  - 7-day heat row
  - 4-week mini heatstamp (28 days by default)
  - daily bar chart
- TUI panes:
  - commit list
  - filter editor
  - selected commit details

## Options

- `--author <login>`: GitHub user to analyze (default: current `gh` user)
- `--mode <auto|text|tui>`: run mode (default `auto`)
- `--days-summary <n>`: summary/grouping window days (default `7`)
- `--days-chart <n>`: chart window days (default `28`)
- `--end-date YYYY-MM-DD`: end date in UTC
- `--group-by <org|repo|both>`: summary grouping (default `both`)
- `--include-org <a,b>` and `--exclude-org <a,b>`
- `--include-repo <owner/name>` and `--exclude-repo <owner/name>`
- `--public-only`: hide private repos
- `--exclude-merges`: remove merge commits
- `--top-repos <n>`: repo rows to keep (default `20`)
- `--format <auto|table|markdown|json>`
- `--output <path>`: write to file instead of stdout

## TUI Keys

- `Up/Down` or `j/k`: move in focused pane
- `Tab`: switch focus between commits and filters
- `Enter`:
  - commits pane: open selected commit in browser
  - filters pane: apply/edit selected filter
- `Esc` (filters pane): clear selected filter
- `o`: open selected commit in browser
- `r`: reset all filters
- `q`: quit

## Examples

Start interactive mode selector (`TUI` / `Guided text` / `Text defaults`):

```bash
gh activity-viz
```

Open straight into TUI:

```bash
gh activity-viz --mode tui
```

Table output for terminal:

```bash
gh activity-viz --mode text --days-summary 7 --days-chart 28 --format table
```

Markdown report to file:

```bash
gh activity-viz \
  --author dylangolow \
  --days-summary 7 \
  --days-chart 28 \
  --group-by both \
  --format markdown \
  --output context/github_activity.md
```

JSON for downstream tooling:

```bash
gh activity-viz --group-by repo --public-only --exclude-merges --format json
```

Filter to specific orgs:

```bash
gh activity-viz --include-org dylangolow,Conduit-BTC --group-by both
```

Filter to a specific repo and date window:

```bash
gh activity-viz \
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
