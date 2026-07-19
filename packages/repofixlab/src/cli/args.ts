import { parseArgs as parseNodeArgs } from "node:util";

export const DOCTOR_PROFILES = ["bootstrap", "smoke", "formal"] as const;

export type DoctorProfile = (typeof DOCTOR_PROFILES)[number];

export type CliCommand =
	| { kind: "doctor"; profile: "smoke"; input: string; output: string }
	| { kind: "doctor"; profile: Exclude<DoctorProfile, "smoke">; output?: string }
	| { kind: "candidate-create"; input: string; output: string }
	| { kind: "environment-lock-create"; input: string; output: string }
	| {
			kind: "factory-probe";
			candidate: string;
			operationId: string;
			output: string;
	  }
	| { kind: "provenance-lock"; input: string; output: string }
	| { kind: "help"; topic?: "doctor" }
	| { kind: "version" };

export type CliParseErrorCode =
	| "unknown_option"
	| "missing_option_value"
	| "missing_command"
	| "unknown_command"
	| "invalid_profile"
	| "invalid_input"
	| "invalid_candidate"
	| "invalid_operation_id"
	| "invalid_output"
	| "unexpected_argument"
	| "conflicting_action";

export type ParseCliArgsResult =
	| { ok: true; command: CliCommand }
	| { ok: false; error: { code: CliParseErrorCode; message: string } };

function failure(code: CliParseErrorCode, message: string): ParseCliArgsResult {
	return { ok: false, error: { code, message } };
}

function parseNodeError(error: unknown): ParseCliArgsResult {
	const errorCode =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code)
			: undefined;
	const message = error instanceof Error ? error.message : String(error);

	if (errorCode === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
		return failure("unknown_option", message);
	}
	if (errorCode === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
		return failure("missing_option_value", message);
	}
	return failure("unexpected_argument", message);
}

function isDoctorProfile(value: string): value is DoctorProfile {
	return DOCTOR_PROFILES.some((profile) => profile === value);
}

/** Parse CLI argv without reading process state or terminating the process. */
export function parseCliArgs(args: readonly string[]): ParseCliArgsResult {
	let parsed: ReturnType<typeof parseNodeArgs>;
	try {
		parsed = parseNodeArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "v" },
				profile: { type: "string" },
				input: { type: "string" },
				candidate: { type: "string" },
				"operation-id": { type: "string" },
				output: { type: "string" },
			},
		});
	} catch (error) {
		return parseNodeError(error);
	}

	const { values, positionals } = parsed;
	const command = positionals[0];
	const extraPositionals = positionals.slice(1);
	const hasActionOptions =
		values.profile !== undefined ||
		values.input !== undefined ||
		values.candidate !== undefined ||
		values["operation-id"] !== undefined ||
		values.output !== undefined;

	if (values.help === true || command === "help") {
		if (values.version === true || hasActionOptions) {
			return failure("conflicting_action", "Help cannot be combined with version or command options");
		}

		const helpArguments = command === "help" ? extraPositionals : positionals;
		if (helpArguments.length === 0) {
			return { ok: true, command: { kind: "help" } };
		}
		if (helpArguments.length === 1 && helpArguments[0] === "doctor") {
			return { ok: true, command: { kind: "help", topic: "doctor" } };
		}
		return failure("unexpected_argument", `Unexpected help argument: ${helpArguments.join(" ")}`);
	}

	if (values.version === true || command === "version") {
		if (hasActionOptions || positionals.length > 1 || (command !== undefined && command !== "version")) {
			return failure("conflicting_action", "Version cannot be combined with a command or command options");
		}
		return { ok: true, command: { kind: "version" } };
	}

	if (command === undefined) {
		return failure("missing_command", "A command is required");
	}
	if (command === "candidate-create" || command === "environment-lock-create" || command === "provenance-lock") {
		if (extraPositionals.length > 0) {
			return failure("unexpected_argument", `Unexpected ${command} argument: ${extraPositionals.join(" ")}`);
		}
		if (values.profile !== undefined || values.candidate !== undefined || values["operation-id"] !== undefined) {
			return failure("conflicting_action", `${command} cannot be combined with doctor options`);
		}
		const input = values.input;
		if (typeof input !== "string" || input.trim().length === 0) {
			return failure("invalid_input", `${command} requires a non-empty --input path`);
		}
		const output = values.output;
		if (typeof output !== "string" || output.trim().length === 0) {
			return failure("invalid_output", `${command} requires a non-empty --output path`);
		}
		return { ok: true, command: { kind: command, input, output } };
	}
	if (command === "factory-probe") {
		if (extraPositionals.length > 0) {
			return failure("unexpected_argument", `Unexpected factory-probe argument: ${extraPositionals.join(" ")}`);
		}
		if (values.profile !== undefined || values.input !== undefined) {
			return failure("conflicting_action", "factory-probe cannot be combined with doctor or file-transform options");
		}
		const candidate = values.candidate;
		if (typeof candidate !== "string" || candidate.trim().length === 0) {
			return failure("invalid_candidate", "factory-probe requires a non-empty --candidate path");
		}
		const operationId = values["operation-id"];
		if (typeof operationId !== "string" || operationId.trim().length === 0) {
			return failure("invalid_operation_id", "factory-probe requires a non-empty --operation-id");
		}
		const output = values.output;
		if (typeof output !== "string" || output.trim().length === 0) {
			return failure("invalid_output", "factory-probe requires a non-empty --output path");
		}
		return {
			ok: true,
			command: { kind: "factory-probe", candidate, operationId, output },
		};
	}
	if (command !== "doctor") {
		return failure("unknown_command", `Unknown command: ${command}`);
	}
	if (values.candidate !== undefined || values["operation-id"] !== undefined) {
		return failure("conflicting_action", "doctor cannot be combined with non-doctor options");
	}
	if (extraPositionals.length > 0) {
		return failure("unexpected_argument", `Unexpected doctor argument: ${extraPositionals.join(" ")}`);
	}

	const profile = values.profile;
	if (typeof profile !== "string" || !isDoctorProfile(profile)) {
		return failure(
			"invalid_profile",
			typeof profile === "string"
				? `Invalid doctor profile: ${profile}`
				: "Doctor requires --profile bootstrap, smoke, or formal",
		);
	}

	const output = values.output;
	if (output !== undefined && (typeof output !== "string" || output.trim().length === 0)) {
		return failure("invalid_output", "--output must be a non-empty path");
	}
	if (profile === "smoke") {
		const input = values.input;
		if (typeof input !== "string" || input.trim().length === 0) {
			return failure("invalid_input", "Smoke doctor requires a non-empty --input evidence manifest path");
		}
		if (typeof output !== "string") {
			return failure("invalid_output", "Smoke doctor requires a non-empty --output report path");
		}
		return {
			ok: true,
			command: { kind: "doctor", profile, input, output },
		};
	}
	if (values.input !== undefined) {
		return failure("conflicting_action", `${profile} doctor does not accept --input`);
	}

	return {
		ok: true,
		command: {
			kind: "doctor",
			profile,
			...(typeof output === "string" ? { output } : {}),
		},
	};
}
