#!/usr/bin/env node

import blessed from "neo-blessed"
import { Command } from "commander"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import process from "node:process"
import * as readlineCore from "node:readline"
import readline from "node:readline/promises"

const ACCEPT_HEADER = "Accept: application/vnd.github.cloak-preview+json"

type GroupBy = "org" | "repo" | "both"
type Mode = "auto" | "text" | "tui"
type OutputFormat = "auto" | "markdown" | "table" | "json"
type Visualization = "summary" | "heat" | "bars" | "heatstamp" | "all" | "json"

interface RawOptions {
  author?: string
  mode: Mode
  daysSummary: number
  daysChart: number
  endDate?: string
  includeOrg: string[]
  excludeOrg: string[]
  includeRepo: string[]
  excludeRepo: string[]
  publicOnly: boolean
  excludeMerges: boolean
  topRepos: number
  groupBy: GroupBy
  format: OutputFormat
  viz: Visualization
  output?: string
}

interface CommitRecord {
  sha: string
  day: string
  dateTime: string
  repo: string
  org: string
  isPrivate: boolean
  subject: string
  isMerge: boolean
}

interface OrgSummary {
  org: string
  commits: number
  nonMerge: number
  repos: number
}

interface RepoSummary {
  repo: string
  org: string
  commits: number
  nonMerge: number
}

interface ActivityView {
  summaryStart: string
  chartStart: string
  summaryRecords: CommitRecord[]
  chartRecords: CommitRecord[]
  orgRows: OrgSummary[]
  repoRows: RepoSummary[]
}

interface TuiState {
  author: string
  endDate: Date
  daysSummary: number
  daysChart: number
  groupBy: GroupBy
  topRepos: number
  includeOrg: Set<string>
  excludeOrg: Set<string>
  includeRepo: Set<string>
  excludeRepo: Set<string>
  publicOnly: boolean
  excludeMerges: boolean
  fetchedSince?: string
  records: CommitRecord[]
  hasFetched: boolean
  isFetching: boolean
  totalCountHint?: number
  status: string
  statusError: boolean
}

function selectedIndex(list: blessed.Widgets.ListElement): number {
  const value = (list as blessed.Widgets.ListElement & { selected?: number }).selected
  return Math.max(0, value ?? 0)
}

function runGh(args: string[]): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown gh error").trim()
    throw new Error(detail)
  }
  return result.stdout
}

function sleepSync(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(arr, 0, 0, ms)
}

function isRetryableGhApiError(message: string): boolean {
  const text = message.toLowerCase()
  return (
    text.includes("http 500") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504") ||
    text.includes("bad gateway") ||
    text.includes("service unavailable") ||
    text.includes("gateway timeout")
  )
}

function getDefaultAuthor(): string {
  return runGh(["api", "user", "--jq", ".login"]).trim()
}

function resolveGitHubLogin(input: string): string {
  const candidate = input.trim().replace(/^@/, "")
  if (!candidate) {
    throw new Error("GitHub handle cannot be empty.")
  }

  const login = runGh(["api", `users/${candidate}`, "--jq", ".login"]).trim()
  if (!login) {
    throw new Error(`GitHub user not found: ${candidate}`)
  }
  return login
}

function splitValues(rawValues: string[]): Set<string> {
  const values = new Set<string>()
  for (const value of rawValues) {
    for (const part of value.split(",")) {
      const trimmed = part.trim()
      if (trimmed) values.add(trimmed)
    }
  }
  return values
}

function buildRecord(item: any): CommitRecord {
  const subject = String(item?.commit?.message || "").split("\n")[0] || ""
  const dateTime = String(item?.commit?.author?.date || "")
  const day = dateTime.slice(0, 10)

  return {
    sha: String(item?.sha || ""),
    day,
    dateTime,
    repo: String(item?.repository?.full_name || ""),
    org: String(item?.repository?.owner?.login || ""),
    isPrivate: Boolean(item?.repository?.private),
    subject,
    isMerge: subject.startsWith("Merge pull request") || subject.startsWith("Merge branch"),
  }
}

function fetchRecords(author: string, sinceDay: string): { records: CommitRecord[]; totalCountHint?: number } {
  const search = new URLSearchParams({
    q: `author:${author} author-date:>=${sinceDay}`,
    sort: "author-date",
    order: "desc",
    per_page: "100",
  }).toString()

  const endpoint = `/search/commits?${search}`
  let raw = ""
  let lastError = ""
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      raw = runGh(["api", "--paginate", "--slurp", "-H", ACCEPT_HEADER, endpoint])
      lastError = ""
      break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === maxAttempts || !isRetryableGhApiError(lastError)) {
        throw new Error(lastError)
      }
      const backoffMs = 500 * 2 ** (attempt - 1)
      sleepSync(backoffMs)
    }
  }

  const pages = JSON.parse(raw) as any[]

  const totalCountHint = pages?.[0]?.total_count
    ? Number(pages[0].total_count)
    : undefined

  const seen = new Set<string>()
  const records: CommitRecord[] = []

  for (const page of pages) {
    for (const item of page?.items ?? []) {
      const sha = String(item?.sha || "")
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      records.push(buildRecord(item))
    }
  }

  return { records, totalCountHint }
}

function inRange(day: string, startDay: string, endDay: string): boolean {
  return day >= startDay && day <= endDay
}

function filterRecords(records: CommitRecord[], filters: {
  includeOrg: Set<string>
  excludeOrg: Set<string>
  includeRepo: Set<string>
  excludeRepo: Set<string>
  publicOnly: boolean
  excludeMerges: boolean
}): CommitRecord[] {
  return records.filter(record => {
    if (filters.includeOrg.size > 0 && !filters.includeOrg.has(record.org)) return false
    if (filters.excludeOrg.has(record.org)) return false
    if (filters.includeRepo.size > 0 && !filters.includeRepo.has(record.repo)) return false
    if (filters.excludeRepo.has(record.repo)) return false
    if (filters.publicOnly && record.isPrivate) return false
    if (filters.excludeMerges && record.isMerge) return false
    return true
  })
}

function summarizeByOrg(records: CommitRecord[]): OrgSummary[] {
  const map = new Map<string, CommitRecord[]>()
  for (const record of records) {
    const arr = map.get(record.org) ?? []
    arr.push(record)
    map.set(record.org, arr)
  }

  const rows: OrgSummary[] = []
  for (const [org, items] of map.entries()) {
    rows.push({
      org,
      commits: items.length,
      nonMerge: items.filter(i => !i.isMerge).length,
      repos: new Set(items.map(i => i.repo)).size,
    })
  }

  rows.sort((a, b) => b.commits - a.commits || a.org.localeCompare(b.org))
  return rows
}

function summarizeByRepo(records: CommitRecord[]): RepoSummary[] {
  const map = new Map<string, CommitRecord[]>()
  for (const record of records) {
    const arr = map.get(record.repo) ?? []
    arr.push(record)
    map.set(record.repo, arr)
  }

  const rows: RepoSummary[] = []
  for (const [repo, items] of map.entries()) {
    rows.push({
      repo,
      org: items[0]?.org ?? "",
      commits: items.length,
      nonMerge: items.filter(i => !i.isMerge).length,
    })
  }

  rows.sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo))
  return rows
}

function isoDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  next.setUTCDate(next.getUTCDate() + delta)
  return next
}

function parseISODate(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw new Error("Date must be YYYY-MM-DD")
  const [, y, m, d] = match
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (isoDateUTC(parsed) !== value) throw new Error("Invalid date")
  return parsed
}

