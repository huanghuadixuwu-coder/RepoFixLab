import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ArtifactProducer = "orchestrator" | "agent" | "controller" | "evaluator";
export type ArtifactSensitivity = "public" | "internal" | "private";

export interface StoredArtifact {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly mediaType: string;
	readonly sensitivity: ArtifactSensitivity;
	readonly generatedBy: ArtifactProducer;
}

export interface StoreArtifactOptions {
	readonly mediaType: string;
	readonly sensitivity: ArtifactSensitivity;
	readonly generatedBy: ArtifactProducer;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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

function assertWithin(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Artifact path must name a file beneath ${root}`);
	}
}

function contentBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export class ArtifactStore {
	private root: string;
	private realRoot: string;
	private readonly artifacts = new Map<string, StoredArtifact>();
	private openAppendOnlyFiles = 0;

	private constructor(root: string, realRoot: string) {
		this.root = root;
		this.realRoot = realRoot;
	}

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

	/** Opens an interrupted staging directory without altering existing evidence. */
	static async openExisting(root: string): Promise<ArtifactStore> {
		const resolvedRoot = resolve(root);
		const rootStats = await lstat(resolvedRoot);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
			throw new Error(`Run artifact root is not a regular directory: ${resolvedRoot}`);
		}
		return new ArtifactStore(resolvedRoot, await realpath(resolvedRoot));
	}

	get rootPath(): string {
		return this.root;
	}

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

	resolvePath(path: string): string {
		assertSafeRelativePath(path);
		const candidate = resolve(this.root, path);
		assertWithin(this.root, candidate);
		return candidate;
	}

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

	async createAppendOnlyFile(path: string): Promise<AppendOnlyArtifactFile> {
		if (this.artifacts.has(path)) throw new Error(`Artifact is already registered: ${path}`);
		const candidate = this.resolvePath(path);
		await this.ensureParent(dirname(candidate));
		const file = await open(candidate, "wx", 0o600);
		await this.syncDirectory(dirname(candidate));
		this.openAppendOnlyFiles += 1;
		return new AppendOnlyArtifactFile(this, path, file, () => {
			if (this.openAppendOnlyFiles === 0)
				throw new Error("Artifact store append-only file accounting underflow");
			this.openAppendOnlyFiles -= 1;
		});
	}

	listArtifacts(): readonly StoredArtifact[] {
		return [...this.artifacts.values()].sort((left, right) => left.path.localeCompare(right.path));
	}

	async read(path: string): Promise<Uint8Array> {
		return readFile(this.resolvePath(path));
	}

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

export class AppendOnlyArtifactFile {
	private readonly store: ArtifactStore;
	private readonly relativePath: string;
	private readonly release: () => void;
	private readonly file: AppendFileHandle;
	private closed = false;

	constructor(store: ArtifactStore, relativePath: string, file: AppendFileHandle, release: () => void) {
		this.store = store;
		this.relativePath = relativePath;
		this.release = release;
		this.file = file;
	}

	async append(content: string): Promise<void> {
		if (this.closed) throw new Error(`Append-only artifact is closed: ${this.relativePath}`);
		await this.file.write(content, null, "utf8");
		await this.file.sync();
	}

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
