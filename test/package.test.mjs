import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { parseManifestJson } from "@openchamber/sdk/schemas"

const root = new URL("../", import.meta.url)
const version = JSON.parse(await readFile(new URL("package.json", root), "utf8")).version
const expectedFiles = ["LICENSE", "README.md", "package.json", "panel/index.html", "panel/main.js", "panel/styles.css", "service/main.js"]

async function checkManifest(directory) {
  const parsed = parseManifestJson(await readFile(new URL("package.json", directory), "utf8"))
  assert.equal(parsed.ok, true, parsed.message)
  assert.equal(parsed.version, version)
  assert.equal(parsed.manifest.contributes.panel.id, "openchamber-jobs")
  assert.deepEqual(parsed.manifest.contributes.service.provides, ["opencode"])
  assert.deepEqual(parsed.manifest.contributes.capabilities, ["shells"])
  assert.deepEqual(parsed.manifest.contributes.service.permissions?.exec ?? [], [])
  for (const file of [parsed.manifest.contributes.panel.entry, "panel/main.js", "panel/styles.css", parsed.manifest.contributes.service.entry]) await access(new URL(file, directory))
}

test("filesystem package has a valid manifest and runnable entries", () => checkManifest(root))

test("release ZIP contains only runtime files and its service runs without dependencies", async () => {
  const zip = fileURLToPath(new URL("dist/openchamber-jobs.zip", root))
  assert.deepEqual(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").sort(), expectedFiles)
  const checksum = createHash("sha256").update(await readFile(zip)).digest("hex")
  assert.equal(await readFile(new URL("dist/SHA256SUMS", root), "utf8"), `${checksum}  openchamber-jobs.zip\n`)
  const directory = await mkdtemp(join(tmpdir(), "openchamber-jobs-release-"))
  let child
  const calls = []
  const backend = createServer((request, response) => {
    calls.push([request.method, request.url, request.headers.authorization])
    const url = new URL(request.url, "http://localhost")
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(
      url.pathname === "/api/session/ses_fixture" ? { data: { id: "ses_fixture", location: { directory: "/project" } } } : { data: [] },
    ))
  })
  try {
    execFileSync("unzip", ["-q", zip, "-d", directory])
    await checkManifest(new URL(`file://${directory}/`))
    const server = createServer()
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    backend.listen(0, "127.0.0.1")
    await once(backend, "listening")
    child = spawn(process.execPath, [join(directory, "service/main.js")], {
      cwd: directory,
      env: { HOME: directory, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: "test-token",
        OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${backend.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let errors = ""
    child.stderr.on("data", chunk => { errors += chunk })
    const url = `http://127.0.0.1:${port}`
    let response
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, errors)
      try { response = await fetch(`${url}/health`, { headers: { authorization: "Bearer test-token" } }); break }
      catch { await new Promise(resolve => setTimeout(resolve, 25)) }
    }
    assert.ok(response, `Service did not start: ${errors}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal((await fetch(`${url}/health`)).status, 401)
    const headers = { authorization: "Bearer test-token" }
    assert.equal((await fetch(`${url}/history?session=not-a-session`, { headers })).status, 400)
    assert.equal((await fetch(`${url}/jobs/sh_fixture/stop?session=ses_fixture`, { headers, method: "POST" })).status, 404)
    const history = await fetch(`${url}/history?session=ses_fixture`, { headers })
    assert.equal(history.status, 200)
    assert.deepEqual((await history.json()).jobs, [])
    assert.deepEqual(calls, [
      ["GET", "/api/session/ses_fixture", "Bearer test-token"],
      ["GET", "/api/session?parentID=ses_fixture&limit=100", "Bearer test-token"],
      ["GET", "/api/session/ses_fixture/message?type=assistant&limit=100&order=desc", "Bearer test-token"],
      ["GET", "/api/session/ses_fixture/message?type=synthetic&limit=100&order=desc", "Bearer test-token"],
    ])
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit") }
    if (backend.listening) await new Promise(resolve => backend.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
