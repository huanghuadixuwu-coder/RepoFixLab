import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import {
	taskEnvironmentLockId,
	taskEnvironmentLockInstancePrefix,
	taskEnvironmentLockSealHash,
	verifyDatasetLockForTaskEnvironment,
} from "../contracts/task-environment-lock.ts";
import {
	type DatasetLock,
	type PublicTaskManifest,
	PublicTaskManifestSchema,
	TaskEnvironmentLockSchema,
} from "../contracts/v1.ts";

const SHA256_PATTERN = "^[a-f0-9]{64}$";
const GIT_SHA1_PATTERN = "^[a-f0-9]{40}$";
const INSTANCE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$";

const PublicDatasetTaskSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		record_type: Type.Literal("dataset_task"),
		dataset_revision: Type.String({ pattern: GIT_SHA1_PATTERN }),
		instance_id: Type.String({ pattern: INSTANCE_ID_PATTERN }),
		repo: Type.String({ minLength: 1, maxLength: 300 }),
		problem_statement: Type.String({ minLength: 1, maxLength: 200_000 }),
		base_commit: Type.String({ pattern: GIT_SHA1_PATTERN }),
		language: Type.Literal("JavaScript/TypeScript"),
	},
	{ additionalProperties: false },
);

export type PublicDatasetTask = Static<typeof PublicDatasetTaskSchema>;
export type LoadedTaskEnvironmentLock = Static<typeof TaskEnvironmentLockSchema>;

export interface PublicTaskBinding {
	readonly manifest: PublicTaskManifest;
	readonly task: PublicDatasetTask;
	readonly recordBytes: Uint8Array;
	readonly recordSha256: string;
}

export interface TaskEnvironmentBinding {
	readonly lock: LoadedTaskEnvironmentLock;
	readonly lockId: string;
	readonly lockSha256: string;
	readonly candidateId: string;
	readonly candidateSha256: string;
	readonly lockBytes: Uint8Array;
	readonly lockFileSha256: string;
	readonly datasetLockBytes: Uint8Array;
	readonly datasetLockFileSha256: string;
}

export interface PublicTaskSource {
	load(instanceId: string, environment: TaskEnvironmentBinding): Promise<PublicTaskBinding>;
}

export interface TaskEnvironmentLockSource {
	load(instanceId: string): Promise<TaskEnvironmentBinding>;
}

export interface SharedDatasetLockLocation {
	readonly root_path: string;
	readonly relative_path: string;
}

export type PublicTaskSplit = PublicTaskManifest["split"];

const publicTaskValidator = Compile(PublicDatasetTaskSchema);
const publicTaskManifestValidator = Compile(PublicTaskManifestSchema);
const environmentLockValidator = Compile(TaskEnvironmentLockSchema);

function exactSha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function assertInstanceId(instanceId: string): void {
	if (!new RegExp(INSTANCE_ID_PATTERN).test(instanceId)) {
		throw new Error("Task instance ID is unsafe");
	}
}

async function readRegularFileBeneath(rootPath: string, relativePath: string): Promise<Uint8Array> {
	const root = resolve(rootPath);
	const rootStats = await lstat(root);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
		throw new Error("Task source root is not a regular directory");
	const candidate = resolve(root, relativePath);
	const relativePathFromRoot = relative(root, candidate);
	if (relativePathFromRoot.startsWith("..") || isAbsolute(relativePathFromRoot))
		throw new Error("Task source path escaped its root");
	const candidateStats = await lstat(candidate);
	if (!candidateStats.isFile() || candidateStats.isSymbolicLink())
		throw new Error("Task source is not a regular file");
	const realRoot = await realpath(root);
	const realCandidate = await realpath(candidate);
	const realRelativePath = relative(realRoot, realCandidate);
	if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath))
		throw new Error("Task source resolved outside its root");
	return readFile(realCandidate);
}

function parseJson(content: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
	} catch {
		throw new Error(`${label} is not valid UTF-8 JSON`);
	}
}