function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function buildActivityView(params: {
  records: CommitRecord[]
  endDate: Date
  daysSummary: number
  daysChart: number
  includeOrg: Set<string>
  excludeOrg: Set<string>
  includeRepo: Set<string>
  excludeRepo: Set<string>
  publicOnly: boolean
  excludeMerges: boolean
}): ActivityView {
  const summaryStart = addDays(params.endDate, -(params.daysSummary - 1))
  const chartStart = addDays(params.endDate, -(params.daysChart - 1))
  const endDay = isoDateUTC(params.endDate)

  const filtered = filterRecords(params.records, {
    includeOrg: params.includeOrg,
    excludeOrg: params.excludeOrg,
    includeRepo: params.includeRepo,
    excludeRepo: params.excludeRepo,
    publicOnly: params.publicOnly,
    excludeMerges: params.excludeMerges,
  })

  const summaryRecords = filtered.filter(r => inRange(r.day, isoDateUTC(summaryStart), endDay))
  const chartRecords = filtered.filter(r => inRange(r.day, isoDateUTC(chartStart), endDay))

  return {
    summaryStart: isoDateUTC(summaryStart),
    chartStart: isoDateUTC(chartStart),
    summaryRecords,
    chartRecords,
    orgRows: summarizeByOrg(summaryRecords),
    repoRows: summarizeByRepo(summaryRecords),
  }
}

function intensitySymbol(count: number): string {
  if (count === 0) return "·"
  if (count <= 4) return "░"
  if (count <= 19) return "▒"
  if (count <= 59) return "▓"
  return "█"
}

function intensityColoredSymbol(count: number): string {
  if (count === 0) return "{gray-fg}·{/}"
  if (count <= 4) return "{cyan-fg}░{/}"
  if (count <= 19) return "{green-fg}▒{/}"
  if (count <= 59) return "{light-green-fg}▓{/}"
  return "{white-fg}█{/}"
}

function dateRange(start: Date, end: Date): Date[] {
  const out: Date[] = []
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    out.push(new Date(d))
  }
  return out
}

function terminalWidth(defaultWidth = 120): number {
  if (!process.stdout.isTTY) return defaultWidth
  return process.stdout.columns || defaultWidth
}

function ellipsize(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return text.slice(0, maxWidth)
  if (text.length <= maxWidth) return text
  return text.slice(0, maxWidth - 1) + "…"
}

function renderAsciiTable(headers: string[], rows: string[][]): string {
  const widths = headers.map(h => h.length)
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length)
    })
  }

  const renderRow = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i], " ")).join(" | ")
  const separator = widths.map(w => "-".repeat(w)).join("-+-")

  const lines = [renderRow(headers), separator]
  for (const row of rows) lines.push(renderRow(row))
  return lines.join("\n")
}

function resolveOutputFormat(requested: OutputFormat, outputPath?: string): Exclude<OutputFormat, "auto"> {
  if (requested !== "auto") return requested

  if (outputPath) {
    const lower = outputPath.toLowerCase()
    if (lower.endsWith(".json")) return "json"
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown"
    return "table"
  }

  if (process.stdout.isTTY) return "table"
  return "markdown"
}

function renderMarkdown(params: {
  author: string
  generatedAt: string
  view: ActivityView
  totalCountHint?: number
  groupBy: GroupBy
  topRepos: number
  daysSummary: number
  daysChart: number
  viz: Visualization
  endDate: Date
}): string {
  const chartStart = parseISODate(params.view.chartStart)
  const endDate = params.endDate
  const chartDates = dateRange(chartStart, endDate)
  const chartCounts = new Map<string, number>()
  for (const record of params.view.chartRecords) {
    chartCounts.set(record.day, (chartCounts.get(record.day) ?? 0) + 1)
  }

  const heatDays = Math.min(7, params.daysSummary)
  const heatStart = addDays(endDate, -(heatDays - 1))
  const heatDates = dateRange(heatStart, endDate)

  const maxCount = Math.max(0, ...chartDates.map(d => chartCounts.get(isoDateUTC(d)) ?? 0))

  const dailyLines = heatDates.map(d => `- \`${isoDateUTC(d)}\`: ${chartCounts.get(isoDateUTC(d)) ?? 0}`)
  const heatHeader = heatDates.map(d => d.toISOString().slice(5, 10)).join(" | ")
  const heatCells = heatDates.map(d => `\`${intensitySymbol(chartCounts.get(isoDateUTC(d)) ?? 0)}\``).join(" | ")

  const weekChunks: Date[][] = []
  for (let i = 0; i < chartDates.length; i += 7) {
    weekChunks.push(chartDates.slice(i, i + 7))
  }

  const weekdayHeaders = (weekChunks[0] ?? []).map(d => d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }))
  const heatstampLines: string[] = []
  heatstampLines.push(`| Week | ${weekdayHeaders.join(" | ")} |`)
  heatstampLines.push(`| ${["---", ...weekdayHeaders.map(() => "---")].join(" | ")} |`)
  weekChunks.forEach((chunk, i) => {
    const label = `W${i + 1} (${chunk[0]!.toISOString().slice(5, 10)}..${chunk[chunk.length - 1]!.toISOString().slice(5, 10)})`
    const cells = chunk.map(d => `\`${intensitySymbol(chartCounts.get(isoDateUTC(d)) ?? 0)}\``)
    heatstampLines.push(`| ${label} | ${cells.join(" | ")} |`)
  })

  const barLines = chartDates.map(d => {
    const day = isoDateUTC(d)
    const count = chartCounts.get(day) ?? 0
    const bar = count === 0
      ? "·"
      : "█".repeat(Math.max(1, Math.round((count / Math.max(1, maxCount)) * 24)))
    return `${day} | ${String(count).padStart(3, " ")} | ${bar}`
  })

  const orgTable = [
    "| Org | Commits | Non-merge | Repos |",
    "|---|---:|---:|---:|",
    ...params.view.orgRows.map(row => `| \`${row.org}\` | ${row.commits} | ${row.nonMerge} | ${row.repos} |`),
  ]

  const repoTable = [
    "| Repo | Commits | Non-merge |",
    "|---|---:|---:|",
    ...params.view.repoRows.slice(0, params.topRepos).map(row => `| \`${row.repo}\` | ${row.commits} | ${row.nonMerge} |`),
  ]

  const sections: string[] = [
    `# GitHub Activity Summary (${params.view.summaryStart} to ${isoDateUTC(endDate)})`,
    "",
    `- Report generated: ${params.generatedAt}`,
    `- Author: \`${params.author}\``,
    "- Source: `gh api /search/commits` (authored commits)",
    `- Summary window (org/repo tables): \`${params.view.summaryStart}\` → \`${isoDateUTC(endDate)}\``,
    "- Chart windows:",
    `  - Heat row: \`${isoDateUTC(heatStart)}\` → \`${isoDateUTC(endDate)}\``,
    `  - Heatstamp + bar chart: \`${params.view.chartStart}\` → \`${isoDateUTC(endDate)}\``,
    "",
    "## Totals",
    "",
    `- Authored commits found (summary window): **${params.view.summaryRecords.length}**`,
    `- Non-merge commits (summary window): **${params.view.summaryRecords.filter(r => !r.isMerge).length}**`,
    `- Unique repos (summary window): **${new Set(params.view.summaryRecords.map(r => r.repo)).size}**`,
    `- Orgs (summary window): **${new Set(params.view.summaryRecords.map(r => r.org)).size}**`,
  ]

  if ((params.totalCountHint ?? 0) >= 1000) {
    sections.push(
      "",
      "> Warning: GitHub commit search may cap results at 1000 for broad queries. Narrow by org/repo/date if needed.",
    )
  }

  const showHeat = params.viz === "heat" || params.viz === "all"
  const showHeatstamp = params.viz === "heatstamp" || params.viz === "all"
  const showBars = params.viz === "bars" || params.viz === "all"
  const showTables = params.viz === "summary" || params.viz === "all"

  if (showHeat || showHeatstamp || showBars) {
    sections.push("", "## Visuals", "")
  }

  if (showHeat) {
    sections.push(
      "Daily commit counts in heat-row window:",
      "",
      ...dailyLines,
      "",
      "Intensity buckets:",
      "",
      "- `·` = 0",
      "- `░` = 1-4",
      "- `▒` = 5-19",
      "- `▓` = 20-59",
      "- `█` = 60+",
      "",
      "Heat row:",
      "",
      `| ${heatHeader} |`,
      `| ${heatDates.map(() => "---").join(" | ")} |`,
      `| ${heatCells} |`,
      "",
    )
  }

  if (showHeatstamp) {
    sections.push(
      `Mini heatstamp (${params.daysChart}-day window):`,
      "",
      ...heatstampLines,
      "",
    )
  }

  if (showBars) {
    sections.push(
      `Bar chart (${params.daysChart}-day window, scaled to max day = ${maxCount}):`,
      "",
      "```text",
      ...barLines,
      "```",
      "",
    )
  }

  if (showTables && (params.groupBy === "both" || params.groupBy === "org")) {
    sections.push(
      `## By Org (${params.view.summaryStart} → ${isoDateUTC(endDate)})`,
      "",
      ...orgTable,
      "",
    )
  }

  if (showTables && (params.groupBy === "both" || params.groupBy === "repo")) {
    sections.push(
      `## By Project (Top ${params.topRepos}, ${params.view.summaryStart} → ${isoDateUTC(endDate)})`,
      "",
      ...repoTable,
      "",
    )
  }

  return sections.join("\n")
}

