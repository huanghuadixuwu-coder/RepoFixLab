import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = "/testbed";
const expectedBaseCommit = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b";
const sensitiveEnvironmentNames = [
	"ZHIPU_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"DOCKER_HOST",
];
const dockerSocketPaths = ["/var/run/docker.sock", "/run/docker.sock"];
const probeSha256 = createHash("sha256")
	.update(readFileSync(fileURLToPath(import.meta.url)))
	.digest("hex");

function requiredEnvironment(name, pattern) {
	const value = process.env[name];
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(`${name} is missing or malformed`);
	}
	return value;
}

function git(...arguments_) {
	return execFileSync(
		"git",
		["-c", `safe.directory=${workspace}`, "-C", workspace, ...arguments_],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

const nonce = requiredEnvironment("REPOFIX_ACTIVE_PROBE_NONCE", /^[a-f0-9]{32}$/);
const role = requiredEnvironment("REPOFIX_ROLE", /^(worker|evaluator)$/);
const boundBaseCommit = requiredEnvironment("REPOFIX_EXPECTED_BASE_COMMIT", /^[a-f0-9]{40}$/);
const boundProbeSha256 = requiredEnvironment("REPOFIX_EXPECTED_PROBE_SHA256", /^[a-f0-9]{64}$/);
if (boundBaseCommit !== expectedBaseCommit) {
	throw new Error("candidate base commit differs from the image-bound Axios base commit");
}
if (boundProbeSha256 !== probeSha256) {
	throw new Error("candidate probe SHA-256 differs from the running image probe");
}

const uid = process.getuid?.();
const gid = process.getgid?.();
if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
	throw new Error("numeric runtime UID/GID are unavailable");
}

mkdirSync(process.env.HOME ?? "/tmp/repofixlab-home", { recursive: true, mode: 0o700 });
const probePath = `${workspace}/.repofixlab-probe-${nonce}`;
const payload = Buffer.from(`repofixlab:${role}:${nonce}\n`, "utf8");
const descriptor = openSync(probePath, "wx", 0o600);
try {
	writeFileSync(descriptor, payload);
	fsyncSync(descriptor);
} finally {
	closeSync(descriptor);
}
const writablePathRoundtrip = readFileSync(probePath).equals(payload);
unlinkSync(probePath);
const directoryDescriptor = openSync(workspace, "r");
try {
	fsyncSync(directoryDescriptor);
} finally {
	closeSync(directoryDescriptor);
}

const headSha = git("rev-parse", "HEAD");
const worktreeStatus = git("status", "--porcelain");
const dockerSocketPathsPresent = dockerSocketPaths.filter((path) => existsSync(path));
const sensitiveEnvironmentNamesPresent = sensitiveEnvironmentNames.filter(
	(name) => Object.hasOwn(process.env, name),
);
const errors = [];
if (headSha !== expectedBaseCommit) {
	errors.push("observed HEAD differs from the image-bound Axios base commit");
}
if (worktreeStatus !== "") {
	errors.push("workspace is not clean after the writable-path roundtrip");
}
if (!writablePathRoundtrip) {
	errors.push("writable-path roundtrip content differs");
}
if (dockerSocketPathsPresent.length !== 0) {
	errors.push("Docker socket path is present");
}
if (sensitiveEnvironmentNamesPresent.length !== 0) {
	errors.push("sensitive environment name is present");
}

const observation = {
	schema_version: "v1",
	probe_type: "task_role_factory_active_probe",
	probe_sha256: probeSha256,
	nonce,
	observed_uid: uid,
	observed_gid: gid,
	observed_base_commit: headSha,
	writable_path_roundtrip: writablePathRoundtrip,
	docker_socket_paths_present: dockerSocketPathsPresent,
	sensitive_environment_names_present: sensitiveEnvironmentNamesPresent,
	errors,
};
process.stdout.write(`${JSON.stringify(observation)}\n`);

if (errors.length !== 0) {
	process.exitCode = 1;
}