function datasetFile(
	datasetLock: DatasetLock,
	scope: "public" | "control" | "private",
	path: string,
): DatasetLock["files"][number] {
	const descriptor = datasetLock.files.find((file) => file.scope === scope && file.path === path);
	if (descriptor === undefined) throw new Error(`DatasetLock is missing ${scope} file binding: ${path}`);
	return descriptor;
}

function taskRecordDescriptor(datasetLock: DatasetLock, instanceId: string): DatasetLock["files"][number] {
	return datasetFile(datasetLock, "public", `tasks/${instanceId}.json`);
}

function assertTaskRecordMatchesDatasetLock(
	content: Uint8Array,
	instanceId: string,
	environment: TaskEnvironmentBinding,
): DatasetLock {
	const datasetLock = verifyDatasetLockForTaskEnvironment(
		parseJson(environment.datasetLockBytes, "Packaged DatasetLock"),
	);
	if (datasetLock.lock_id !== environment.lock.dataset_lock_id) {
		throw new Error("Packaged DatasetLock does not match the TaskEnvironmentLock binding");
	}
	const descriptor = taskRecordDescriptor(datasetLock, instanceId);
	if (content.byteLength !== descriptor.bytes || exactSha256(content) !== descriptor.sha256) {
		throw new Error("Public task record does not match the sealed DatasetLock byte binding");
	}
	return datasetLock;
}

async function loadTaskEnvironmentBindingFromBytes(
	instanceId: string,
	lockBytes: Uint8Array,
	datasetLockBytes: Uint8Array,
): Promise<TaskEnvironmentBinding> {
	const value = parseJson(lockBytes, "Task environment lock");
	if (!environmentLockValidator.Check(value) || value.instance_id !== instanceId) {
		throw new Error("Task environment lock does not satisfy the strict v1 schema");
	}
	const expectedSeal = taskEnvironmentLockSealHash(value);
	if (
		value.seal_sha256 !== expectedSeal ||
		value.lock_id !== taskEnvironmentLockId(value.instance_id, expectedSeal) ||
		!new RegExp(SHA256_PATTERN).test(value.candidate_sha256)
	) {
		throw new Error("Task environment lock semantic seal is invalid");
	}
	const datasetLock = verifyDatasetLockForTaskEnvironment(parseJson(datasetLockBytes, "Packaged DatasetLock"));
	if (datasetLock.lock_id !== value.dataset_lock_id) {
		throw new Error("Packaged DatasetLock does not match the TaskEnvironmentLock binding");
	}
	return {
		lock: value,
		lockId: value.lock_id,
		lockSha256: value.seal_sha256,
		candidateId: value.candidate_id,
		candidateSha256: value.candidate_sha256,
		lockBytes,
		lockFileSha256: exactSha256(lockBytes),
		datasetLockBytes,
		datasetLockFileSha256: exactSha256(datasetLockBytes),
	};
}

export class FilePublicTaskSource implements PublicTaskSource {
	private readonly rootPath: string;
	private readonly split: PublicTaskSplit;

	constructor(rootPath = process.env.REPOFIX_DATASET_PUBLIC_PATH ?? "/data/public", split: PublicTaskSplit = "dev") {
		this.rootPath = rootPath;
		this.split = split;
	}

