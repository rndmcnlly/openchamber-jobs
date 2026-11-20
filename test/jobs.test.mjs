import { test } from "node:test"
import assert from "node:assert/strict"
import { archiveJobs, JobHistory, mergeJobs } from "../jobs.ts"

const session = id => ({ id, location: { directory: "/project" } })
const tool = (id, monitor = false) => ({ type: "tool", name: "shell", time: { ran: 100 },
  state: { input: { background: true, command: `echo ${id}`, monitor }, metadata: { shellID: id } } })
const shell = (id, background = true, sessionID = "ses_child") => ({
  id, background, sessionID, command: `echo ${id}`, startedAt: 100,
})
const snapshot = (shells = [], ended = []) => ({ kind: "shells", scope: { kind: "session", sessionId: "ses_root" }, shells, ended })
const history = jobs => ({ sessions: [session("ses_root"), session("ses_child")], jobs, warnings: [] })

test("reads paginated descendant history, structured monitor input and legacy cancellation records", async () => {
  let head = { id: "pending", content: [{ type: "text", text: "sh_fake" }] }
  const cancellation = source => ({ source, event: "job.cancelled", actor: "human", shellID: `sh_${source}`, sessionID: "ses_child", cancelledAt: 200 })
  const jobs = new JobHistory(async (path, q) => {
    if (path === "/api/session/ses_root") return { data: session("ses_root") }
    if (path === "/api/session") {
      if (q.parentID === "ses_root" && !q.cursor) return { data: [], cursor: { next: "children" } }
      return { data: q.parentID === "ses_root" ? [session("ses_child")] : [] }
    }
    if (path === "/api/session/ses_root/message") return { data: [] }
    assert.equal(path, "/api/session/ses_child/message")
    if (q.type === "synthetic") return { data: [
      { id: "done", metadata: { source: "shell", shellID: "sh_done", exit: 0 } },
      ...["openchamber-jobs", "opencode-monitor"].map(source => ({ id: source, metadata: cancellation(source) })),
    ] }
    return q.cursor ? { data: [{ id: "older", content: [tool("sh_done"), tool("sh_opencode-monitor"), tool("sh_openchamber-jobs")] }] }
      : { data: [head], cursor: { next: "older" } }
  })
  const first = await jobs.list("ses_root")
  assert.equal(first.sessions.length, 2)
  assert.deepEqual(first.jobs.map(job => [job.id, job.status, job.cancelledBy]), [
    ["sh_done", "exited", undefined], ["sh_opencode-monitor", "killed", "human"], ["sh_openchamber-jobs", "killed", "human"],
  ])
  head = { ...head, content: [tool("sh_live", true)] }
  const refreshed = await jobs.list("ses_root")
  assert.equal(refreshed.jobs.find(job => job.id === "sh_live").monitored, true)
  assert.equal(first.jobs.length, 3)
})

test("host snapshot owns live state, regardless of whether history is available", () => {
  const live = snapshot([shell("sh_live"), shell("sh_foreground", false)], [
    { ...shell("sh_finished_foreground", false), status: "exited", endedAt: 200 },
    { ...shell("sh_stopped"), status: "stopped", endedAt: 200 },
  ])
  assert.deepEqual(new Set(mergeJobs(undefined, live).map(job => job.id)), new Set(["sh_live", "sh_foreground", "sh_stopped"]))
  const jobs = mergeJobs(history([{ id: "sh_live", sessionID: "ses_child", monitored: true, status: "unavailable" }]), live)
  assert.deepEqual(jobs.map(job => [job.id, job.status, job.monitored, job.foreground]), [
    ["sh_live", "running", true, false], ["sh_foreground", "running", false, true], ["sh_stopped", "stopped", false, false],
  ])
})

test("archived outcomes survive panel reload without implying output access or overriding durable records", () => {
  const observed = mergeJobs(undefined, snapshot([], [{ ...shell("sh_ended"), status: "exited", exit: 0, endedAt: 200 }]))
  const archive = JSON.parse(JSON.stringify(archiveJobs(observed)))
  const record = { id: "sh_ended", sessionID: "ses_child", monitored: true, status: "unavailable", command: "full", started: 100 }
  const [restored] = mergeJobs(history([record]), undefined, archive)
  assert.deepEqual([restored.status, restored.exit, restored.monitored, restored.native], ["exited", 0, true, false])
  const [reconnected] = mergeJobs(history([{ ...record, status: "exited", exit: 1 }]), snapshot([], [
    { ...shell("sh_ended"), status: "unknown", endedAt: 300 },
  ]), archive)
  assert.deepEqual([reconnected.status, reconnected.exit], ["exited", 1])
  assert.ok(Buffer.byteLength(JSON.stringify(archiveJobs(Array.from({ length: 300 }, (_, i) => ({
    ...restored, id: `sh_${i}`, command: "🙂".repeat(1000),
  }))))) <= 60 * 1024)
})
