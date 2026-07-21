import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";
import { verifyDatasetLockForTaskEnvironment } from "../contracts/task-environment-lock.ts";
import { parseM3SamplingMetadataJsonl, verifyM3RepoStratifiedSplit } from "../m3/split.ts";
import { createM6DevCalibrationBatch, type M6DevCalibrationBatch } from "./calibration-cohort.ts";

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function parseJson(content: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
	} catch {
		throw new Error(`${label} is not valid UTF-8 JSON`);
	}
}

export function freezeM6DevCalibrationBatch(input: {
	readonly split_content: Uint8Array;
	readonly sampling_metadata_content: Uint8Array;
	readonly dataset_lock_content: Uint8Array;
}): M6DevCalibrationBatch {
	const split = verifyM3RepoStratifiedSplit(parseJson(input.split_content, "M3 split manifest"));
	const datasetLock = verifyDatasetLockForTaskEnvironment(parseJson(input.dataset_lock_content, "DatasetLock"));
	if (datasetLock.lock_id !== split.dataset_lock_id || datasetLock.seal.sha256 !== split.dataset_lock_seal_sha256) {
		throw new Error("M3 split does not bind the supplied sealed DatasetLock");
	}
	if (sha256(input.sampling_metadata_content) !== split.sampling_metadata_sha256) {
		throw new Error("M3 sampling metadata bytes do not match the sealed split binding");
	}
	const samplingMetadata = new TextDecoder("utf-8", { fatal: true }).decode(input.sampling_metadata_content);
	parseM3SamplingMetadataJsonl(samplingMetadata, datasetLock.dataset.revision);
	return createM6DevCalibrationBatch(split);
}

async function writeImmutable(path: string, content: string): Promise<void> {
	const outputPath = resolve(path);
	await mkdir(dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporaryPath, outputPath);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		const existing = await readFile(outputPath, "utf8");
		if (existing !== content) throw new Error(`Frozen M6 calibration artifact conflict: ${outputPath}`);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

export async function freezeM6DevCalibrationBatchToFile(input: {
	readonly split_path: string;
	readonly sampling_metadata_path: string;
	readonly dataset_lock_path: string;
	readonly output_path: string;
}): Promise<M6DevCalibrationBatch> {
	const [splitContent, samplingMetadataContent, datasetLockContent] = await Promise.all([
		readFile(input.split_path),
		readFile(input.sampling_metadata_path),
		readFile(input.dataset_lock_path),
	]);
	const batch = freezeM6DevCalibrationBatch({
		split_content: splitContent,
		sampling_metadata_content: samplingMetadataContent,
		dataset_lock_content: datasetLockContent,
	});
	await writeImmutable(input.output_path, stableStringify(batch));
	return batch;
}
