import { createServer } from "node:http"
import { JobHistory, type Api, type History } from "../jobs.js"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN
const upstream = process.env.OPENCHAMBER_OPENCODE_URL
if (!port || !token) throw new Error("OpenChamber service port and token are required")

const api: Api = async <T>(path: string, query: Record<string, string> = {}) => {
  if (!upstream) throw new Error("Approve OpenCode access for Jobs in Settings → Extensions.")
  const url = new URL(path, upstream)
  url.search = new URLSearchParams(query).toString()
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`OpenChamber OpenCode history: HTTP ${response.status}`)
  return await response.json() as T
}
const history = new JobHistory(api)
// Related roots can update the same session's incremental history.
const pending = new Map<string, Promise<History>>()
let queue: Promise<unknown> = Promise.resolve()
function read(root: string) {
  const existing = pending.get(root)
  if (existing) return existing
  const next = queue.then(() => history.list(root)).finally(() => pending.delete(root))
  pending.set(root, next)
  queue = next.catch(() => {})
  return next
}

createServer(async (request, response) => {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
  }
  if (request.headers.authorization !== `Bearer ${token}`) { json(401, { error: "Unauthorized" }); return }
  const url = new URL(request.url ?? "/", "http://localhost")
  if (request.method === "GET" && url.pathname === "/health") { json(200, { ok: true }); return }
  if (request.method !== "GET" || url.pathname !== "/history") { json(404, { error: "Not found" }); return }
  const root = url.searchParams.get("session") ?? ""
  if (!/^ses_[\w-]+$/.test(root)) { json(400, { error: "A session ID is required" }); return }
  try { json(200, await read(root)) }
  catch (error) { json(503, { error: error instanceof Error ? error.message : "Job history unavailable" }) }
}).listen(port, "127.0.0.1")
