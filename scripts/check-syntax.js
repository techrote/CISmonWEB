import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
let checked = 0;

async function checkDirectory(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(relative);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path.join(root, relative)], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
      checked++;
    }
  }
}

for (const directory of ["src", "shared", "public", "scripts"]) await checkDirectory(directory);
console.log("Syntax checked " + checked + " JavaScript files.");
