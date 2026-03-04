# gh-activity-viz

`gh-activity-viz` is a GitHub CLI extension that visualizes authored commit history with:

- 7-day heat row
- 4-week mini heatstamp (28 days by default)
- 28-day daily bar chart
- grouped counts by org and/or repo
- filters for org/repo/public-only/merge exclusion

No AI-style feature summarization is included. Output is grouped metrics + visuals.

## Install

From local path:

```bash
gh extension install /Users/dylangolow/workspace/dylangolow/gh-activity-viz
```

Then run as:

```bash
gh activity-viz --author dylangolow
```

## Usage

```bash
gh activity-viz [options]
```

Key options:

- `--author <login>`: GitHub user to analyze (default: authenticated user)
- `--days-summary <N>`: summary/grouping window (default `7`)
- `--days-chart <N>`: chart window (default `28`)
- `--end-date YYYY-MM-DD`: end date in UTC
- `--group-by org|repo|both`: choose grouped sections (default `both`)
- `--include-org a,b` / `--exclude-org a,b`
- `--include-repo owner/name` / `--exclude-repo owner/name`
- `--public-only`: hide private repos
- `--exclude-merges`: drop merge commits entirely
- `--top-repos <N>`: max repos in repo table (default `20`)
- `--format markdown|table|json`
- `--output <path>`

## Examples

Markdown report file:

```bash
gh activity-viz \
  --author dylangolow \
  --days-summary 7 \
  --days-chart 28 \
  --group-by both \
  --format markdown \
  --output context/github_activity.md
```

Repo-only grouping, table output:

```bash
gh activity-viz --group-by repo --format table
```

Filter to specific orgs:

```bash
gh activity-viz --include-org dylangolow,Conduit-BTC --group-by both
```

Public repos only, non-merge commits only:

```bash
gh activity-viz --public-only --exclude-merges --format json
```

## Notes

- Uses `gh api /search/commits` with the commit-search preview header.
- GitHub commit search may cap results near 1000 items for broad queries.
- For very high-volume windows, narrow by `--include-org`, `--include-repo`, or shorter date ranges.
