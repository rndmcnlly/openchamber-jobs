import { test } from "node:test"
import assert from "node:assert/strict"
import { build } from "esbuild"

const result = await build({ entryPoints: [new URL("../jobs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false })
const { merge, parseHistory, serializeHistory, HISTORY_LIMIT } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
const running = (id, sessionID = "ses_root", background = true, startedAt = 100) => ({ id, sessionID, command: `build ${id}`, startedAt, background })
const ended = (id, status, extra = {}) => ({ ...running(id), status, endedAt: 200, ...extra })
const remembered = (id, status = "running", extra = {}) => ({ id, sessionID: "ses_root", command: `build ${id}`, foreground: false, started: 100, status, ...extra })

test("running background commands become jobs; ones the turn waits for stay foreground", () => {
  const board = merge([], [running("sh_bg"), running("sh_fg", "ses_child", false)], [])
  assert.deepEqual(board.background.map((job) => [job.id, job.status]), [["sh_bg", "running"]])
  assert.deepEqual(board.foreground.map((job) => [job.id, job.foreground, job.sessionID]), [["sh_fg", true, "ses_child"]])
})

test("an ended job keeps its outcome, exit code and end time", () => {
  const board = merge([remembered("sh_1")], [], [ended("sh_1", "exited", { exit: 2 }), ended("sh_2", "stopped")])
  assert.deepEqual(board.background.map(({ id, status, exit, completed }) => ({ id, status, exit, completed })), [
    { id: "sh_1", status: "exited", exit: 2, completed: 200 },
    { id: "sh_2", status: "stopped", exit: undefined, completed: 200 },
  ])
})

test("a foreground command that ended is not remembered", () => {
  assert.deepEqual(merge([], [], [{ ...ended("sh_fg", "exited", { exit: 0 }), background: false }]).background, [])
})

test("a remembered running job nobody reports is unavailable until a snapshot lists it again", () => {
  const lost = merge([remembered("sh_1")], [], [])
  assert.equal(lost.background[0].status, "unavailable")
  assert.equal(merge(lost.background, [running("sh_1")], []).background[0].status, "running")
  assert.equal(merge(lost.background, [], [ended("sh_1", "timeout")]).background[0].status, "timeout")
})

test("finished history stays as it was; running jobs sort first, then newest", () => {
  const board = merge([remembered("sh_old", "exited", { exit: 0, started: 10 })], [running("sh_new", "ses_root", true, 300), running("sh_mid", "ses_root", true, 50)], [])
  assert.deepEqual(board.background.map((job) => job.id), ["sh_new", "sh_mid", "sh_old"])
  assert.equal(board.background[2].status, "exited")
})

test("history is capped to the newest jobs", () => {
  const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => remembered(`sh_${index}`, "exited", { started: index, exit: 0 }))
  const board = merge(many, [], [])
  assert.equal(board.background.length, HISTORY_LIMIT)
  assert.equal(board.background.at(-1).id, "sh_5")
})

test("stored history round-trips and drops malformed entries", () => {
  const jobs = [remembered("sh_1", "exited", { exit: 0, completed: 200 }), remembered("sh_2", "stopped")]
  assert.deepEqual(parseHistory(serializeHistory(jobs)), jobs)
  assert.deepEqual(parseHistory([{ id: "sh_x", status: "exploded" }, null, "text", { id: 1 }]), [])
  assert.deepEqual(parseHistory(undefined), [])
  assert.deepEqual(parseHistory({ id: "sh_1" }), [])
})
