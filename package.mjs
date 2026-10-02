import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const root = fileURLToPath(new URL(".", import.meta.url))
const dist = join(root, "dist")
const staging = await mkdtemp(join(tmpdir(), "openchamber-jobs-package-"))
const files = ["package.json", "README.md", "LICENSE", "connect.mjs", "panel/index.html", "panel/styles.css", "panel/main.js", "service/main.js"]
const archive = join(dist, "openchamber-jobs.zip")
try {
  for (const file of files) {
    const destination = join(staging, file)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(root, file), destination)
  }
  await mkdir(dist, { recursive: true })
  await rm(archive, { force: true })
  execFileSync("zip", ["-X", "-q", archive, ...files], { cwd: staging })
  const hash = createHash("sha256").update(await readFile(archive)).digest("hex")
  await writeFile(join(dist, "SHA256SUMS"), `${hash}  openchamber-jobs.zip\n`)
  console.log(`Packaged ${archive}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
