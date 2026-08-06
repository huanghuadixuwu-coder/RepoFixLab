/**
 * Artifact Store for durable, immutable RepoFixLab run evidence.
 *
 * This module owns the run output directory and provides:
 * - Safe relative-path resolution below a single artifact root
 * - Exclusive creation with byte count, SHA-256, producer, and sensitivity metadata
 * - Fsynced append-only streams for journals and event logs
 * - Atomic publication of a completed staging directory
 */

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Component identities allowed to claim authorship of a stored artifact. */
export type ArtifactProducer = "orchestrator" | "agent" | "controller" | "evaluator";

/** Visibility classification recorded with every stored artifact. */
export type ArtifactSensitivity = "public" | "internal" | "private";

/** Immutable metadata describing one registered run artifact. */
export interface StoredArtifact {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly mediaType: string;
	readonly sensitivity: ArtifactSensitivity;
	readonly generatedBy: ArtifactProducer;
}

/** Provenance and media metadata supplied when an artifact is registered. */
export interface StoreArtifactOptions {
	readonly mediaType: string;
	readonly sensitivity: ArtifactSensitivity;
	readonly generatedBy: ArtifactProducer;
}

/** Identify the expected missing-path error without hiding other I/O failures. */
function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Reject absolute, empty, Windows-style, NUL-containing, and traversing paths. */
function assertSafeRelativePath(path: string): void {
	if (
		path.length === 0 ||
		path.includes("\\") ||
		path.includes("\0") ||
		isAbsolute(path) ||
		path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`Artifact path is unsafe: ${path}`);
	}
}

