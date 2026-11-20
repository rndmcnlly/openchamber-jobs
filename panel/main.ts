import { connectHost, HostRequestError, type GuestRunningShellsSnapshot } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { archiveJobs, mergeJobs, type History, type Job } from "../jobs.js"

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
let sessionID: string | null = null
let generation = 0
let collapsed = new Set<string>()
const automaticallyClosed = new Set<string>()
let autoCollapse = false
let showForeground = true
let ready = false
let busy = false
let currentJobs: Job[] = []
let history: History | undefined
let live: GuestRunningShellsSnapshot | undefined
let unsubscribe: (() => void) | undefined
let liveError = ""
let historyError = ""
let archive: Job[] = []
type Card = { element: HTMLElement; title: HTMLButtonElement; state: HTMLElement; age: HTMLElement; owner: HTMLElement; badge: HTMLElement; foregroundBadge: HTMLElement; stop: HTMLButtonElement; body: HTMLElement; output: HTMLElement; cursor?: number; text: string; complete: boolean; loading: boolean; job: Job }
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
async function request<T>(path: string, query: Record<string, string>): Promise<T> {
  const result = await host.serviceRequest({ path, query, method: "GET" })
  const body = JSON.parse(result.body)
  if (result.status >= 400) throw new Error(body.error ?? `Service answered ${result.status}`)
  return body as T
}
function persist() {
  if (!sessionID) return
  void host.storage.set(`collapsed:${sessionID}`, [...collapsed]).catch((e) => showNotice(String(e)))
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
  const badge = element("span", "monitor-badge", "MONITOR")
  badge.title = "Launched with monitor: true. Line notifications can stop at the plugin's limit; the process may still be running."
  const foreground = element("span", "foreground-badge", "FOREGROUND")
  foreground.title = "A foreground command currently running in this session or a subagent. Its agent is waiting for the tool to finish."
  const stop = element("button", "stop-control", "Cancel job")
  stop.title = "Cancel this running command. OpenCode also removes its retained output."
  stop.setAttribute("aria-label", `Cancel job: ${title.textContent}`)
  line.append(state, age, badge, foreground, stop)
  const owner = element("div", "owner")
  header.append(title, line, owner)
  const body = element("div")
  const output = element("pre", "output-view", "Waiting for output…")
  const details = element("details", "technical")
  const list = element("dl")
  for (const [term, value] of [["Shell", job.id], ["Session", job.sessionID], ["Start", job.started ? new Date(job.started).toISOString() : "Unknown"]]) {
    list.append(element("dt", "", term), element("dd", "", value))
  }
  details.append(element("summary", "", "Details"), list)
  body.append(element("pre", "program", job.command), element("div", "output-header", "Live output · stdout + stderr"), output, details)
  article.append(header, body)
  const card: Card = { element: article, title, state, age, owner, badge, foregroundBadge: foreground, stop, body, output, text: "", complete: false, loading: false, job }
  title.onclick = () => { automaticallyClosed.delete(job.id); if (collapsed.has(job.id)) collapsed.delete(job.id); else collapsed.add(job.id); fold(card); persist(); void readOutput(card) }
  stop.onclick = async () => {
    const version = generation
    if (!live?.shells.some(shell => shell.id === job.id && shell.sessionID === card.job.sessionID && shell.background)) return
    stop.disabled = true
    stop.textContent = "Cancelling…"
    try {
      await host.stopShell(job.id)
      if (version !== generation) return
      card.complete = true
      card.output.textContent = `${card.text}\n[Cancelled in OpenChamber. Retained output was removed.]`
      await refresh()
    } catch (error) { if (version === generation) showNotice(`Could not cancel job: ${String(error)}`) }
    finally { stop.disabled = false; stop.textContent = "Cancel job" }
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
    if (autoCollapse && !job.monitored && card.job.status === "running" && job.status !== "running" && !collapsed.has(job.id)) {
      collapsed.add(job.id); automaticallyClosed.add(job.id); changed = true
    }
    // History can report monitor:true after the host reports that a shell ended.
    if (job.monitored && automaticallyClosed.delete(job.id)) { collapsed.delete(job.id); changed = true }
    card.job = job
    const running = job.status === "running"
    const tone = running ? "running" : job.status === "exited" && job.exit === 0 ? "success" : "failure"
    card.element.className = `job ${tone}${job.monitored ? " monitored" : ""}`
    card.state.textContent = running ? "Running" : job.status === "exited" ? `Exited ${job.exit ?? "?"}` : job.status === "timeout" ? "Timed out" : job.status === "stopped" ? "Stopped" : job.status === "killed" ? job.cancelledBy ? `Cancelled by ${job.cancelledBy}` : "Killed by signal" : job.status === "unknown" ? "Outcome unknown" : "Record unavailable"
    card.age.textContent = job.started && (running || job.completed) ? duration((job.completed ?? Date.now()) - job.started) : ""
    card.owner.hidden = job.sessionID === sessionID
    card.owner.textContent = `Subagent: ${history?.sessions.find(session => session.id === job.sessionID)?.title ?? job.sessionID}`
    card.owner.title = job.sessionID
    card.badge.hidden = !job.monitored
    card.foregroundBadge.hidden = !job.foreground
    card.stop.hidden = !running || job.foreground === true
    fold(card)
    // Keyed DOM preserves open details, output selection, scroll, and focus.
    const container = job.foreground ? foregroundRoot : backgroundRoot
    const desiredIndex = job.foreground ? foregroundIndex++ : backgroundIndex++
    if (container.children[desiredIndex] !== card.element) container.insertBefore(card.element, container.children[desiredIndex] ?? null)
  }
  foregroundEmpty.hidden = foregroundIndex > 0
  backgroundEmpty.hidden = backgroundIndex > 0
  if (changed) persist()
}
async function readOutput(card: Card) {
  const selected = sessionID
  const version = generation
  if (!selected || collapsed.has(card.job.id) || card.loading || card.complete) return
  if (!card.job.native || card.job.cancelledBy || card.job.status === "stopped") {
    card.output.textContent = card.text || "Output is not available through OpenChamber."
    return
  }
  card.loading = true
  try {
    const cursor = card.cursor
    const wasRunning = card.job.status === "running"
    const chunk = await host.readShellOutput(card.job.id, cursor === undefined ? { tailBytes: 32768 } : { cursor })
    if (version !== generation || card.complete) return
    const tail = card.output.scrollHeight - card.output.clientHeight - card.output.scrollTop < 20
    const left = card.output.scrollLeft
    card.text = ((chunk.skipped ? "[Earlier output skipped]\n" : card.text) + chunk.output).slice(-256 * 1024)
    card.cursor = chunk.cursor
    card.complete = !wasRunning && cursor === chunk.cursor
    card.output.textContent = card.text || (card.complete ? "(no output)" : "Waiting for output…")
    card.output.scrollLeft = left
    if (tail) card.output.scrollTop = card.output.scrollHeight
  } catch (error) {
    if (version === generation && !card.complete) {
      card.output.textContent = `${card.text}\n[${String(error)}]`
      if (error instanceof HostRequestError && error.code === "NOT_FOUND" && card.job.status !== "running") card.complete = true
    }
  }
  finally { card.loading = false }
}
async function refresh() {
  const selected = sessionID
  const version = generation
  if (!selected || !ready || busy) return
  busy = true
  try {
    const result = await request<History>("/history", { session: selected })
    if (version !== generation) return
    history = result
    historyError = result.warnings.join("\n")
  } catch (error) { if (version === generation) historyError = `Job history unavailable: ${String(error)}` }
  finally { if (version === generation) { busy = false; update() } }
}
function update() {
  if (!ready) return
  currentJobs = mergeJobs(history, live, archive)
  const next = archiveJobs(currentJobs)
  if (sessionID && JSON.stringify(next) !== JSON.stringify(archive)) {
    archive = next
    void host.storage.set(`ended:${sessionID}`, archive).catch((e) => showNotice(String(e)))
  }
  render()
  showNotice([liveError, historyError].filter(Boolean).join("\n"))
}
function render() {
  foregroundZone.hidden = !showForeground
  backgroundHeading.hidden = !showForeground
  const visible = currentJobs.filter((job) => showForeground || !job.foreground)
  paint(visible)
  const active = visible.filter((job) => job.status === "running")
  const foregroundCount = currentJobs.filter((job) => job.foreground).length
  const foregroundSummary = showForeground ? ` · ${foregroundCount} foreground` : foregroundCount ? ` · ${foregroundCount} foreground hidden` : ""
  const sessions = history?.sessions.length
  summary.textContent = `${active.length} running · ${active.filter((job) => job.monitored).length} monitored${foregroundSummary}${sessions ? ` · ${sessions} session${sessions === 1 ? "" : "s"} (including subagents)` : ""}`
  void Promise.all([...cards.values()].map(readOutput))
}
foregroundToggle.onclick = () => {
  showForeground = !showForeground
  foregroundToggle.setAttribute("aria-pressed", String(showForeground))
  void host.storage.set("show-foreground", showForeground).catch((e) => showNotice(String(e)))
  if (sessionID) render()
}
document.querySelector<HTMLButtonElement>("#expand")!.onclick = () => { automaticallyClosed.clear(); collapsed.clear(); cards.forEach(fold); persist() }
document.querySelector<HTMLButtonElement>("#collapse")!.onclick = () => { automaticallyClosed.clear(); collapsed = new Set(cards.keys()); cards.forEach(fold); persist() }
automatic.onclick = () => {
  autoCollapse = !autoCollapse
  automatic.setAttribute("aria-pressed", String(autoCollapse))
  void host.storage.set("auto-collapse", autoCollapse).catch((e) => showNotice(String(e)))
}
automatic.title = "Collapse ordinary jobs when they finish. Monitored jobs stay expanded."
host.onReady((context) => applyHostReady(context, document.documentElement))
host.onSession((session) => {
  const next = session?.id ?? null
  if (next === sessionID) return
  sessionID = next
  const version = ++generation
  unsubscribe?.()
  unsubscribe = undefined
  ready = false
  busy = false
  currentJobs = []
  history = live = undefined
  archive = []
  liveError = historyError = ""
  foregroundZone.hidden = true
  backgroundHeading.hidden = true
  backgroundEmpty.hidden = true
  cards.clear()
  foregroundRoot.replaceChildren()
  backgroundRoot.replaceChildren()
  collapsed.clear()
  automaticallyClosed.clear()
  showNotice("")
  summary.textContent = next ? "Loading session tree…" : "Open a conversation to see its jobs."
  if (!next) return
  void host.onRunningShells({ kind: "session", sessionId: next }, (snapshot) => {
    if (version !== generation) return
    live = snapshot
    update()
  }).then((dispose) => {
    if (version !== generation) dispose()
    else unsubscribe = dispose
  }).catch((error) => {
    if (version === generation) { liveError = `Live shells unavailable: ${String(error)}`; update() }
  })
  void Promise.all([host.storage.get(`collapsed:${next}`), host.storage.get("auto-collapse"), host.storage.get("show-foreground"), host.storage.get(`ended:${next}`)]).then(([closed, auto, foreground, ended]) => {
    if (version !== generation) return
    collapsed = new Set(Array.isArray(closed) ? closed.filter((s): s is string => typeof s === "string") : [])
    autoCollapse = auto === true
    automatic.setAttribute("aria-pressed", String(autoCollapse))
    showForeground = foreground !== false
    archive = Array.isArray(ended) ? ended as Job[] : []
    foregroundToggle.setAttribute("aria-pressed", String(showForeground))
  }).catch((e) => { if (version === generation) showNotice(String(e)) }).finally(() => {
    if (version !== generation) return
    ready = true
    update()
    void refresh()
  })
})
window.setInterval(() => { if (!document.hidden && ready) render() }, 2000)
window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
