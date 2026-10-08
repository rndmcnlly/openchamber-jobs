import { connectHost, HostRequestError, type GuestRunningShellsSnapshot, type GuestSessionRecord } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { merge, parseHistory, serializeHistory, type Job } from "../jobs.js"

const host = connectHost()
const foregroundZone = document.querySelector<HTMLElement>("#foreground-zone")!
const foregroundEmpty = document.querySelector<HTMLElement>("#foreground-empty")!
const foregroundRoot = document.querySelector<HTMLElement>("#foreground-jobs")!
const backgroundRoot = document.querySelector<HTMLElement>("#background-jobs")!
const backgroundHeading = document.querySelector<HTMLElement>("#background-heading")!
const backgroundEmpty = document.querySelector<HTMLElement>("#background-empty")!
const summary = document.querySelector<HTMLElement>("#summary")!
const notice = document.querySelector<HTMLElement>("#notice")!
const automatic = document.querySelector<HTMLButtonElement>("#auto")!
const foregroundToggle = document.querySelector<HTMLButtonElement>("#foreground")!
const OUTPUT_LIMIT = 256 * 1024
let sessionID: string | null = null
let generation = 0
let collapsed = new Set<string>()
let pinned = new Set<string>()
let autoCollapse = false
let showForeground = true
let history: Job[] = []
let savedHistory = ""
let foregroundJobs: Job[] = []
let titles = new Map<string, string>()
let treeSize = 0
let unsubscribe: Array<() => void> = []
type Card = { element: HTMLElement; title: HTMLButtonElement; state: HTMLElement; age: HTMLElement; owner: HTMLElement; foregroundBadge: HTMLElement; pin: HTMLButtonElement; stop: HTMLButtonElement; body: HTMLElement; output: HTMLElement; cursor?: number; text: string; complete: boolean; loading: boolean; job: Job }
const cards = new Map<string, Card>()

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.className = className
  result.textContent = text
  return result
}
function showNotice(text: string) { notice.textContent = text; notice.hidden = !text }
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
function stateLabel(job: Job) {
  switch (job.status) {
    case "running": return "Running"
    case "exited": return `Exited ${job.exit ?? "?"}`
    case "timeout": return "Timed out"
    case "killed": return "Killed"
    case "stopped": return "Stopped"
    case "unknown": return "Ended, status unknown"
    case "unavailable": return "Record unavailable"
  }
}
function tone(job: Job) {
  if (job.status === "running") return "running"
  if (job.status === "exited" && job.exit === 0) return "success"
  if (job.status === "unknown" || job.status === "unavailable") return "settled"
  return "failure"
}
function remember(key: string, value: string[] | boolean) {
  void host.storage.set(key, value).catch((e) => showNotice(String(e)))
}
function persistFolds() { if (sessionID) remember(`collapsed:${sessionID}`, [...collapsed]) }
function persistPins() { if (sessionID) remember(`pinned:${sessionID}`, [...pinned]) }
function persistHistory() {
  if (!sessionID) return
  const value = serializeHistory(history)
  const json = JSON.stringify(value)
  if (json === savedHistory) return
  savedHistory = json
  void host.storage.set(`jobs:${sessionID}`, value).catch((e) => showNotice(String(e)))
}
function fold(card: Card) {
  const closed = collapsed.has(card.job.id)
  card.title.setAttribute("aria-expanded", String(!closed))
  card.body.hidden = closed
}
function makeCard(job: Job): Card {
  const article = element("article", "job")
  article.dataset.jobId = job.id
  const header = element("header", "card-header")
  const title = element("button", "task-summary", job.command.split("\n").find((line) => line.trim()) ?? job.id)
  const line = element("div", "status-line")
  const state = element("span", "state")
  const age = element("span", "elapsed")
  const foreground = element("span", "foreground-badge", "FOREGROUND")
  foreground.title = "A foreground command currently running in this session or a subagent. Its agent is waiting for the tool to finish."
  const pin = element("button", "pin-control", "Pin")
  pin.title = "Keep this job expanded when auto-collapse is on."
  const stop = element("button", "stop-control", "Stop job")
  stop.title = "Stop this running command. The agent is told you stopped it, and OpenCode removes its output."
  stop.setAttribute("aria-label", `Stop job: ${title.textContent}`)
  line.append(state, age, foreground, pin, stop)
  const owner = element("div", "owner")
  header.append(title, line, owner)
  const body = element("div")
  const output = element("pre", "output-view", "Waiting for output…")
  const details = element("details", "technical")
  const list = element("dl")
  for (const [term, value] of [["Shell", job.id], ["Session", job.sessionID], ["Start", new Date(job.started).toISOString()]]) {
    list.append(element("dt", "", term), element("dd", "", value))
  }
  details.append(element("summary", "", "Details"), list)
  body.append(element("pre", "program", job.command), element("div", "output-header", "Output · stdout + stderr"), output, details)
  article.append(header, body)
  const card: Card = { element: article, title, state, age, owner, foregroundBadge: foreground, pin, stop, body, output, text: "", complete: false, loading: false, job }
  title.onclick = () => { if (collapsed.has(job.id)) collapsed.delete(job.id); else collapsed.add(job.id); fold(card); persistFolds(); void readOutput(card) }
  pin.onclick = () => {
    if (pinned.has(job.id)) pinned.delete(job.id); else { pinned.add(job.id); collapsed.delete(job.id); fold(card) }
    pin.setAttribute("aria-pressed", String(pinned.has(job.id)))
    persistPins()
  }
  stop.onclick = async () => {
    const version = generation
    stop.disabled = true
    stop.textContent = "Stopping…"
    try { await host.stopShell(job.id) }
    catch (error) { if (version === generation) showNotice(`Could not stop job: ${String(error)}`) }
    finally { stop.disabled = false; stop.textContent = "Stop job" }
  }
  return card
}
function paint(jobs: Job[]) {
  let changed = false
  let foregroundIndex = 0
  let backgroundIndex = 0
  const retained = new Set(jobs.map((job) => job.id))
  for (const [id, card] of cards) if (!retained.has(id)) { card.element.remove(); cards.delete(id) }
  for (const job of jobs) {
    let card = cards.get(job.id)
    if (!card) { card = makeCard(job); cards.set(job.id, card) }
    if (autoCollapse && !pinned.has(job.id) && card.job.status === "running" && job.status !== "running") { collapsed.add(job.id); changed = true }
    // An output read that finished while the job ran must look again for its tail.
    if (card.job.status === "running" && job.status !== "running") card.complete = false
    card.job = job
    const running = job.status === "running"
    card.element.className = `job ${tone(job)}${pinned.has(job.id) ? " pinned" : ""}`
    card.state.textContent = stateLabel(job)
    card.age.textContent = running || job.completed ? duration((job.completed ?? Date.now()) - job.started) : ""
    card.owner.hidden = job.sessionID === sessionID
    card.owner.textContent = `Subagent: ${titles.get(job.sessionID) ?? job.sessionID}`
    card.owner.title = job.sessionID
    card.foregroundBadge.hidden = !job.foreground
    card.pin.hidden = job.foreground
    card.pin.setAttribute("aria-pressed", String(pinned.has(job.id)))
    card.stop.hidden = !running || job.foreground
    fold(card)
    // Keyed DOM preserves open details, output selection, scroll, and focus.
    const container = job.foreground ? foregroundRoot : backgroundRoot
    const desiredIndex = job.foreground ? foregroundIndex++ : backgroundIndex++
    if (container.children[desiredIndex] !== card.element) container.insertBefore(card.element, container.children[desiredIndex] ?? null)
  }
  foregroundEmpty.hidden = foregroundIndex > 0
  backgroundEmpty.hidden = backgroundIndex > 0
  if (changed) persistFolds()
}
async function readOutput(card: Card) {
  const version = generation
  if (collapsed.has(card.job.id) || card.loading || card.complete) return
  if (card.job.status === "stopped" || card.job.status === "unavailable") {
    card.output.textContent = card.text || "OpenCode no longer keeps this job's output."
    card.complete = true
    return
  }
  card.loading = true
  try {
    const first = card.cursor === undefined
    const page = await host.readShellOutput(card.job.id, first ? {} : { cursor: card.cursor })
    if (version !== generation) return
    const tail = card.output.scrollHeight - card.output.clientHeight - card.output.scrollTop < 20
    const left = card.output.scrollLeft
    if (first && page.skipped) card.text = "[earlier output not shown]\n"
    card.text = (card.text + page.output).slice(-OUTPUT_LIMIT)
    card.cursor = page.cursor
    card.complete = card.job.status !== "running" && page.output === ""
    card.output.textContent = card.text || (card.complete ? "(no output)" : "Waiting for output…")
    card.output.scrollLeft = left
    if (tail) card.output.scrollTop = card.output.scrollHeight
  } catch (error) {
    if (version !== generation) return
    if (error instanceof HostRequestError && error.code === "NOT_FOUND") {
      card.complete = true
      card.output.textContent = card.text || "OpenCode no longer keeps this job's output."
    } else card.output.textContent = `${card.text}\n[${String(error)}]`
  } finally { card.loading = false }
}
function render() {
  if (!sessionID) return
  foregroundZone.hidden = !showForeground
  backgroundHeading.hidden = !showForeground
  backgroundEmpty.hidden = false
  const visible = [...(showForeground ? foregroundJobs : []), ...history]
  paint(visible)
  const active = visible.filter((job) => job.status === "running").length
  const foregroundCount = foregroundJobs.length
  const foregroundSummary = showForeground ? ` · ${foregroundCount} foreground` : foregroundCount ? ` · ${foregroundCount} foreground hidden` : ""
  const sessions = treeSize ? ` · ${treeSize} session${treeSize === 1 ? "" : "s"} (including subagents)` : ""
  summary.textContent = `${active} running${foregroundSummary}${sessions}`
  void Promise.all([...cards.values()].map(readOutput))
}
function apply(snapshot: GuestRunningShellsSnapshot) {
  const board = merge(history, snapshot.shells, snapshot.ended)
  history = board.background
  foregroundJobs = board.foreground
  persistHistory()
  render()
}
/** Session titles and the size of the conversation's tree, for subagent labels. */
async function watchTitles(root: string, version: number) {
  const projects = await host.listProjects()
  for (const project of projects.projects) {
    const listed = await host.listSessions(project.id)
    if (version !== generation) return
    if (!listed.sessions.some((record) => record.id === root)) continue
    const stop = await host.onSessions(project.id, (snapshot) => {
      if (version !== generation) return
      titles = new Map(snapshot.sessions.map((record) => [record.id, record.title]))
      treeSize = sizeOfTree(snapshot.sessions, root)
      render()
    })
    if (version !== generation) stop()
    else unsubscribe.push(stop)
    return
  }
}
function sizeOfTree(records: GuestSessionRecord[], root: string) {
  const children = new Map<string, string[]>()
  for (const record of records) if (record.parentId) children.set(record.parentId, [...(children.get(record.parentId) ?? []), record.id])
  const seen = new Set([root])
  const queue = [root]
  while (queue.length) for (const child of children.get(queue.pop()!) ?? []) if (!seen.has(child)) { seen.add(child); queue.push(child) }
  return seen.size
}
foregroundToggle.onclick = () => {
  showForeground = !showForeground
  foregroundToggle.setAttribute("aria-pressed", String(showForeground))
  remember("show-foreground", showForeground)
  render()
}
document.querySelector<HTMLButtonElement>("#expand")!.onclick = () => { collapsed.clear(); cards.forEach(fold); persistFolds(); render() }
document.querySelector<HTMLButtonElement>("#collapse")!.onclick = () => { collapsed = new Set(cards.keys()); cards.forEach(fold); persistFolds() }
automatic.onclick = () => {
  autoCollapse = !autoCollapse
  automatic.setAttribute("aria-pressed", String(autoCollapse))
  remember("auto-collapse", autoCollapse)
}
automatic.title = "Collapse jobs when they finish. Pinned jobs stay expanded."
const strings = (value: unknown) => new Set(Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [])
host.onReady((context) => applyHostReady(context, document.documentElement))
host.onSession((session) => {
  const next = session?.id ?? null
  if (next === sessionID) return
  sessionID = next
  const version = ++generation
  for (const stop of unsubscribe) stop()
  unsubscribe = []
  history = []
  savedHistory = ""
  foregroundJobs = []
  titles = new Map()
  treeSize = 0
  foregroundZone.hidden = true
  backgroundHeading.hidden = true
  backgroundEmpty.hidden = true
  cards.clear()
  foregroundRoot.replaceChildren()
  backgroundRoot.replaceChildren()
  collapsed.clear()
  pinned.clear()
  showNotice("")
  summary.textContent = next ? "Loading jobs…" : "Open a conversation to see its jobs."
  if (!next) return
  void (async () => {
    const [closed, pins, remembered, auto, foreground] = await Promise.all([
      host.storage.get(`collapsed:${next}`), host.storage.get(`pinned:${next}`), host.storage.get(`jobs:${next}`),
      host.storage.get("auto-collapse"), host.storage.get("show-foreground"),
    ])
    if (version !== generation) return
    collapsed = strings(closed)
    pinned = strings(pins)
    history = parseHistory(remembered)
    savedHistory = JSON.stringify(serializeHistory(history))
    autoCollapse = auto === true
    automatic.setAttribute("aria-pressed", String(autoCollapse))
    showForeground = foreground !== false
    foregroundToggle.setAttribute("aria-pressed", String(showForeground))
    try {
      const stop = await host.onRunningShells({ kind: "session", sessionId: next }, (snapshot) => { if (version === generation) apply(snapshot) })
      if (version !== generation) { stop(); return }
      unsubscribe.push(stop)
    } catch (error) {
      if (version !== generation) return
      summary.textContent = ""
      showNotice(error instanceof HostRequestError && error.code === "NOT_GRANTED"
        ? "Jobs needs permission to see shell commands. Approve it in Settings → Extensions."
        : `Could not watch jobs: ${String(error)}`)
      return
    }
    // Titles only label subagent jobs; the panel works without them.
    void watchTitles(next, version).catch(() => {})
  })().catch((e) => { if (version === generation) showNotice(String(e)) })
})
window.setInterval(() => {
  if (document.hidden || !sessionID) return
  for (const card of cards.values()) {
    if (card.job.status === "running") card.age.textContent = duration(Date.now() - card.job.started)
    void readOutput(card)
  }
}, 2000)
