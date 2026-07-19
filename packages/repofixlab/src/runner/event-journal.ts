import { createRunEvent, type RunEvent, verifyRunEventChain } from "../contracts/run-contracts.ts";
import type { AppendOnlyArtifactFile, StoredArtifact } from "../storage/artifact-store.ts";

export type RunEventInput = Omit<
	RunEvent,
	"schema_version" | "record_type" | "run_id" | "attempt_id" | "sequence" | "previous_record_sha256" | "event_sha256"
>;

export class RunEventJournal {
	private readonly runId: string;
	private readonly attemptId: string;
	private readonly file: AppendOnlyArtifactFile;
	private readonly events: RunEvent[] = [];

	constructor(runId: string, attemptId: string, file: AppendOnlyArtifactFile) {
		this.runId = runId;
		this.attemptId = attemptId;
		this.file = file;
	}

	async append(input: RunEventInput): Promise<RunEvent> {
		const event = createRunEvent({
			schema_version: "v1",
			record_type: "run_event",
			run_id: this.runId,
			attempt_id: this.attemptId,
			sequence: this.events.length,
			previous_record_sha256: this.events.at(-1)?.event_sha256 ?? null,
			...input,
		});
		await this.file.append(`${JSON.stringify(event)}\n`);
		this.events.push(event);
		return event;
	}

	get values(): readonly RunEvent[] {
		return this.events;
	}

	async close(): Promise<StoredArtifact> {
		verifyRunEventChain(this.events);
		return this.file.close({
			mediaType: "application/x-ndjson",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
	}
}
