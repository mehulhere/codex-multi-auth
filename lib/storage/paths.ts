/**
 * Path resolution utilities for account storage.
 * Extracted from storage.ts to reduce module size.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".codex"];
const PROJECTS_DIR = "projects";
const PROJECT_KEY_HASH_LENGTH = 12;

/**
 * Gets the path to the global Codex multi-auth configuration directory.
 *
 * The returned path is platform-specific (may use Windows separators and casing). The directory is intended for concurrent use by multiple processes; callers should treat its contents as sensitive (redact tokens/credentials when logging).
 *
 * @returns The absolute filesystem path to the Codex multi-auth configuration directory.
 */
export function getConfigDir(): string {
	return getCodexMultiAuthDir();
}

/**
 * Get the per-project .codex directory path inside the given project path.
 *
 * This function is pure and safe for concurrent use. The returned path uses the platform's native separators; on Windows, casing and separators follow OS semantics and callers should normalize if needed. The returned value may contain sensitive segments derived from `projectPath`; callers should redact secrets before logging.
 *
 * @param projectPath - Project directory path (absolute or relative)
 * @returns The path to the project's ".codex" configuration directory
 */
export function getProjectConfigDir(projectPath: string): string {
	return join(projectPath, ".codex");
}

/**
 * Normalize a project filesystem path for consistent comparison and storage.
 *
 * Produces an absolute path with forward slashes; on Windows the path is also converted to lowercase
 * to make comparisons case-insensitive. This function is pure and safe for concurrent use.
 *
 * Note: this function does not redact or remove sensitive tokens from the path — callers must
 * perform any required redaction before logging or exposing paths.
 *
 * @param projectPath - The input path to normalize
 * @returns The absolute, forward-slash-normalized path; on Windows the result is lowercased
 */
function normalizeProjectPath(projectPath: string): string {
	const resolvedPath = resolve(projectPath);
	const normalizedSeparators = resolvedPath.replace(/\\/g, "/");
	return process.platform === "win32"
		? normalizedSeparators.toLowerCase()
		: normalizedSeparators;
}

function sanitizeProjectName(projectPath: string): string {
	const name = basename(projectPath);
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "project";
}

/**
 * Produce a deterministic storage key for a project path by combining a sanitized project name and a fixed-length path hash.
 *
 * The resulting key has the form `<sanitized-name>-<truncated-hex>` where the name is derived from the project's basename (disallowed characters replaced and trimmed) and the hex segment is a truncated hash of the normalized path. On Windows the path is normalized to lowercase before hashing to ensure case-insensitive equivalence. The function is pure and safe for concurrent use.
 *
 * @param projectPath - Path to the project (any form accepted; will be normalized before key generation)
 * @returns A storage key string suitable for use as a per-project directory/name (sanitized name up to 40 chars, a dash, then a fixed-length hex hash)
 */
export function getProjectStorageKey(projectPath: string): string {
	const normalizedPath = normalizeProjectPath(projectPath);
	const hash = createHash("sha256")
		.update(normalizedPath)
		.digest("hex")
		.slice(0, PROJECT_KEY_HASH_LENGTH);
	const projectName = sanitizeProjectName(normalizedPath).slice(0, 40);
	return `${projectName}-${hash}`;
}

/**
 * Compute the global per-project storage directory path under the Codex multi-auth projects directory.
 *
 * The returned path is grounded in the global Codex multi-auth config directory and is namespaced
 * by a filesystem-friendly project storage key derived from `projectPath` (sanitized and hashed to
 * avoid embedding sensitive tokens or raw paths).
 *
 * Concurrency: the resulting directory may be accessed by multiple processes; callers are responsible
 * for any required concurrency-safe operations when creating or mutating files within it.
 *
 * Windows: storage key derivation normalizes path separators and casing to produce stable keys on
 * Windows hosts.
 *
 * @param projectPath - The project filesystem path used to derive the per-project storage key.
 * @returns The absolute path to the project's storage directory under the global Codex multi-auth projects directory.
 */
export function getProjectGlobalConfigDir(projectPath: string): string {
	return join(getConfigDir(), PROJECTS_DIR, getProjectStorageKey(projectPath));
}

export function isProjectDirectory(dir: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

export function findProjectRoot(startDir: string): string | null {
	let current = startDir;
	const root = dirname(current) === current ? current : null;
	
	while (current) {
		if (isProjectDirectory(current)) {
			return current;
		}
		
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	
	return root && isProjectDirectory(root) ? root : null;
}

function normalizePathForComparison(filePath: string): string {
	const resolvedPath = resolve(filePath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const rel = relative(normalizedBase, normalizedTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolvePath(filePath: string): string {
	let resolved: string;
	if (filePath.startsWith("~")) {
		resolved = join(homedir(), filePath.slice(1));
	} else {
		resolved = resolve(filePath);
	}

	const home = homedir();
	const cwd = process.cwd();
	const tmp = tmpdir();
	if (
		!isWithinDirectory(home, resolved) &&
		!isWithinDirectory(cwd, resolved) &&
		!isWithinDirectory(tmp, resolved)
	) {
		throw new Error(`Access denied: path must be within home directory, project directory, or temp directory`);
	}

	return resolved;
}
