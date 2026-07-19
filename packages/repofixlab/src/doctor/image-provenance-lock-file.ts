import {
	type BootstrapImageProvenanceLock,
	type BootstrapService,
	type BootstrapServiceImageLock,
	type BootstrapServiceNetworkLock,
	createBootstrapImageProvenanceLock,
	type UnsignedBootstrapImageProvenanceLock,
	verifyBootstrapImageProvenanceLock,
} from "./image-provenance.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, context: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be a JSON object`);
	}
	return value as JsonRecord;
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
		throw new Error(`${context} fields must be exactly: ${allowed.join(", ")}`);
	}
}

function stringField(value: JsonRecord, key: string, context: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`${context}.${key} must be a string`);
	return field;
}

function parseNetwork(value: unknown, context: string): BootstrapServiceNetworkLock {
	const network = asRecord(value, context);
	assertExactKeys(network, ["internal", "logicalName"], context);
	if (typeof network.internal !== "boolean") throw new Error(`${context}.internal must be a boolean`);
	return {
		internal: network.internal,
		logicalName: stringField(network, "logicalName", context),
	};
}

function parseService(value: unknown, service: BootstrapService): BootstrapServiceImageLock {
	const context = `services.${service}`;
	const record = asRecord(value, context);
	assertExactKeys(
		record,
		[
			"baseRepositoryDigest",
			"buildInputsSha256",
			"composeConfigSha256",
			"dockerfileSha256",
			"expectedBaseImageId",
			"expectedImageId",
			"expectedNetworks",
			"platform",
		],
		context,
	);
	const networks = record.expectedNetworks;
	if (!Array.isArray(networks)) throw new Error(`${context}.expectedNetworks must be an array`);
	return {
		baseRepositoryDigest: stringField(record, "baseRepositoryDigest", context),
		buildInputsSha256: stringField(record, "buildInputsSha256", context),
		composeConfigSha256: stringField(record, "composeConfigSha256", context),
		dockerfileSha256: stringField(record, "dockerfileSha256", context),
		expectedBaseImageId: stringField(record, "expectedBaseImageId", context),
		expectedImageId: stringField(record, "expectedImageId", context),
		expectedNetworks: networks.map((network, index) =>
			parseNetwork(network, `${context}.expectedNetworks[${index}]`),
		),
		platform: stringField(record, "platform", context) as "linux/amd64",
	};
}

/** Parse an unsigned host observation without allowing unvalidated fields into the external lock hash. */
export function parseUnsignedBootstrapImageProvenanceLock(text: string): UnsignedBootstrapImageProvenanceLock {
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		throw new Error("Bootstrap image provenance candidate is not valid JSON", { cause: error });
	}
	const record = asRecord(decoded, "bootstrap image provenance candidate");
	assertExactKeys(
		record,
		["composeProject", "createdAt", "lockId", "lockType", "schemaVersion", "services"],
		"bootstrap image provenance candidate",
	);
	const services = asRecord(record.services, "services");
	assertExactKeys(services, ["controller", "orchestrator"], "services");
	return {
		composeProject: stringField(record, "composeProject", "bootstrap image provenance candidate"),
		createdAt: stringField(record, "createdAt", "bootstrap image provenance candidate"),
		lockId: stringField(record, "lockId", "bootstrap image provenance candidate"),
		lockType: stringField(record, "lockType", "bootstrap image provenance candidate") as "bootstrap_image_provenance",
		schemaVersion: stringField(
			record,
			"schemaVersion",
			"bootstrap image provenance candidate",
		) as "repofixlab.bootstrap-image-provenance-lock.v1",
		services: {
			controller: parseService(services.controller, "controller"),
			orchestrator: parseService(services.orchestrator, "orchestrator"),
		},
	};
}

export function createBootstrapImageProvenanceLockFile(text: string): string {
	const lock = createBootstrapImageProvenanceLock(parseUnsignedBootstrapImageProvenanceLock(text));
	return `${JSON.stringify(lock, undefined, 2)}\n`;
}

export function parseBootstrapImageProvenanceLockFile(text: string): BootstrapImageProvenanceLock {
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		throw new Error("Bootstrap image provenance lock is not valid JSON", { cause: error });
	}
	const record = asRecord(decoded, "bootstrap image provenance lock");
	assertExactKeys(
		record,
		["composeProject", "createdAt", "lockId", "lockSha256", "lockType", "schemaVersion", "services"],
		"bootstrap image provenance lock",
	);
	const lockSha256 = stringField(record, "lockSha256", "bootstrap image provenance lock");
	const unsigned = parseUnsignedBootstrapImageProvenanceLock(
		JSON.stringify({
			composeProject: record.composeProject,
			createdAt: record.createdAt,
			lockId: record.lockId,
			lockType: record.lockType,
			schemaVersion: record.schemaVersion,
			services: record.services,
		}),
	);
	return verifyBootstrapImageProvenanceLock({ ...unsigned, lockSha256 });
}
