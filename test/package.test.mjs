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
const expectedFiles = ["LICENSE", "README.md", "connect.mjs", "package.json", "panel/index.html", "panel/main.js", "panel/styles.css", "service/main.js"]

async function checkManifest(directory) {
  const parsed = parseManifestJson(await readFile(new URL("package.json", directory), "utf8"))
  assert.equal(parsed.ok, true, parsed.message)
  assert.equal(parsed.version, version)
  assert.equal(parsed.manifest.contributes.panel.id, "openchamber-jobs")
  assert.deepEqual(parsed.manifest.contributes.service.permissions.exec, ["ps"])
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
  try {
    execFileSync("unzip", ["-q", zip, "-d", directory])
    await checkManifest(new URL(`file://${directory}/`))
    const server = createServer()
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    child = spawn(process.execPath, [join(directory, "service/main.js")], {
      cwd: directory,
      env: { ...process.env, HOME: directory, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: "test-token" },
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
    assert.equal((await fetch(`${url}/jobs?session=not-a-session`, { headers: { authorization: "Bearer test-token" } })).status, 400)
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit") }
    await rm(directory, { recursive: true, force: true })
  }
})
