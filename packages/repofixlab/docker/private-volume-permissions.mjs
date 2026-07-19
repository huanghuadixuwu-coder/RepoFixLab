import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";

const PRIVATE_ROOT = "/data/private";
const DATASET_LOCK_PATH =
	"/workspace/packages/repofixlab/configs/runtime/axios-5892/dataset-lock.json";
const PRODUCER_ID = 65_532;
const EVALUATOR_ID = 0;
const PUBLISHED_FILE_MODE = 0o444;
const PUBLISHED_DIRECTORY_MODE = 0o755;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;

function fail(message) {
	throw new Error(message);
}

function decodeMountPath(value) {
	return value
		.replaceAll("\\040", " ")
		.replaceAll("\\011", "\t")
		.replaceAll("\\012", "\n")
		.replaceAll("\\134", "\\");
}

async function assertMountMode(expectedMode) {
	const lines = (await readFile("/proc/self/mountinfo", "utf8")).split("\n");
	const matches = lines.filter((line) => {
		const fields = line.split(" ");
		return fields.length >= 6 && decodeMountPath(fields[4]) === PRIVATE_ROOT;
	});
	if (matches.length !== 1) {
		fail("private dataset root must be one dedicated mount point");
	}
	const options = new Set(matches[0].split(" ")[5].split(","));
	if (!options.has(expectedMode)) {
		fail(`private dataset mount must be ${expectedMode}`);
	}
}

