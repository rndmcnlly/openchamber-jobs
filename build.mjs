import { build } from "esbuild"
import { fileURLToPath } from "node:url"

const absWorkingDir = fileURLToPath(new URL(".", import.meta.url))

await build({ absWorkingDir, entryPoints: ["panel/main.ts"], bundle: true, format: "iife", platform: "browser", outfile: "panel/main.js" })