function renderTableOutput(params: {
  author: string
  view: ActivityView
  groupBy: GroupBy
  topRepos: number
  daysSummary: number
  daysChart: number
  viz: Visualization
  endDate: Date
}): string {
  const width = terminalWidth()
  const lines: string[] = []
  lines.push(`Author: ${params.author}`)
  lines.push(`Summary window: ${params.view.summaryStart} -> ${isoDateUTC(params.endDate)}`)
  lines.push("")
  lines.push(
    `Totals: commits=${params.view.summaryRecords.length}, non_merge=${params.view.summaryRecords.filter(r => !r.isMerge).length}, repos=${new Set(params.view.summaryRecords.map(r => r.repo)).size}, orgs=${new Set(params.view.summaryRecords.map(r => r.org)).size}`,
  )
  lines.push("")

  const chartStart = parseISODate(params.view.chartStart)
  const chartDates = dateRange(chartStart, params.endDate)
  const chartCounts = new Map<string, number>()
  for (const record of params.view.chartRecords) {
    chartCounts.set(record.day, (chartCounts.get(record.day) ?? 0) + 1)
  }
  const maxCount = Math.max(0, ...chartDates.map(d => chartCounts.get(isoDateUTC(d)) ?? 0))

  const heatDays = Math.min(7, params.daysSummary)
  const heatStart = addDays(params.endDate, -(heatDays - 1))
  const heatDates = dateRange(heatStart, params.endDate)

  const showHeat = params.viz === "heat" || params.viz === "all"
  const showHeatstamp = params.viz === "heatstamp" || params.viz === "all"
  const showBars = params.viz === "bars" || params.viz === "all"
  const showTables = params.viz === "summary" || params.viz === "all"

  if (showHeat) {
    lines.push(`Heat Row (${isoDateUTC(heatStart)} -> ${isoDateUTC(params.endDate)})`)
    lines.push(heatDates.map(d => d.toISOString().slice(5, 10)).join(" "))
    lines.push(heatDates.map(d => intensitySymbol(chartCounts.get(isoDateUTC(d)) ?? 0)).join("  "))
    lines.push("Legend: ·=0 ░=1-4 ▒=5-19 ▓=20-59 █=60+")
    lines.push("")
  }

  if (showHeatstamp) {
    const weekChunks: Date[][] = []
    for (let i = 0; i < chartDates.length; i += 7) {
      weekChunks.push(chartDates.slice(i, i + 7))
    }
    const weekdayHeaders = (weekChunks[0] ?? []).map(d => d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }))
    const rows = weekChunks.map((chunk, i) => {
      const label = `W${i + 1} (${chunk[0]!.toISOString().slice(5, 10)}..${chunk[chunk.length - 1]!.toISOString().slice(5, 10)})`
      return [label, ...chunk.map(d => intensitySymbol(chartCounts.get(isoDateUTC(d)) ?? 0))]
    })
    lines.push(`Mini Heatstamp (${params.daysChart}-day window)`)
    lines.push(renderAsciiTable(["Week", ...weekdayHeaders], rows))
    lines.push("")
  }

  if (showBars) {
    const barWidth = Math.max(8, Math.min(36, width - 24))
    lines.push(`Bar Chart (${params.daysChart}-day window, max day=${maxCount})`)
    chartDates.forEach(d => {
      const day = isoDateUTC(d)
      const count = chartCounts.get(day) ?? 0
      const bar = count === 0
        ? "·"
        : "█".repeat(Math.max(1, Math.round((count / Math.max(1, maxCount)) * barWidth)))
      lines.push(`${day} | ${String(count).padStart(3, " ")} | ${bar}`)
    })
    lines.push("")
  }

  if (showTables && (params.groupBy === "both" || params.groupBy === "org")) {
    const orgColWidth = Math.max(12, Math.min(36, width - 35))
    const rows = params.view.orgRows.map(r => [
      ellipsize(r.org, orgColWidth),
      String(r.commits),
      String(r.nonMerge),
      String(r.repos),
    ])
    lines.push("By Org")
    lines.push(renderAsciiTable(["Org", "Commits", "Non-merge", "Repos"], rows))
    lines.push("")
  }

  if (showTables && (params.groupBy === "both" || params.groupBy === "repo")) {
    const repoColWidth = Math.max(24, Math.min(72, width - 28))
    const rows = params.view.repoRows.slice(0, params.topRepos).map(r => [
      ellipsize(r.repo, repoColWidth),
      String(r.commits),
      String(r.nonMerge),
    ])
    lines.push(`By Project (Top ${params.topRepos})`)
    lines.push(renderAsciiTable(["Repo", "Commits", "Non-merge"], rows))
  }

  return lines.join("\n") + "\n"
}

async function ask(prompt: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` [${defaultValue}]` : ""
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim()
  rl.close()
  return answer || defaultValue
}

async function askInt(prompt: string, defaultValue: number, minimum = 1): Promise<number> {
  while (true) {
    const raw = await ask(prompt, String(defaultValue))
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed >= minimum) return parsed
    console.log(`Enter an integer >= ${minimum}.`)
  }
}

