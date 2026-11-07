import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SURFACES, normalizeSurfaces } from "../shared/surfaces.js";
import { FUN_PRESET_VERSION, migrateFunPresets } from "../shared/fun-core.js";
import { normalizeSelectionMode, normalizeActiveAgeDays } from "./activity-selection.js";

export const DEFAULT_CONFIG = Object.freeze({
  githubToken: "",
  githubOwner: "",
  includePatterns: [],
  excludePatterns: [],
  maxRepositories: 20,
  historyDepth: 64,
  backfillRunsPerRepo: 4,
  repositorySelectionMode: "activity",
  activeAgeDays: 7,
  activeSurfaceId: "focus",
  surfaces: DEFAULT_SURFACES,
  surfacePresetVersion: FUN_PRESET_VERSION,
  focusUxVersion: 2
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
    this.stored = { ...DEFAULT_CONFIG, surfaces: normalizeSurfaces(DEFAULT_SURFACES) };
    this.environmentToken = process.env.GITHUB_TOKEN || "";
    this.environmentOwner = process.env.CISMON_OWNER;
    this.current = this.effectiveConfig(this.stored);
    this.pendingUpdate = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("configuration must be a JSON object");
      }
      const oldSurfaces = migrateFunPresets(parsed.surfaces, DEFAULT_SURFACES, parsed.surfacePresetVersion);
      // Migrate only once. Existing tuned profiles survive unchanged; a
      // deliberately deleted Focus Dual will not reappear on next restart.
      const migrated = Array.isArray(oldSurfaces) ? [...oldSurfaces] : [...DEFAULT_SURFACES];
      if ((parsed.focusUxVersion || 0) < 1 && !migrated.some(p => p.id === "focus-dual")) {
        migrated.push(DEFAULT_SURFACES.find(p => p.id === "focus-dual"));
      }
      if ((parsed.focusUxVersion || 0) < 2 && !migrated.some(p => p.id === "focus-vert")) {
        migrated.push(DEFAULT_SURFACES.find(p => p.id === "focus-vert"));
      }
      this.stored = this.normalize({
        ...DEFAULT_CONFIG, ...parsed,
        focusUxVersion: 2,
        surfacePresetVersion: FUN_PRESET_VERSION,
        surfaces: migrated
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this.current = this.effectiveConfig(this.stored);
    return this.current;
  }

  effectiveConfig(stored) {
    return {
      ...stored,
      githubToken: this.environmentToken || stored.githubToken,
      githubOwner: this.environmentOwner !== undefined ? this.environmentOwner : stored.githubOwner
    };
  }

  normalize(value) {
    const surfaces = normalizeSurfaces(value.surfaces);
    const requestedSurface = typeof value.activeSurfaceId === "string" ? value.activeSurfaceId : "";
    const activeSurfaceId = surfaces.some((surface) => surface.id === requestedSurface)
      ? requestedSurface
      : surfaces[0].id;
    return {
      ...DEFAULT_CONFIG,
      // Only persisted settings belong in the configuration. Derived public
      // flags (and unrelated request fields) must not round-trip to disk.
      ...Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])),
      githubToken: typeof value.githubToken === "string" ? value.githubToken.trim() : "",
      githubOwner: typeof value.githubOwner === "string" ? value.githubOwner.trim() : "",
      includePatterns: normalizePatterns(value.includePatterns),
      excludePatterns: normalizePatterns(value.excludePatterns),
      maxRepositories: Math.min(100, Math.max(1, Number(value.maxRepositories) || DEFAULT_CONFIG.maxRepositories)),
      historyDepth: Math.min(256, Math.max(8, Number(value.historyDepth) || DEFAULT_CONFIG.historyDepth)),
      backfillRunsPerRepo: Math.min(20, Math.max(1, Number(value.backfillRunsPerRepo) || DEFAULT_CONFIG.backfillRunsPerRepo)),
      repositorySelectionMode: normalizeSelectionMode(value.repositorySelectionMode),
      activeAgeDays: normalizeActiveAgeDays(value.activeAgeDays),
      surfaces,
      activeSurfaceId
    };
  }

  publicConfig() {
    const { githubToken, ...safe } = this.current;
    return {
      ...safe,
      hasGithubToken: Boolean(githubToken),
      hasStoredGithubToken: Boolean(this.stored.githubToken),
      githubTokenSource: this.environmentToken ? "environment" : (this.stored.githubToken ? "stored" : "none")
    };
  }

  async update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("configuration update must be a JSON object");
    }
    const patch = structuredClone(input);
    const operation = this.pendingUpdate.then(() => this.persistUpdate(patch));
    // A failed save leaves the accepted state intact and must not prevent a
    // later retry. Each patch is merged only when its turn to write begins.
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  async persistUpdate(input) {
    const next = { ...this.stored, ...input };
    if (typeof input.githubToken !== "string" || !input.githubToken.trim()) {
      next.githubToken = input.clearGithubToken ? "" : this.stored.githubToken;
    }
    const stored = this.normalize(next);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = this.configPath + "." + randomUUID() + ".tmp";
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(stored, null, 2) + "\n", "utf8");
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, this.configPath);
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    this.stored = stored;
    this.current = this.effectiveConfig(stored);
    return this.current;
  }
}
