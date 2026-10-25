import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SURFACES, normalizeSurfaces } from "../shared/surfaces.js";
import { FUN_PRESET_VERSION, migrateFunPresets } from "../shared/fun-core.js";

export const DEFAULT_CONFIG = Object.freeze({
  githubToken: "",
  githubOwner: "",
  includePatterns: [],
  excludePatterns: [],
  maxRepositories: 20,
  historyDepth: 64,
  backfillRunsPerRepo: 4,
  activeSurfaceId: "focus",
  surfaces: DEFAULT_SURFACES,
  surfacePresetVersion: FUN_PRESET_VERSION
});

function normalizePatterns(value) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

export class ConfigStore {
  constructor(dataDir = process.env.CISMON_DATA_DIR || path.join(os.homedir(), ".cismonweb")) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, "config.json");
    this.current = { ...DEFAULT_CONFIG, surfaces: normalizeSurfaces(DEFAULT_SURFACES) };
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8"));
      this.current = this.normalize({
        ...DEFAULT_CONFIG, ...parsed,
        surfacePresetVersion: FUN_PRESET_VERSION,
        surfaces: migrateFunPresets(parsed.surfaces, DEFAULT_SURFACES, parsed.surfacePresetVersion)
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (process.env.GITHUB_TOKEN) this.current.githubToken = process.env.GITHUB_TOKEN;
    if (process.env.CISMON_OWNER !== undefined) this.current.githubOwner = process.env.CISMON_OWNER;
    return this.current;
  }

  normalize(value) {
    const surfaces = normalizeSurfaces(value.surfaces);
    const requestedSurface = typeof value.activeSurfaceId === "string" ? value.activeSurfaceId : "";
    const activeSurfaceId = surfaces.some((surface) => surface.id === requestedSurface)
      ? requestedSurface
      : surfaces[0].id;
    return {
      ...DEFAULT_CONFIG,
      ...value,
      githubToken: typeof value.githubToken === "string" ? value.githubToken.trim() : "",
      githubOwner: typeof value.githubOwner === "string" ? value.githubOwner.trim() : "",
      includePatterns: normalizePatterns(value.includePatterns),
      excludePatterns: normalizePatterns(value.excludePatterns),
      maxRepositories: Math.min(100, Math.max(1, Number(value.maxRepositories) || DEFAULT_CONFIG.maxRepositories)),
      historyDepth: Math.min(256, Math.max(8, Number(value.historyDepth) || DEFAULT_CONFIG.historyDepth)),
      backfillRunsPerRepo: Math.min(20, Math.max(1, Number(value.backfillRunsPerRepo) || DEFAULT_CONFIG.backfillRunsPerRepo)),
      surfaces,
      activeSurfaceId
    };
  }

  publicConfig() {
    const { githubToken, ...safe } = this.current;
    return { ...safe, hasGithubToken: Boolean(githubToken) };
  }

  async update(input) {
    const next = { ...this.current, ...input };
    if (!input.githubToken) next.githubToken = input.clearGithubToken ? "" : this.current.githubToken;
    delete next.clearGithubToken;
    this.current = this.normalize(next);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(this.configPath, JSON.stringify(this.current, null, 2) + "\n", { mode: 0o600 });
    await chmod(this.configPath, 0o600).catch(() => {});
    return this.current;
  }
}