	async load(instanceId: string, environment: TaskEnvironmentBinding): Promise<PublicTaskBinding> {
		assertInstanceId(instanceId);
		const content = await readRegularFileBeneath(this.rootPath, join("tasks", `${instanceId}.json`));
		const datasetLock = assertTaskRecordMatchesDatasetLock(content, instanceId, environment);
		const value = parseJson(content, "Public task manifest");
		if (!publicTaskValidator.Check(value) || value.instance_id !== instanceId) {
			throw new Error("Public task manifest does not satisfy the task schema");
		}
		if (
			value.dataset_revision !== datasetLock.dataset.revision ||
			environment.lock.dataset_lock_id !== datasetLock.lock_id
		) {
			throw new Error("Public task record does not match the sealed dataset/environment binding");
		}
		const identitySha256 = canonicalContractSha256({
			dataset_record_sha256: exactSha256(content),
			task_environment_lock_id: environment.lockId,
			split: this.split,
		});
		const unsigned = {
			schema_version: "v1" as const,
			manifest_id: `public-task-v1-${taskEnvironmentLockInstancePrefix(instanceId)}-${identitySha256.slice(0, 16)}`,
			dataset_lock_id: environment.lock.dataset_lock_id,
			task_environment_lock_id: environment.lockId,
			task: {
				instance_id: value.instance_id,
				repo: value.repo,
				problem_statement: value.problem_statement,
				base_commit: value.base_commit,
				language: value.language,
			},
			worker_image_id: environment.lock.worker_image.local_image_id,
			resource_profile: { ...environment.lock.resource_profile },
			split: this.split,
			created_at: environment.lock.created_at,
		};
		const manifest: PublicTaskManifest = { ...unsigned, manifest_sha256: canonicalContractSha256(unsigned) };
		if (!publicTaskManifestValidator.Check(manifest))
			throw new Error("Derived public task manifest violates the strict v1 schema");
		return { manifest, task: value, recordBytes: content, recordSha256: exactSha256(content) };
	}
}

export class FileTaskEnvironmentLockSource implements TaskEnvironmentLockSource {
	private readonly lockPath: string;
	private readonly datasetLockPath: string;

	constructor(
		lockPath = fileURLToPath(new URL("../../configs/runtime/axios-5892/task-environment-lock.json", import.meta.url)),
		datasetLockPath = fileURLToPath(new URL("../../configs/runtime/axios-5892/dataset-lock.json", import.meta.url)),
	) {
		this.lockPath = lockPath;
		this.datasetLockPath = datasetLockPath;
	}

	async load(instanceId: string): Promise<TaskEnvironmentBinding> {
		assertInstanceId(instanceId);
		const stats = await lstat(this.lockPath);
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Task environment lock is not a regular file");
		const lockBytes = await readFile(await realpath(this.lockPath));
		const datasetStats = await lstat(this.datasetLockPath);
		if (!datasetStats.isFile() || datasetStats.isSymbolicLink())
			throw new Error("Packaged DatasetLock is not a regular file");
		const datasetLockBytes = await readFile(await realpath(this.datasetLockPath));
		return loadTaskEnvironmentBindingFromBytes(instanceId, lockBytes, datasetLockBytes);
	}
}

/**
 * Loads per-task sealed runtime inputs from a single immutable directory.
 * Each task owns its task lock path; the DatasetLock may be duplicated so no
 * running task needs a mutable shared configuration file.
 */
export class DirectoryTaskEnvironmentLockSource implements TaskEnvironmentLockSource {
	private readonly rootPath: string;
	private readonly sharedDatasetLockLocation: SharedDatasetLockLocation | null;

	constructor(
		rootPath = process.env.REPOFIX_TASK_ENVIRONMENT_LOCK_ROOT ??
			fileURLToPath(new URL("../../configs/runtime", import.meta.url)),
		sharedDatasetLockLocation: SharedDatasetLockLocation | null = null,
	) {
		this.rootPath = rootPath;
		this.sharedDatasetLockLocation = sharedDatasetLockLocation;
	}

	async load(instanceId: string): Promise<TaskEnvironmentBinding> {
		assertInstanceId(instanceId);
		const taskDirectory = taskEnvironmentLockInstancePrefix(instanceId);
		const datasetLockRoot = this.sharedDatasetLockLocation?.root_path ?? this.rootPath;
		const datasetLockPath = this.sharedDatasetLockLocation?.relative_path ?? join(taskDirectory, "dataset-lock.json");
		const [lockBytes, datasetLockBytes] = await Promise.all([
			readRegularFileBeneath(this.rootPath, join(taskDirectory, "task-environment-lock.json")),
			readRegularFileBeneath(datasetLockRoot, datasetLockPath),
		]);
		return loadTaskEnvironmentBindingFromBytes(instanceId, lockBytes, datasetLockBytes);
	}
}