function requireObject(value, description) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${description} must be an object`);
	}
	return value;
}

function exactKeys(value, expected, description) {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
		fail(`${description} keys differ from the frozen contract`);
	}
}

function safeRelativePath(value) {
	if (
		typeof value !== "string" ||
		!SAFE_RELATIVE_PATH.test(value) ||
		posix.isAbsolute(value) ||
		value.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		fail("DatasetLock contains an unsafe private path");
	}
	return value;
}

async function loadPrivateContract() {
	const lock = requireObject(
		JSON.parse(await readFile(DATASET_LOCK_PATH, "utf8")),
		"packaged DatasetLock",
	);
	if (lock.schema_version !== "v1" || lock.lock_type !== "dataset") {
		fail("packaged DatasetLock identity differs from v1");
	}
	const volumes = requireObject(lock.volumes, "DatasetLock volumes");
	if (typeof lock.generation_id !== "string" || volumes.private !== `dataset-private-${lock.generation_id}`) {
		fail("packaged DatasetLock does not bind its private generation volume");
	}
	if (!Array.isArray(lock.files)) {
		fail("packaged DatasetLock files must be an array");
	}
	const descriptors = new Map();
	for (const candidate of lock.files) {
		const descriptor = requireObject(candidate, "DatasetLock file descriptor");
		exactKeys(descriptor, ["bytes", "path", "scope", "sha256"], "DatasetLock file descriptor");
		if (descriptor.scope !== "private") {
			continue;
		}
		const relativePath = safeRelativePath(descriptor.path);
		if (
			!Number.isSafeInteger(descriptor.bytes) ||
			descriptor.bytes < 0 ||
			typeof descriptor.sha256 !== "string" ||
			!SHA256.test(descriptor.sha256)
		) {
			fail(`invalid private descriptor: ${relativePath}`);
		}
		if (descriptors.has(relativePath)) {
			fail(`duplicate private descriptor: ${relativePath}`);
		}
		descriptors.set(relativePath, { bytes: descriptor.bytes, sha256: descriptor.sha256 });
	}
	if (descriptors.size !== 45 || !descriptors.has("tasks/axios__axios-5892.json")) {
		fail("packaged DatasetLock must contain the complete frozen private task set");
	}
	for (const [name, value] of [
		["READY", requireObject(lock.ready, "DatasetLock READY binding").sha256],
		["SEAL", requireObject(lock.seal, "DatasetLock SEAL binding").sha256],
	]) {
		if (typeof value !== "string" || !SHA256.test(value)) {
			fail(`DatasetLock ${name} SHA-256 is invalid`);
		}
		descriptors.set(name, { bytes: null, sha256: value });
	}
	if (typeof lock.aggregate_sha256 !== "string" || !SHA256.test(lock.aggregate_sha256)) {
		fail("DatasetLock aggregate SHA-256 is invalid");
	}
	return { aggregateSha256: lock.aggregate_sha256, descriptors };
}

async function inventoryTree(relativeDirectory, files, directories) {
	const absoluteDirectory = relativeDirectory === "" ? PRIVATE_ROOT : `${PRIVATE_ROOT}/${relativeDirectory}`;
	const entries = await readdir(absoluteDirectory, { withFileTypes: true });
	for (const entry of entries) {
		const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
		const absolutePath = `${PRIVATE_ROOT}/${relativePath}`;
		const metadata = await lstat(absolutePath);
		if (metadata.isSymbolicLink()) {
			fail(`private generation contains a symbolic link: ${relativePath}`);
		}
		if (metadata.isDirectory()) {
			directories.set(relativePath, metadata);
			await inventoryTree(relativePath, files, directories);
		} else if (metadata.isFile()) {
			files.set(relativePath, metadata);
		} else {
			fail(`private generation contains a non-regular entry: ${relativePath}`);
		}
	}
}

function expectedDirectories(descriptorPaths) {
	const directories = new Set([""]);
	for (const relativePath of descriptorPaths) {
		let directory = posix.dirname(relativePath);
		while (directory !== ".") {
			directories.add(directory);
			directory = posix.dirname(directory);
		}
	}
	return directories;
}

function assertExactSet(actual, expected, description) {
	const actualValues = [...actual].sort();
	const expectedValues = [...expected].sort();
	if (
		actualValues.length !== expectedValues.length ||
		actualValues.some((value, index) => value !== expectedValues[index])
	) {
		fail(`${description} differs from the packaged DatasetLock`);
	}
}

async function sha256File(path) {
	const content = await readFile(path);
	return { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

async function auditPrivateVolume(contract, requirePublishedModes) {
	const rootMetadata = await lstat(PRIVATE_ROOT);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		fail("private dataset root must be a real directory");
	}
	const files = new Map();
	const directories = new Map([["", rootMetadata]]);
	await inventoryTree("", files, directories);
	assertExactSet(files.keys(), contract.descriptors.keys(), "private file layout");
	assertExactSet(
		directories.keys(),
		expectedDirectories(contract.descriptors.keys()),
		"private directory layout",
	);

	const observedFiles = [];
	for (const [relativePath, expected] of [...contract.descriptors].sort(([left], [right]) => left.localeCompare(right))) {
		const metadata = files.get(relativePath);
		if (metadata.uid !== PRODUCER_ID || metadata.gid !== PRODUCER_ID) {
			fail(`private file owner differs from 65532:65532: ${relativePath}`);
		}
		const observed = await sha256File(`${PRIVATE_ROOT}/${relativePath}`);
		if (
			(expected.bytes !== null && observed.bytes !== expected.bytes) ||
			observed.sha256 !== expected.sha256
		) {
			fail(`private file bytes differ from the packaged DatasetLock: ${relativePath}`);
		}
		const mode = metadata.mode & 0o777;
		if (requirePublishedModes && mode !== PUBLISHED_FILE_MODE) {
			fail(`private file mode is not 0444: ${relativePath}`);
		}
		observedFiles.push({ path: relativePath, bytes: observed.bytes, sha256: observed.sha256, mode });
	}
	for (const [relativePath, metadata] of directories) {
		if (metadata.uid !== PRODUCER_ID || metadata.gid !== PRODUCER_ID) {
			fail(`private directory owner differs from 65532:65532: ${relativePath || "."}`);
		}
		if (requirePublishedModes && (metadata.mode & 0o777) !== PUBLISHED_DIRECTORY_MODE) {
			fail(`private directory mode is not 0755: ${relativePath || "."}`);
		}
	}
	return observedFiles;
}

async function normalize(contract) {
	if (process.getuid?.() !== PRODUCER_ID || process.getgid?.() !== PRODUCER_ID) {
		fail("normalize must run as 65532:65532");
	}
	await assertMountMode("rw");
	const before = await auditPrivateVolume(contract, false);
	for (const relativePath of contract.descriptors.keys()) {
		await chmod(`${PRIVATE_ROOT}/${relativePath}`, PUBLISHED_FILE_MODE);
	}
	const directories = [...expectedDirectories(contract.descriptors.keys())].sort(
		(left, right) => right.split("/").length - left.split("/").length,
	);
	for (const relativePath of directories) {
		await chmod(relativePath === "" ? PRIVATE_ROOT : `${PRIVATE_ROOT}/${relativePath}`, PUBLISHED_DIRECTORY_MODE);
	}
	const after = await auditPrivateVolume(contract, true);
	if (JSON.stringify(before.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))) !== JSON.stringify(after.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))) {
		fail("private dataset bytes changed during permission normalization");
	}
	return { action: "normalize", files: after.length };
}

async function audit(contract) {
	if (process.getuid?.() !== EVALUATOR_ID || process.getgid?.() !== EVALUATOR_ID) {
		fail("audit must run as 0:0");
	}
	await assertMountMode("ro");
	const files = await auditPrivateVolume(contract, true);
	return { action: "audit", files: files.length };
}

async function main() {
	if (process.argv.length !== 3 || !["audit", "normalize"].includes(process.argv[2])) {
		fail("usage: private-volume-permissions.mjs <audit|normalize>");
	}
	const contract = await loadPrivateContract();
	const result = process.argv[2] === "normalize" ? await normalize(contract) : await audit(contract);
	process.stdout.write(`${JSON.stringify({ schema_version: "v1", status: "pass", aggregate_sha256: contract.aggregateSha256, ...result })}\n`);
}

main().catch((error) => {
	process.stderr.write(`private volume permission gate failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
	process.exitCode = 1;
});
