import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { parseManifestJson } from "@openchamber/sdk/schemas"

const root = new URL("../", import.meta.url)
const version = JSON.parse(await readFile(new URL("package.json", root), "utf8")).version
const expectedFiles = ["LICENSE", "README.md", "package.json", "panel/index.html", "panel/main.js", "panel/styles.css"]

async function checkManifest(directory) {
  const parsed = parseManifestJson(await readFile(new URL("package.json", directory), "utf8"))
  assert.equal(parsed.ok, true, parsed.message)
  assert.equal(parsed.version, version)
  assert.equal(parsed.manifest.contributes.panel.id, "openchamber-jobs")
  assert.deepEqual(parsed.manifest.contributes.capabilities, ["shells", "sessions"])
  // Everything goes through the host: no local service, no backend credentials.
  assert.equal(parsed.manifest.contributes.service, undefined)
  for (const file of [parsed.manifest.contributes.panel.entry, "panel/main.js", "panel/styles.css"]) await access(new URL(file, directory))
}

test("filesystem package has a valid manifest and runnable entries", () => checkManifest(root))

test("release ZIP contains only runtime files", async () => {
  const zip = fileURLToPath(new URL("dist/openchamber-jobs.zip", root))
  assert.deepEqual(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").sort(), expectedFiles)
  const checksum = createHash("sha256").update(await readFile(zip)).digest("hex")
  assert.equal(await readFile(new URL("dist/SHA256SUMS", root), "utf8"), `${checksum}  openchamber-jobs.zip\n`)
  const directory = await mkdtemp(join(tmpdir(), "openchamber-jobs-release-"))
  try {
    execFileSync("unzip", ["-q", zip, "-d", directory])
    await checkManifest(new URL(`file://${directory}/`))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
