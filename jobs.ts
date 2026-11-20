import type { GuestEndedShell, GuestRunningShell, GuestRunningShellsSnapshot } from "@openchamber/sdk"

type Session = { id: string; title?: string; location: { directory: string } }
type Message = { id: string; content?: unknown[]; metadata?: Record<string, unknown> }
type Page<T> = { data: T[]; cursor?: { next?: string } }
export type Api = <T>(path: string, query?: Record<string, string>) => Promise<T>
export type Job = {
  id: string; sessionID: string; command: string; monitored: boolean; foreground?: boolean
  started: number; completed?: number; exit?: number
  status: "running" | "exited" | "timeout" | "killed" | "stopped" | "unavailable" | "unknown"
  cancelledBy?: "human" | "agent"
  native?: boolean
}
export type History = { jobs: Job[]; sessions: Session[]; warnings: string[] }

export function mergeJobs(history: History | undefined, live: GuestRunningShellsSnapshot | undefined, archive: Job[] = []): Job[] {
  const scoped = history && new Set(history.sessions.map(session => session.id))
  const jobs = new Map<string, Job>(archive.filter(job => !scoped || scoped.has(job.sessionID)).map(job => [job.id, { ...job, native: false }]))
  for (const job of history?.jobs ?? []) {
    const saved = jobs.get(job.id)
    jobs.set(job.id, saved?.sessionID === job.sessionID && ["unknown", "unavailable"].includes(job.status)
      ? { ...saved, command: job.command, monitored: job.monitored } : job)
  }
  const add = (shell: GuestRunningShell, ended?: GuestEndedShell) => {
    if (ended && !shell.background) return
    const record = jobs.get(shell.id)
    const prior = record?.sessionID === shell.sessionID ? record : undefined
    // A reconnect can lose the host's outcome; don't overwrite durable evidence.
    const status = ended
      ? ended.status === "unknown" ? prior?.status === "unavailable" ? "unknown" : prior?.status ?? "unknown"
        : ended.status
      : "running"
    jobs.set(shell.id, {
      id: shell.id, sessionID: shell.sessionID, command: shell.command, monitored: prior?.monitored ?? false,
      foreground: !shell.background, started: shell.startedAt, completed: ended?.status === "unknown" ? prior?.completed : ended?.endedAt,
      status, exit: ended?.exit ?? (ended ? prior?.exit : undefined), native: true,
      cancelledBy: ended && status === prior?.status ? prior?.cancelledBy : undefined,
    })
  }
  for (const shell of live?.ended ?? []) add(shell, shell)
  for (const shell of live?.shells ?? []) add(shell)
  return [...jobs.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") ||
    Number(b.monitored) - Number(a.monitored) || b.started - a.started)
}

/** OpenChamber's ended snapshot is memory-only. Keep a bounded per-panel-session record. */
export function archiveJobs(jobs: Job[]): Job[] {
  const archive: Job[] = []
  let bytes = 2
  for (const job of jobs.filter(job => !job.foreground && job.completed && job.status !== "running")
    .sort((a, b) => b.completed! - a.completed!).slice(0, 200)) {
    const entry = { ...job, command: job.command.slice(0, 1024), native: undefined }
    const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1
    if (bytes + size > 60 * 1024) break
    bytes += size
    archive.push(entry)
  }
  return archive
}

/** History only: the host owns all live shell state and actions. */
export class JobHistory {
  private histories = new Map<string, { jobs: Map<string, Job>; outcomes: Map<string, Partial<Job>>; assistant?: string; synthetic?: string }>()
  private api: Api
  constructor(api: Api) { this.api = api }

  async list(root: string): Promise<History> {
    const { data } = await this.api<{ data: Session }>(`/api/session/${root}`)
    const sessions = [data]
    const seen = new Set([root])
    const jobs: Job[] = []
    const warnings: string[] = []
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i]
      let cursor: string | undefined
      do {
        const page: Page<Session> = await this.api("/api/session", { parentID: session.id, limit: "100", ...(cursor ? { cursor } : {}) })
        for (const child of page.data) if (!seen.has(child.id)) { seen.add(child.id); sessions.push(child) }
        cursor = page.cursor?.next
      } while (cursor)
      try { jobs.push(...await this.read(session.id)) }
      catch (error) {
        warnings.push(`${session.title ?? session.id}: ${String(error)}`)
        jobs.push(...(this.histories.get(session.id)?.jobs.values() ?? []))
      }
    }
    // Return copies: a later scan must not mutate an in-flight snapshot.
    return { jobs: jobs.map(job => ({ ...job })), sessions, warnings }
  }

  private async read(id: string): Promise<Job[]> {
    const history = this.histories.get(id) ?? { jobs: new Map<string, Job>(), outcomes: new Map<string, Partial<Job>>() }
    this.histories.set(id, history)
    for (const type of ["assistant", "synthetic"] as const) {
      let cursor: string | undefined
      let head: string | undefined
      let reached = false
      do {
        const page: Page<Message> = await this.api(`/api/session/${id}/message`, {
          type, limit: history[type] ? "10" : "100", ...(cursor ? { cursor } : { order: "desc" }),
        })
        head ??= page.data[0]?.id
        for (const message of page.data) {
          if (type === "assistant") {
            for (const raw of message.content ?? []) {
              const part = raw as { type?: string; name?: string; state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }; time?: { ran?: number; created?: number } }
              if (part.type !== "tool" || part.name !== "shell") continue
              const input = part.state?.input
              const shellID = part.state?.metadata?.shellID
              if (input?.background !== true || typeof shellID !== "string" || !/^sh_[\w-]+$/.test(shellID)) continue
              if (!history.jobs.has(shellID)) history.jobs.set(shellID, {
                id: shellID, sessionID: id, command: String(input.command ?? ""), monitored: input.monitor === true,
                started: part.time?.ran ?? part.time?.created ?? 0, status: "unavailable", ...history.outcomes.get(shellID),
              })
            }
          } else {
            const meta = message.metadata
            const shellID = meta?.shellID
            if (meta && typeof shellID === "string" && /^sh_[\w-]+$/.test(shellID)) {
              let outcome: Partial<Job> | undefined
              if (meta.source === "shell" && typeof meta.exit === "number" && !history.outcomes.has(shellID)) {
                outcome = { status: "exited", exit: meta.exit }
              }
              if ((meta.source === "openchamber-jobs" || meta.source === "opencode-monitor") &&
                meta.event === "job.cancelled" && meta.sessionID === id && (meta.actor === "human" || meta.actor === "agent")) {
                outcome = { status: "killed", cancelledBy: meta.actor, exit: undefined,
                  completed: typeof meta.cancelledAt === "number" ? meta.cancelledAt : undefined }
              }
              if (outcome) {
                history.outcomes.set(shellID, outcome)
                const job = history.jobs.get(shellID)
                if (job) Object.assign(job, outcome)
              }
            }
          }
          if (message.id === history[type]) reached = true
        }
        cursor = page.cursor?.next
      } while (cursor && !reached)
      history[type] = head
    }
    return [...history.jobs.values()]
  }
}
