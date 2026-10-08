import type { GuestEndedShell, GuestRunningShell, GuestShellEndStatus, JsonValue } from "@openchamber/sdk"

/**
 * `unavailable`: remembered as running, but OpenChamber has neither seen it
 * end nor sees it running, because it ended while OpenChamber was not
 * watching (an app reload or restart). Never an invented outcome.
 */
export type JobStatus = "running" | GuestShellEndStatus | "unavailable"
export type Job = {
  id: string; sessionID: string; command: string; foreground: boolean
  started: number; completed?: number; status: JobStatus; exit?: number
}
export type Board = { foreground: Job[]; background: Job[] }

/** Background jobs remembered per conversation, newest kept. */
export const HISTORY_LIMIT = 100

const STATUSES: readonly JobStatus[] = ["running", "exited", "timeout", "killed", "stopped", "unknown", "unavailable"]

/** Remembered jobs from extension storage. A malformed entry is dropped, never trusted. */
export function parseHistory(value: JsonValue | undefined): Job[] {
  if (!Array.isArray(value)) return []
  const jobs: Job[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const { id, sessionID, command, started, completed, status, exit } = raw
    if (typeof id !== "string" || typeof sessionID !== "string" || typeof command !== "string" || typeof started !== "number") continue
    const known = STATUSES.find((entry) => entry === status)
    if (!known) continue
    const job: Job = { id, sessionID, command, foreground: false, started, status: known }
    if (typeof completed === "number") job.completed = completed
    if (typeof exit === "number") job.exit = exit
    jobs.push(job)
  }
  return jobs
}

export function serializeHistory(jobs: Job[]): JsonValue {
  return jobs.map(({ id, sessionID, command, started, completed, status, exit }) => {
    const entry: { [key: string]: JsonValue } = { id, sessionID, command, started, status }
    if (completed !== undefined) entry.completed = completed
    if (exit !== undefined) entry.exit = exit
    return entry
  })
}

const fromRunning = (shell: GuestRunningShell): Job => ({
  id: shell.id, sessionID: shell.sessionID, command: shell.command, foreground: !shell.background, started: shell.startedAt, status: "running",
})

const fromEnded = (shell: GuestEndedShell): Job => {
  const job: Job = { ...fromRunning(shell), foreground: false, completed: shell.endedAt, status: shell.status }
  if (shell.exit !== undefined) job.exit = shell.exit
  return job
}

/**
 * Merges what OpenChamber reports into the remembered background jobs.
 * Running commands and the ones OpenChamber saw end are authoritative. A
 * command the turn still waits for is a foreground job: shown while it runs,
 * never remembered. `unavailable` is not final: a later snapshot that lists
 * the job again (the host was still loading) restores its real state.
 */
export function merge(history: Job[], running: GuestRunningShell[], ended: GuestEndedShell[]): Board {
  const background = new Map(history.map((job) => [job.id, job]))
  const foreground: Job[] = []
  const live = new Set<string>()
  for (const shell of running) {
    live.add(shell.id)
    if (shell.background) background.set(shell.id, fromRunning(shell))
    else foreground.push(fromRunning(shell))
  }
  for (const shell of ended) {
    // A foreground command ends with its tool call; its agent got the result.
    if (shell.background || background.has(shell.id)) background.set(shell.id, fromEnded(shell))
  }
  for (const [id, job] of background) {
    if (job.status === "running" && !live.has(id)) background.set(id, { ...job, status: "unavailable" })
  }
  const jobs = [...background.values()]
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.started - a.started)
  return { foreground, background: jobs.slice(0, HISTORY_LIMIT) }
}