async function selectFromMenu<T extends string>(
  prompt: string,
  items: Array<{ value: T; label: string }>,
  defaultValue: T,
): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultValue
  }

  let selected = Math.max(0, items.findIndex(i => i.value === defaultValue))
  if (selected < 0) selected = 0
  const maxLabelLen = Math.max(...items.map((item, i) => `${i + 1}) ${item.label}`.length))
  const headerText = `${prompt} (↑/↓, Enter)`
  const innerWidth = Math.max(maxLabelLen + 6, headerText.length + 2, 24)
  const totalLines = items.length + 4

  const drawMenu = (firstRender: boolean): void => {
    if (!firstRender) {
      process.stdout.write(`\x1B[${totalLines}A`)
    }

    process.stdout.write(`\x1B[2K\r┌${"─".repeat(innerWidth)}┐\n`)
    process.stdout.write(`\x1B[2K\r│ ${headerText.padEnd(innerWidth - 2, " ")} │\n`)
    process.stdout.write(`\x1B[2K\r├${"─".repeat(innerWidth)}┤\n`)
    items.forEach((item, i) => {
      const text = `${i + 1}) ${item.label}`.padEnd(innerWidth - 4, " ")
      if (i === selected) {
        process.stdout.write(`\x1B[2K\r│ \x1B[30;46m❯ ${text}\x1B[0m │\n`)
      } else {
        process.stdout.write(`\x1B[2K\r│   ${text} │\n`)
      }
    })
    process.stdout.write(`\x1B[2K\r└${"─".repeat(innerWidth)}┘\n`)
  }

  drawMenu(true)
  readlineCore.emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw ?? false
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return await new Promise<T>(resolve => {
    const onKeypress = (str: string, key: readlineCore.Key): void => {
      if (key.name === "up") {
        selected = (selected - 1 + items.length) % items.length
        drawMenu(false)
        return
      }

      if (key.name === "down") {
        selected = (selected + 1) % items.length
        drawMenu(false)
        return
      }

      if (/^[1-9]$/.test(str)) {
        const idx = Number(str) - 1
        if (idx >= 0 && idx < items.length) {
          selected = idx
          drawMenu(false)
        }
        return
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(items[selected]!.value)
        return
      }

      if (key.ctrl && key.name === "c") {
        cleanup()
        process.exit(1)
      }
    }

    const cleanup = (): void => {
      process.stdin.off("keypress", onKeypress)
      if (!wasRaw) process.stdin.setRawMode(false)
      process.stdin.resume()
    }

    process.stdin.on("keypress", onKeypress)
  })
}