/** Require a candidate to name a descendant file rather than the root itself. */
function assertWithin(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Artifact path must name a file beneath ${root}`);
	}
}

/** Convert text to stable UTF-8 bytes while preserving binary content. */
function contentBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

/** Compute the lowercase SHA-256 identity recorded in artifact metadata. */
function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Owns exclusive artifact creation and atomic publication for one run directory. */
export class ArtifactStore {
	private root: string;
	private realRoot: string;
	private readonly artifacts = new Map<string, StoredArtifact>();
	private openAppendOnlyFiles = 0;

	/** Bind the logical and canonical roots after their safety checks succeed. */
	private constructor(root: string, realRoot: string) {
		this.root = root;
		this.realRoot = realRoot;
	}

	/** Create a fresh staging root and refuse to reuse existing run evidence. */
	static async createNew(root: string): Promise<ArtifactStore> {
		const resolvedRoot = resolve(root);
		await mkdir(dirname(resolvedRoot), { recursive: true });
		try {
			await lstat(resolvedRoot);
			throw new Error(`Refusing to reuse existing run directory ${resolvedRoot}`);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		await mkdir(resolvedRoot);
		const rootStats = await lstat(resolvedRoot);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
			throw new Error(`Run artifact root is not a regular directory: ${resolvedRoot}`);
		}
		return new ArtifactStore(resolvedRoot, await realpath(resolvedRoot));
	}

	/** Open an interrupted staging directory without altering existing evidence. */
	static async openExisting(root: string): Promise<ArtifactStore> {
		const resolvedRoot = resolve(root);
		const rootStats = await lstat(resolvedRoot);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
			throw new Error(`Run artifact root is not a regular directory: ${resolvedRoot}`);
		}
		return new ArtifactStore(resolvedRoot, await realpath(resolvedRoot));
	}

	/** Return the current staging or published artifact root. */
	get rootPath(): string {
		return this.root;
	}

	/** Atomically rename a closed staging directory to its final sibling path. */
	async publishTo(root: string): Promise<void> {
		if (this.openAppendOnlyFiles !== 0)
			throw new Error("Artifact store publication requires all append-only files to be closed");

		const publishedRoot = resolve(root);
		if (dirname(publishedRoot) !== dirname(this.root)) {
			throw new Error("Artifact store publication must be an atomic sibling-directory rename");
		}
		try {
			await lstat(publishedRoot);
			throw new Error(`Refusing to publish over existing run directory ${publishedRoot}`);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		await rename(this.root, publishedRoot);
		await this.syncDirectory(dirname(publishedRoot));
		this.root = publishedRoot;
		this.realRoot = await realpath(publishedRoot);
	}

	/** Resolve a safe artifact-relative path below the owned root. */
	resolvePath(path: string): string {
		assertSafeRelativePath(path);
		const candidate = resolve(this.root, path);
		assertWithin(this.root, candidate);
		return candidate;
	}

	/** Durably create and register one immutable artifact without overwriting. */
	async writeNew(path: string, content: string | Uint8Array, options: StoreArtifactOptions): Promise<StoredArtifact> {
		if (this.artifacts.has(path)) throw new Error(`Artifact is already registered: ${path}`);
		const candidate = this.resolvePath(path);
		await this.ensureParent(dirname(candidate));
		const bytes = contentBytes(content);
		const temporaryPath = `${candidate}.${process.pid}.${randomUUID()}.tmp`;
		let published = false;
		try {
			const file = await open(temporaryPath, "wx", 0o600);
			try {
				await file.writeFile(bytes);
				await file.sync();
			} finally {
				await file.close();
			}
			await link(temporaryPath, candidate);
			published = true;
			await unlink(temporaryPath);
			await this.syncDirectory(dirname(candidate));
		} finally {
			if (!published) {
				await unlink(temporaryPath).catch((error: unknown) => {
					if (!isMissingPathError(error)) throw error;
				});
			}
		}
		const artifact: StoredArtifact = {
			path,
			bytes: bytes.byteLength,
			sha256: sha256(bytes),
			mediaType: options.mediaType,
			sensitivity: options.sensitivity,
			generatedBy: options.generatedBy,
		};
		this.artifacts.set(path, artifact);
		return artifact;
	}

	/** Create an exclusive append-only artifact that must close before publication. */
	async createAppendOnlyFile(path: string): Promise<AppendOnlyArtifactFile> {
		if (this.artifacts.has(path)) throw new Error(`Artifact is already registered: ${path}`);
		const candidate = this.resolvePath(path);
		await this.ensureParent(dirname(candidate));
		const file = await open(candidate, "wx", 0o600);
		await this.syncDirectory(dirname(candidate));
		this.openAppendOnlyFiles += 1;
		return new AppendOnlyArtifactFile(this, path, file, () => {
			if (this.openAppendOnlyFiles === 0) throw new Error("Artifact store append-only file accounting underflow");
			this.openAppendOnlyFiles -= 1;
		});
	}

	/** Return registered artifact metadata in deterministic path order. */
	listArtifacts(): readonly StoredArtifact[] {
		return [...this.artifacts.values()].sort((left, right) => left.path.localeCompare(right.path));
	}

	/** Read bytes from a safely resolved artifact path. */
	async read(path: string): Promise<Uint8Array> {
		return readFile(this.resolvePath(path));
	}

	/** Hash and register a closed regular file that remains under the real root. */
	async registerClosedFile(path: string, options: StoreArtifactOptions): Promise<StoredArtifact> {
		if (this.artifacts.has(path)) throw new Error(`Artifact is already registered: ${path}`);
		const candidate = this.resolvePath(path);
		const candidateStats = await lstat(candidate);
		if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
			throw new Error(`Artifact is not a regular file: ${path}`);
		}
		assertWithin(this.realRoot, await realpath(candidate));
		const bytes = await readFile(candidate);
		const artifact: StoredArtifact = {
			path,
			bytes: bytes.byteLength,
			sha256: sha256(bytes),
			mediaType: options.mediaType,
			sensitivity: options.sensitivity,
			generatedBy: options.generatedBy,
		};
		this.artifacts.set(path, artifact);
		return artifact;
	}

	/** Create safe parent directories while rejecting symlink traversal. */
	private async ensureParent(parent: string): Promise<void> {
		if (parent !== this.root) assertWithin(this.root, parent);
		let current = this.root;
		for (const segment of relative(this.root, parent)
			.split(sep)
			.filter((value) => value.length > 0)) {
			current = join(current, segment);
			try {
				const currentStats = await lstat(current);
				if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
					throw new Error(`Artifact parent is not a regular directory: ${current}`);
				}
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
				await mkdir(current);
			}
		}
		const realParent = await realpath(parent);
		if (realParent !== this.realRoot) assertWithin(this.realRoot, realParent);
	}

	/** Fsync a directory so its entry changes survive a crash. */
	private async syncDirectory(path: string): Promise<void> {
		const directory = await open(path, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}

type AppendFileHandle = Awaited<ReturnType<typeof open>>;

/** Owns one fsynced append-only evidence stream until it is closed and registered. */
export class AppendOnlyArtifactFile {
	private readonly store: ArtifactStore;
	private readonly relativePath: string;
	private readonly release: () => void;
	private readonly file: AppendFileHandle;
	private closed = false;

	/** Bind the open file to its store and publication-accounting release callback. */
	constructor(store: ArtifactStore, relativePath: string, file: AppendFileHandle, release: () => void) {
		this.store = store;
		this.relativePath = relativePath;
		this.release = release;
		this.file = file;
	}

	/** Append UTF-8 evidence and fsync it before reporting success. */
	async append(content: string): Promise<void> {
		if (this.closed) throw new Error(`Append-only artifact is closed: ${this.relativePath}`);
		await this.file.write(content, null, "utf8");
		await this.file.sync();
	}

	/** Close, release publication accounting, and register final metadata. */
	async close(options: StoreArtifactOptions): Promise<StoredArtifact> {
		if (this.closed) throw new Error(`Append-only artifact is already closed: ${this.relativePath}`);
		let syncError: unknown = null;
		try {
			await this.file.sync();
		} catch (error) {
			syncError = error;
		}
		await this.file.close();
		this.closed = true;
		this.release();
		if (syncError !== null) throw syncError;
		const closedStats = await stat(this.store.resolvePath(this.relativePath));
		if (!closedStats.isFile()) throw new Error(`Append-only artifact disappeared: ${this.relativePath}`);
		return this.store.registerClosedFile(this.relativePath, options);
	}
}