async function askBool(prompt: string, defaultValue: boolean): Promise<boolean> {
  const picked = await selectFromMenu(
    prompt,
    [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    defaultValue ? "yes" : "no",
  )
  return picked === "yes"
}

async function askChoice<T extends string>(prompt: string, choices: readonly T[], defaultValue: T): Promise<T> {
  const items = choices.map(choice => ({ value: choice, label: String(choice) }))
  return await selectFromMenu(prompt, items, defaultValue)
}

async function chooseStartupMode(): Promise<"tui" | "guided-text" | "text"> {
  return await selectFromMenu(
    "Select mode",
    [
      { value: "guided-text", label: "Quick wizard (range, filters, visualization)" },
      { value: "tui", label: "TUI (interactive browser)" },
      { value: "text", label: "Text output (defaults)" },
    ],
    "guided-text",
  )
}

async function choosePostTextAction(): Promise<"print-again" | "wizard" | "tui" | "quit"> {
  return await selectFromMenu(
    "Next action",
    [
      { value: "print-again", label: "Print again with current settings" },
      { value: "wizard", label: "Run wizard again (change filters/output)" },
      { value: "tui", label: "Open TUI with current settings" },
      { value: "quit", label: "Quit" },
    ],
    "print-again",
  )
}

async function runTextWizard(options: RawOptions): Promise<RawOptions> {
  const author = options.author || getDefaultAuthor()
  console.log("Quick setup wizard")

  while (true) {
    const input = await ask("Author (GitHub handle)", author)
    try {
      options.author = resolveGitHubLogin(input)
      break
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.log(msg)
    }
  }

  const range = await askChoice(
    "Time range",
    ["7d", "14d", "28d", "90d", "custom"] as const,
    "28d",
  )
  if (range === "custom") {
    const customDays = await askInt("Range days", options.daysChart, 1)
    options.daysSummary = customDays
    options.daysChart = customDays
  } else {
    const days = Number(range.replace("d", ""))
    options.daysSummary = days
    options.daysChart = days
  }

  const endDateMode = await askChoice(
    "End date",
    ["today", "custom"] as const,
    options.endDate ? "custom" : "today",
  )
  if (endDateMode === "custom") {
    while (true) {
      const endDate = await ask("End date UTC (YYYY-MM-DD)", options.endDate || "")
      try {
        parseISODate(endDate)
        options.endDate = endDate
        break
      } catch {
        console.log("Date must be YYYY-MM-DD")
      }
    }
  } else {
    options.endDate = undefined
  }

  options.groupBy = await askChoice(
    "Group output by",
    ["both", "org", "repo"] as const,
    options.groupBy,
  )

  const orgFilterMode = await askChoice(
    "Org filters",
    ["none", "include", "exclude", "include+exclude"] as const,
    options.includeOrg.length > 0 && options.excludeOrg.length > 0
      ? "include+exclude"
      : options.includeOrg.length > 0
        ? "include"
        : options.excludeOrg.length > 0
          ? "exclude"
          : "none",
  )
  options.includeOrg = []
  options.excludeOrg = []
  if (orgFilterMode === "include" || orgFilterMode === "include+exclude") {
    const includeOrg = await ask("Include orgs (comma-separated)", options.includeOrg.join(","))
    options.includeOrg = includeOrg ? [includeOrg] : []
  }
  if (orgFilterMode === "exclude" || orgFilterMode === "include+exclude") {
    const excludeOrg = await ask("Exclude orgs (comma-separated)", options.excludeOrg.join(","))
    options.excludeOrg = excludeOrg ? [excludeOrg] : []
  }

  const repoFilterMode = await askChoice(
    "Repo filters",
    ["none", "include", "exclude", "include+exclude"] as const,
    options.includeRepo.length > 0 && options.excludeRepo.length > 0
      ? "include+exclude"
      : options.includeRepo.length > 0
        ? "include"
        : options.excludeRepo.length > 0
          ? "exclude"
          : "none",
  )
  options.includeRepo = []
  options.excludeRepo = []
  if (repoFilterMode === "include" || repoFilterMode === "include+exclude") {
    const includeRepo = await ask("Include repos owner/name (comma-separated)", options.includeRepo.join(","))
    options.includeRepo = includeRepo ? [includeRepo] : []
  }
  if (repoFilterMode === "exclude" || repoFilterMode === "include+exclude") {
    const excludeRepo = await ask("Exclude repos owner/name (comma-separated)", options.excludeRepo.join(","))
    options.excludeRepo = excludeRepo ? [excludeRepo] : []
  }

  options.publicOnly = await askBool("Public repos only", options.publicOnly)
  options.excludeMerges = await askBool("Exclude merge commits", options.excludeMerges)

  const defaultTopRepos = [10, 20, 50].includes(options.topRepos) ? String(options.topRepos) : "20"
  const topReposChoice = await askChoice("Top repos in tables", ["10", "20", "50", "custom"] as const, defaultTopRepos as "10" | "20" | "50" | "custom")
  if (topReposChoice === "custom") {
    options.topRepos = await askInt("Top repos to show", options.topRepos, 1)
  } else {
    options.topRepos = Number(topReposChoice)
  }

  options.viz = await askChoice(
    "Visualization",
    ["summary", "heat", "bars", "heatstamp", "all", "json"] as const,
    options.viz,
  )

  if (options.viz === "json") {
    options.format = "json"
  } else {
    options.format = "auto"
  }

  const outputMode = await askChoice(
    "Output destination",
    ["stdout", "file"] as const,
    options.output ? "file" : "stdout",
  )
  if (outputMode === "file") {
    const defaultName = options.output || (options.viz === "json" ? "gh-viz.json" : "gh-viz.md")
    const outputPath = await ask("Output file path", defaultName)
    options.output = outputPath || undefined
  } else {
    options.output = undefined
  }

  return options
}

function formatSet(values: Set<string>): string {
  if (values.size === 0) return "(none)"
  const arr = [...values].sort()
  if (arr.length <= 2) return arr.join(", ")
  return `${arr[0]}, ${arr[1]} +${arr.length - 2}`
}

function colorizeFilterValue(label: string, value: string): string {
  if (label === "Author") {
    return `{yellow-fg}${value}{/}`
  }
  if (label === "Public only" || label === "Exclude merges") {
    return value === "ON" ? "{green-fg}ON{/}" : "{red-fg}OFF{/}"
  }
  if (label === "Refetch data" || label === "Save preset" || label === "Load preset" || label === "Reset filters" || label === "Export markdown") {
    return "{yellow-fg}Enter{/}"
  }
  if (value === "(none)") {
    return "{gray-fg}(none){/}"
  }
  return `{cyan-fg}${value}{/}`
}

function filterRows(state: TuiState): Array<[string, string]> {
  return [
    ["Author", state.author],
    ["End date (UTC)", isoDateUTC(state.endDate)],
    ["Summary days", String(state.daysSummary)],
    ["Chart days", String(state.daysChart)],
    ["Group by", state.groupBy],
    ["Include orgs", formatSet(state.includeOrg)],
    ["Exclude orgs", formatSet(state.excludeOrg)],
    ["Include repos", formatSet(state.includeRepo)],
    ["Exclude repos", formatSet(state.excludeRepo)],
    ["Public only", state.publicOnly ? "ON" : "OFF"],
    ["Exclude merges", state.excludeMerges ? "ON" : "OFF"],
    ["Top repos", String(state.topRepos)],
    ["Refetch data", "Enter"],
    ["Save preset", "Enter"],
    ["Load preset", "Enter"],
    ["Reset filters", "Enter"],
    ["Export markdown", "Enter"],
  ]
}

function setStatus(state: TuiState, message: string, error = false): void {
  state.status = message
  state.statusError = error
}

function ensureTuiData(state: TuiState): void {
  const neededSince = isoDateUTC(addDays(state.endDate, -(Math.max(state.daysSummary, state.daysChart) - 1)))
  if (state.records.length > 0 && state.fetchedSince && neededSince >= state.fetchedSince) {
    return
  }

  const { records, totalCountHint } = fetchRecords(state.author, neededSince)
  state.records = records
  state.totalCountHint = totalCountHint
  state.fetchedSince = neededSince
  setStatus(state, `Loaded ${records.length} commits for @${state.author} since ${neededSince}.`)
}

async function runTui(options: RawOptions): Promise<number> {
  const author = options.author || getDefaultAuthor()

  const state: TuiState = {
    author,
    endDate: options.endDate ? parseISODate(options.endDate) : todayUTC(),
    daysSummary: options.daysSummary,
    daysChart: options.daysChart,
    groupBy: options.groupBy,
    topRepos: options.topRepos,
    includeOrg: splitValues(options.includeOrg),
    excludeOrg: splitValues(options.excludeOrg),
    includeRepo: splitValues(options.includeRepo),
    excludeRepo: splitValues(options.excludeRepo),
    publicOnly: options.publicOnly,
    excludeMerges: options.excludeMerges,
    records: [],
    hasFetched: false,
    isFetching: false,
    status: "Adjust filters, then press 'u' or choose Refetch data.",
    statusError: false,
  }

  const screen = blessed.screen({ smartCSR: true, title: "gh viz" })
  const prompt = blessed.prompt({
    parent: screen,
    border: "line",
    height: 7,
    width: "70%",
    top: "center",
    left: "center",
    label: " Input ",
    keys: true,
    vi: true,
    hidden: true,
  })

  const header = blessed.box({ top: 0, left: 0, width: "100%", height: 1, tags: false, style: { bold: true } })
  const summary = blessed.box({ top: 1, left: 0, width: "100%", height: 1 })
  const preview = blessed.box({ top: 2, left: 0, width: "100%", height: 1, tags: true })
  const commitsLabel = blessed.box({ top: 3, left: 0, width: "66%", height: 1, content: "Commits (chart window)", style: { underline: true } })
  const filtersLabel = blessed.box({ top: 3, left: "66%", width: "34%", height: 1, content: "Filters", style: { underline: true } })

  const commitsList = blessed.list({
    top: 4,
    left: 0,
    width: "66%",
    bottom: 3,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    border: "line",
    style: {
      border: { fg: "gray" },
      selected: { bg: "blue", fg: "white", bold: true },
    },
  })

  const filtersList = blessed.list({
    top: 4,
    left: "66%",
    width: "34%",
    bottom: 3,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    border: "line",
    style: {
      border: { fg: "gray" },
      selected: { bg: "magenta", fg: "white", bold: true },
    },
  })

  const detail = blessed.box({ top: "100%-3", left: 0, width: "100%", height: 1 })
  const status = blessed.box({ top: "100%-2", left: 0, width: "100%", height: 1 })
  const help = blessed.box({
    top: "100%-1",
    left: 0,
    width: "100%",
    height: 1,
    content: "Keys: Up/Down move, Tab pane, v visuals/commits, Enter select, u fetch/apply, Esc clear, o open, r reset, q quit",
  })

  screen.append(header)
  screen.append(summary)
  screen.append(preview)
  screen.append(commitsLabel)
  screen.append(filtersLabel)
  screen.append(commitsList)
  screen.append(filtersList)
  screen.append(detail)
  screen.append(status)
  screen.append(help)

  let focus: "commits" | "filters" = "commits"
  let currentView: ActivityView = {
    summaryStart: isoDateUTC(addDays(state.endDate, -(state.daysSummary - 1))),
    chartStart: isoDateUTC(addDays(state.endDate, -(state.daysChart - 1))),
    summaryRecords: [],
    chartRecords: [],
    orgRows: [],
    repoRows: [],
  }
  let visibleCommits: CommitRecord[] = []

  const askInTui = (question: string, initial = ""): Promise<string | null> => {
    return new Promise(resolve => {
      prompt.input(question, initial, (_err: Error | null, value: string | null) => {
        const next = value?.trim() || ""
        resolve(next ? next : null)
      })
      screen.render()
    })
  }

  const runFetch = (): void => {
    const neededSince = isoDateUTC(addDays(state.endDate, -(Math.max(state.daysSummary, state.daysChart) - 1)))
    try {
      setStatus(state, `Fetching @${state.author} since ${neededSince}...`)
      const { records, totalCountHint } = fetchRecords(state.author, neededSince)
      state.records = records
      state.totalCountHint = totalCountHint
      state.fetchedSince = neededSince
      state.hasFetched = true
      setStatus(state, `Loaded ${records.length} commits for @${state.author} since ${neededSince}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(state, `Fetch failed: ${message}`, true)
    }
  }

  const applyFilter = async (index: number): Promise<void> => {
    if (index === 0) {
      const raw = await askInTui("GitHub handle (blank keeps current)", state.author)
      if (!raw) return
      try {
        const login = resolveGitHubLogin(raw)
        state.author = login
        state.records = []
        state.hasFetched = false
        state.fetchedSince = undefined
        state.totalCountHint = undefined
        setStatus(state, `Author set to @${login}. Press 'u' to fetch.`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setStatus(state, msg, true)
      }
      return
    }

    if (index === 1) {
      const raw = await askInTui("End date YYYY-MM-DD (blank=today)", isoDateUTC(state.endDate))
      if (!raw) {
        state.endDate = todayUTC()
      } else {
        try {
          state.endDate = parseISODate(raw)
        } catch {
          setStatus(state, "Invalid date format.", true)
          return
        }
      }
      setStatus(state, "End date updated. Press 'u' to fetch.")
      return
    }

    if (index === 2) {
      const raw = await askInTui("Summary days", String(state.daysSummary))
      if (!raw) return
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setStatus(state, "Summary days must be >= 1.", true)
        return
      }
      state.daysSummary = parsed
      setStatus(state, "Summary days updated. Press 'u' to fetch.")
      return
    }

    if (index === 3) {
      const raw = await askInTui("Chart days", String(state.daysChart))
      if (!raw) return
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setStatus(state, "Chart days must be >= 1.", true)
        return
      }
      state.daysChart = parsed
      setStatus(state, "Chart days updated. Press 'u' to fetch.")
      return
    }

    if (index === 4) {
      state.groupBy = state.groupBy === "both" ? "org" : state.groupBy === "org" ? "repo" : "both"
      setStatus(state, `Group by set to ${state.groupBy}.`)
      return
    }

    if (index >= 5 && index <= 8) {
      const label = [
        "Include orgs (comma-separated)",
        "Exclude orgs (comma-separated)",
        "Include repos owner/name (comma-separated)",
        "Exclude repos owner/name (comma-separated)",
      ][index - 5]
      const existing = [state.includeOrg, state.excludeOrg, state.includeRepo, state.excludeRepo][index - 5]
      const raw = await askInTui(label, [...existing].sort().join(","))
      const values = raw ? splitValues([raw]) : new Set<string>()
      if (index === 5) state.includeOrg = values
      if (index === 6) state.excludeOrg = values
      if (index === 7) state.includeRepo = values
      if (index === 8) state.excludeRepo = values
      setStatus(state, "Filter updated. Press 'u' to fetch.")
      return
    }

    if (index === 9) {
      state.publicOnly = !state.publicOnly
      setStatus(state, `Public only ${state.publicOnly ? "ON" : "OFF"}. Press 'u' to fetch.`)
      return
    }

    if (index === 10) {
      state.excludeMerges = !state.excludeMerges
      setStatus(state, `Exclude merges ${state.excludeMerges ? "ON" : "OFF"}. Press 'u' to fetch.`)
      return
    }

    if (index === 11) {
      const raw = await askInTui("Top repos count", String(state.topRepos))
      if (!raw) return
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setStatus(state, "Top repos must be >= 1.", true)
        return
      }
      state.topRepos = parsed
      setStatus(state, "Top repos updated.")
      return
    }

    if (index === 12) {
      runFetch()
      return
    }

    if (index === 13) {
      const path = await askInTui("Save preset path", "gh-viz.filters.json")
      if (!path) {
        setStatus(state, "Save canceled.")
        return
      }
      const preset = {
        author: state.author,
        endDate: isoDateUTC(state.endDate),
        daysSummary: state.daysSummary,
        daysChart: state.daysChart,
        groupBy: state.groupBy,
        topRepos: state.topRepos,
        includeOrg: [...state.includeOrg].sort(),
        excludeOrg: [...state.excludeOrg].sort(),
        includeRepo: [...state.includeRepo].sort(),
        excludeRepo: [...state.excludeRepo].sort(),
        publicOnly: state.publicOnly,
        excludeMerges: state.excludeMerges,
      }
      fs.writeFileSync(path, `${JSON.stringify(preset, null, 2)}\n`, "utf8")
      setStatus(state, `Saved preset ${path}`)
      return
    }

    if (index === 14) {
      const path = await askInTui("Load preset path", "gh-viz.filters.json")
      if (!path) {
        setStatus(state, "Load canceled.")
        return
      }
      try {
        const raw = fs.readFileSync(path, "utf8")
        const preset = JSON.parse(raw) as Record<string, unknown>

        if (typeof preset.author === "string" && preset.author.trim()) {
          state.author = resolveGitHubLogin(preset.author)
        }
        if (typeof preset.endDate === "string" && preset.endDate.trim()) {
          state.endDate = parseISODate(preset.endDate)
        }
        if (typeof preset.daysSummary === "number" && Number.isInteger(preset.daysSummary) && preset.daysSummary >= 1) {
          state.daysSummary = preset.daysSummary
        }
        if (typeof preset.daysChart === "number" && Number.isInteger(preset.daysChart) && preset.daysChart >= 1) {
          state.daysChart = preset.daysChart
        }
        if (preset.groupBy === "both" || preset.groupBy === "org" || preset.groupBy === "repo") {
          state.groupBy = preset.groupBy
        }
        if (typeof preset.topRepos === "number" && Number.isInteger(preset.topRepos) && preset.topRepos >= 1) {
          state.topRepos = preset.topRepos
        }
        if (Array.isArray(preset.includeOrg)) state.includeOrg = splitValues(preset.includeOrg.map(String))
        if (Array.isArray(preset.excludeOrg)) state.excludeOrg = splitValues(preset.excludeOrg.map(String))
        if (Array.isArray(preset.includeRepo)) state.includeRepo = splitValues(preset.includeRepo.map(String))
        if (Array.isArray(preset.excludeRepo)) state.excludeRepo = splitValues(preset.excludeRepo.map(String))
        if (typeof preset.publicOnly === "boolean") state.publicOnly = preset.publicOnly
        if (typeof preset.excludeMerges === "boolean") state.excludeMerges = preset.excludeMerges

        state.records = []
        state.hasFetched = false
        state.fetchedSince = undefined
        state.totalCountHint = undefined
        setStatus(state, `Loaded preset ${path}. Press 'u' to fetch.`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setStatus(state, `Load failed: ${msg}`, true)
      }
      return
    }

    if (index === 15) {
      clearFilter(index)
      return
    }

    if (index === 16) {
      const path = await askInTui("Export markdown path", "gh-viz.md")
      if (!path) {
        setStatus(state, "Export canceled.")
        return
      }
      const markdown = renderMarkdown({
        author: state.author,
        generatedAt: new Date().toISOString().replace("T", " ").replace(".000Z", " UTC"),
        view: currentView,
        totalCountHint: state.totalCountHint,
        groupBy: state.groupBy,
        topRepos: state.topRepos,
        daysSummary: state.daysSummary,
        daysChart: state.daysChart,
        viz: "all",
        endDate: state.endDate,
      })
      fs.writeFileSync(path, markdown, "utf8")
      setStatus(state, `Exported ${path}`)
    }
  }

  const clearFilter = (index: number): void => {
    if (index === 0) {
      state.author = author
      state.records = []
      state.hasFetched = false
      state.fetchedSince = undefined
      state.totalCountHint = undefined
    }
    if (index === 1) state.endDate = todayUTC()
    if (index === 2) state.daysSummary = 28
    if (index === 3) state.daysChart = 28
    if (index === 4) state.groupBy = "both"
    if (index === 5) state.includeOrg.clear()
    if (index === 6) state.excludeOrg.clear()
    if (index === 7) state.includeRepo.clear()
    if (index === 8) state.excludeRepo.clear()
    if (index === 9) state.publicOnly = false
    if (index === 10) state.excludeMerges = false
    if (index === 11) state.topRepos = 20
    if (index === 15) {
      state.author = author
      state.records = []
      state.hasFetched = false
      state.fetchedSince = undefined
      state.totalCountHint = undefined
      state.endDate = todayUTC()
      state.daysSummary = 28
      state.daysChart = 28
      state.groupBy = "both"
      state.topRepos = 20
      state.includeOrg.clear()
      state.excludeOrg.clear()
      state.includeRepo.clear()
      state.excludeRepo.clear()
      state.publicOnly = false
      state.excludeMerges = false
    }
    setStatus(state, "Filter cleared. Press 'u' to fetch.")
  }

  const render = (): void => {
    try {
      currentView = buildActivityView({
        records: state.records,
        endDate: state.endDate,
        daysSummary: state.daysSummary,
        daysChart: state.daysChart,
        includeOrg: state.includeOrg,
        excludeOrg: state.excludeOrg,
        includeRepo: state.includeRepo,
        excludeRepo: state.excludeRepo,
        publicOnly: state.publicOnly,
        excludeMerges: state.excludeMerges,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(state, `Render failed: ${message}`, true)
      currentView = {
        summaryStart: isoDateUTC(addDays(state.endDate, -(state.daysSummary - 1))),
        chartStart: isoDateUTC(addDays(state.endDate, -(state.daysChart - 1))),
        summaryRecords: [],
        chartRecords: [],
        orgRows: [],
        repoRows: [],
      }
    }

    const activePane = focus === "commits" ? "COMMITS" : "FILTERS"
    const title = `gh viz TUI | Active pane: ${activePane} | Tab switch pane | Enter select | o open | Esc clear filter | q quit`
    header.setContent(ellipsize(title, Math.max(10, screen.width as number)))

    commitsLabel.setContent(focus === "commits" ? "Commits (chart window) [ACTIVE]" : "Commits (chart window)")
    commitsLabel.style = { underline: true, bold: focus === "commits", fg: focus === "commits" ? "cyan" : "white" }
    filtersLabel.setContent(focus === "filters" ? "Filters [ACTIVE]" : "Filters")
    filtersLabel.style = { underline: true, bold: focus === "filters", fg: focus === "filters" ? "magenta" : "white" }

    commitsList.style = {
      ...commitsList.style,
      border: { fg: focus === "commits" ? "cyan" : "gray" },
      selected: focus === "commits"
        ? { bg: "cyan", fg: "black", bold: true }
        : { bg: "blue", fg: "white", bold: true },
    }
    filtersList.style = {
      ...filtersList.style,
      border: { fg: focus === "filters" ? "magenta" : "gray" },
      selected: focus === "filters"
        ? { bg: "magenta", fg: "black", bold: true }
        : { bg: "blue", fg: "white", bold: true },
    }

    const dataState = state.hasFetched ? "loaded" : "not-loaded"
    summary.setContent(
      ellipsize(
        `Author=@${state.author} Data=${dataState} Summary=${currentView.summaryStart}..${isoDateUTC(state.endDate)} ChartDays=${state.daysChart} Commits=${currentView.summaryRecords.length} Repos=${currentView.repoRows.length} Orgs=${currentView.orgRows.length}`,
        Math.max(10, screen.width as number),
      ),
    )

    const dayCounts = new Map<string, number>()
    for (const record of currentView.chartRecords) {
      dayCounts.set(record.day, (dayCounts.get(record.day) ?? 0) + 1)
    }

    const previewDays = 28
    const previewStart = addDays(state.endDate, -(previewDays - 1))
    const previewDates = dateRange(previewStart, state.endDate)
    const previewSymbols = previewDates
      .map(d => intensityColoredSymbol(dayCounts.get(isoDateUTC(d)) ?? 0))
      .join("")
    preview.setContent(
      `Preview 28d ${isoDateUTC(previewStart)}→${isoDateUTC(state.endDate)} ${previewSymbols}`,
    )

    const maxVisibleCommits = 250
    visibleCommits = currentView.chartRecords.slice(0, maxVisibleCommits)
    const hiddenCount = Math.max(0, currentView.chartRecords.length - visibleCommits.length)

    const commitItems = visibleCommits.length > 0
      ? visibleCommits.map(r => {
        const count = dayCounts.get(r.day) ?? 0
        return `${intensityColoredSymbol(count)} ${r.day} (${String(count).padStart(2, " ")}) ${r.repo} ${r.subject}`
      })
      : [state.hasFetched ? "(no commits for current chart window + filters)" : "(no data loaded yet - press 'u' to fetch)"]
    if (hiddenCount > 0) {
      commitItems.push(`{yellow-fg}... ${hiddenCount} more commits not shown (narrow filters){/}`)
    }
    const selectedCommit = Math.min(selectedIndex(commitsList), commitItems.length - 1)
    commitsList.setItems(commitItems)
    commitsList.select(Math.max(0, selectedCommit))

    const fRows = filterRows(state)
    const filterItems = fRows.map(([label, value]) => `${label}: ${colorizeFilterValue(label, value)}`)
    const selectedFilter = Math.min(selectedIndex(filtersList), filterItems.length - 1)
    filtersList.setItems(filterItems)
    filtersList.select(Math.max(0, selectedFilter))

    const commitIndex = Math.min(selectedIndex(commitsList), Math.max(0, visibleCommits.length - 1))
    const selected = visibleCommits[commitIndex]
    const selectedDayCount = selected ? (dayCounts.get(selected.day) ?? 0) : 0
    detail.setContent(
      ellipsize(
        selected
          ? `${intensitySymbol(selectedDayCount)} dayCount=${selectedDayCount} ${selected.repo}#${selected.sha.slice(0, 10)} ${selected.subject}`
          : hiddenCount > 0 && selectedIndex(commitsList) >= visibleCommits.length
            ? "(more commits hidden; narrow filters to inspect)"
            : "(no commit selected)",
        Math.max(10, screen.width as number),
      ),
    )

    const statusText = state.status || "Ready."
    status.setContent(ellipsize(`Pane=${activePane} | ${statusText} | Intensity: ·░▒▓█`, Math.max(10, screen.width as number)))
    status.style = state.statusError ? { fg: "red" } : { fg: "white" }

    if (focus === "commits") commitsList.focus()
    if (focus === "filters") filtersList.focus()

    screen.render()
  }

  let resolveExit: ((code: number) => void) | null = null
  const exit = (code: number): void => {
    screen.destroy()
    if (resolveExit) resolveExit(code)
  }

  screen.key(["q", "C-c"], () => {
    exit(0)
  })

  screen.key(["tab"], () => {
    focus = focus === "commits" ? "filters" : "commits"
    render()
  })

  screen.key(["r"], () => {
    clearFilter(15)
    render()
  })

  screen.key(["u"], () => {
    runFetch()
    render()
  })

  screen.key(["enter"], async () => {
    if (focus === "filters") {
      await applyFilter(selectedIndex(filtersList))
      render()
      return
    }

    const selected = visibleCommits[selectedIndex(commitsList)]
    if (!selected) {
      setStatus(state, "No commit selected.", true)
      render()
      return
    }
    setStatus(state, `Selected ${selected.repo}@${selected.sha.slice(0, 7)} (press 'o' to open)`)
    render()
  })

  screen.key(["o"], () => {
    const selected = visibleCommits[selectedIndex(commitsList)]
    if (!selected) return
    try {
      runGh(["browse", `${selected.repo}/commit/${selected.sha}`])
      setStatus(state, `Opened ${selected.repo}@${selected.sha.slice(0, 7)}`)
    } catch (error) {
      setStatus(state, error instanceof Error ? `Open failed: ${error.message}` : "Open failed", true)
    }
    render()
  })

  screen.key(["escape"], () => {
    if (focus === "filters") {
      clearFilter(selectedIndex(filtersList))
      render()
    }
  })

  render()
  return await new Promise<number>(resolve => {
    resolveExit = resolve
  })
}

function buildProgram(): Command {
  const collect = (value: string, prev: string[]) => {
    prev.push(value)
    return prev
  }

  const program = new Command()
    .name("gh viz")
    .description("Visualize authored Git commit history via gh API with filters")
    .option("--author <login>", "GitHub login to analyze (default: authenticated user)")
    .option("--mode <mode>", "Mode: auto, text, or tui", "auto")
    .option("--days-summary <days>", "Summary window in days", "28")
    .option("--days-chart <days>", "Chart window in days", "28")
    .option("--end-date <yyyy-mm-dd>", "End date (UTC) in YYYY-MM-DD")
    .option("--include-org <orgs>", "Include org(s), comma-separated or repeat", collect, [])
    .option("--exclude-org <orgs>", "Exclude org(s), comma-separated or repeat", collect, [])
    .option("--include-repo <repos>", "Include repo(s) owner/name, comma-separated or repeat", collect, [])
    .option("--exclude-repo <repos>", "Exclude repo(s) owner/name, comma-separated or repeat", collect, [])
    .option("--public-only", "Exclude private repos", false)
    .option("--exclude-merges", "Exclude merge commits", false)
    .option("--top-repos <count>", "Number of repos to show", "20")
    .option("--group-by <group>", "Group by org|repo|both", "both")
    .option("--viz <viz>", "Visualization: summary|heat|bars|heatstamp|all|json", "all")
    .option("--format <format>", "Output format auto|markdown|table|json", "auto")
    .option("-o, --output <path>", "Write output to file")

  return program
}

function normalizeOptions(program: Command): RawOptions {
  const raw = program.opts<Record<string, unknown>>()

  const mode = String(raw.mode || "auto") as Mode
  const groupBy = String(raw.groupBy || "both") as GroupBy
  const format = String(raw.format || "auto") as OutputFormat
  const viz = String(raw.viz || "all") as Visualization

  const normalized: RawOptions = {
    author: raw.author ? String(raw.author) : undefined,
    mode,
    daysSummary: Number(raw.daysSummary || 28),
    daysChart: Number(raw.daysChart || 28),
    endDate: raw.endDate ? String(raw.endDate) : undefined,
    includeOrg: (raw.includeOrg as string[]) || [],
    excludeOrg: (raw.excludeOrg as string[]) || [],
    includeRepo: (raw.includeRepo as string[]) || [],
    excludeRepo: (raw.excludeRepo as string[]) || [],
    publicOnly: Boolean(raw.publicOnly),
    excludeMerges: Boolean(raw.excludeMerges),
    topRepos: Number(raw.topRepos || 20),
    groupBy,
    format,
    viz,
    output: raw.output ? String(raw.output) : undefined,
  }

  if (!["auto", "text", "tui"].includes(normalized.mode)) {
    throw new Error("--mode must be auto|text|tui")
  }
  if (!["org", "repo", "both"].includes(normalized.groupBy)) {
    throw new Error("--group-by must be org|repo|both")
  }
  if (!["auto", "markdown", "table", "json"].includes(normalized.format)) {
    throw new Error("--format must be auto|markdown|table|json")
  }
  if (!["summary", "heat", "bars", "heatstamp", "all", "json"].includes(normalized.viz)) {
    throw new Error("--viz must be summary|heat|bars|heatstamp|all|json")
  }
  if (!Number.isInteger(normalized.daysSummary) || normalized.daysSummary < 1) {
    throw new Error("--days-summary must be an integer >= 1")
  }
  if (!Number.isInteger(normalized.daysChart) || normalized.daysChart < 1) {
    throw new Error("--days-chart must be an integer >= 1")
  }
  if (!Number.isInteger(normalized.topRepos) || normalized.topRepos < 1) {
    throw new Error("--top-repos must be an integer >= 1")
  }

  return normalized
}

async function runTextMode(options: RawOptions): Promise<number> {
  const author = options.author || getDefaultAuthor()
  const endDate = options.endDate ? parseISODate(options.endDate) : todayUTC()

  const summaryStart = addDays(endDate, -(options.daysSummary - 1))
  const chartStart = addDays(endDate, -(options.daysChart - 1))
  const fetchStart = summaryStart < chartStart ? summaryStart : chartStart

  const { records, totalCountHint } = fetchRecords(author, isoDateUTC(fetchStart))

  const view = buildActivityView({
    records,
    endDate,
    daysSummary: options.daysSummary,
    daysChart: options.daysChart,
    includeOrg: splitValues(options.includeOrg),
    excludeOrg: splitValues(options.excludeOrg),
    includeRepo: splitValues(options.includeRepo),
    excludeRepo: splitValues(options.excludeRepo),
    publicOnly: options.publicOnly,
    excludeMerges: options.excludeMerges,
  })

  const format = options.viz === "json"
    ? "json"
    : resolveOutputFormat(options.format, options.output)
  const generatedAt = new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")

  let rendered = ""
  if (format === "json") {
    const output = {
      generatedAt,
      author,
      summaryWindow: {
        start: view.summaryStart,
        end: isoDateUTC(endDate),
      },
      chartWindow: {
        start: view.chartStart,
        end: isoDateUTC(endDate),
      },
      filters: {
        includeOrg: [...splitValues(options.includeOrg)].sort(),
        excludeOrg: [...splitValues(options.excludeOrg)].sort(),
        includeRepo: [...splitValues(options.includeRepo)].sort(),
        excludeRepo: [...splitValues(options.excludeRepo)].sort(),
        publicOnly: options.publicOnly,
        excludeMerges: options.excludeMerges,
      },
      visualization: options.viz,
      groupBy: options.groupBy,
      totals: {
        commits: view.summaryRecords.length,
        nonMerge: view.summaryRecords.filter(r => !r.isMerge).length,
        repos: new Set(view.summaryRecords.map(r => r.repo)).size,
        orgs: new Set(view.summaryRecords.map(r => r.org)).size,
      },
      orgSummary: options.groupBy === "repo" ? undefined : view.orgRows,
      repoSummary: options.groupBy === "org" ? undefined : view.repoRows.slice(0, options.topRepos),
      searchTotalCount: totalCountHint,
    }
    rendered = JSON.stringify(output, null, 2) + "\n"
  } else if (format === "table") {
    rendered = renderTableOutput({
      author,
      view,
      groupBy: options.groupBy,
      topRepos: options.topRepos,
      daysSummary: options.daysSummary,
      daysChart: options.daysChart,
      viz: options.viz,
      endDate,
    })
  } else {
    rendered = renderMarkdown({
      author,
      generatedAt,
      view,
      totalCountHint,
      groupBy: options.groupBy,
      topRepos: options.topRepos,
      daysSummary: options.daysSummary,
      daysChart: options.daysChart,
      viz: options.viz,
      endDate,
    })
  }

  if (options.output) {
    fs.writeFileSync(options.output, rendered, "utf8")
    console.log(`Wrote ${options.output}`)
  } else {
    process.stdout.write(rendered)
  }

  return 0
}

async function run(): Promise<number> {
  const program = buildProgram()
  program.parse(process.argv)

  let options = normalizeOptions(program)
  const noArgs = process.argv.length <= 2
  const interactiveTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let interactiveTextLoop = false

  if (options.mode === "auto" && noArgs && interactiveTTY) {
    const mode = await chooseStartupMode()
    if (mode === "tui") {
      options.mode = "tui"
    } else if (mode === "guided-text") {
      options.mode = "text"
      options = await runTextWizard(options)
      interactiveTextLoop = true
    } else {
      options.mode = "text"
      interactiveTextLoop = true
    }
  } else if (options.mode === "text" && noArgs && interactiveTTY) {
    options = await runTextWizard(options)
    interactiveTextLoop = true
  }

  if (options.mode === "tui") {
    return await runTui(options)
  }

  if (!interactiveTextLoop) {
    return await runTextMode(options)
  }

  while (true) {
    const code = await runTextMode(options)
    if (code !== 0) return code

    const action = await choosePostTextAction()
    if (action === "print-again") {
      continue
    }
    if (action === "wizard") {
      options = await runTextWizard(options)
      continue
    }
    if (action === "tui") {
      return await runTui(options)
    }
    return 0
  }
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exit(1)
})
