import { type Static, type TSchema, Type } from "typebox";

export const CONTRACT_VERSION = "v1" as const;
export const DATASET_PREPARER_SELF_CHECK_CONSTANTS = {
	datasetName: "SWE-bench/SWE-bench_Multilingual",
	datasetRevision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
	sourceSha256: "28b7f874e48496399077d276f9f2b163a077ddf0a70dc507c148d58da826baa9",
	sourceBytes: 1_165_968,
	expectedSourceRecordCount: 300,
	expectedRecordCount: 43,
	requiredInstanceId: "axios__axios-5892",
	pythonVersion: "3.11.14",
	pyarrowVersion: "25.0.0",
	uid: 65_532,
	gid: 65_532,
} as const;
export const TASK_ROLE_FACTORY_PROBE_PROFILE = "axios-worker-evaluator-smoke-v1" as const;
export const AXIOS_SMOKE_INSTANCE_ID = "axios__axios-5892" as const;
export const AXIOS_SMOKE_BASE_COMMIT = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b" as const;
export const SWE_BENCH_HARNESS_VERSION = "v4.1.0" as const;
export const SWE_BENCH_HARNESS_REVISION = "726c5461e2ef52d83cf1ea2107870a8bb3328d57" as const;
export const AXIOS_SMOKE_TEST_COMMAND = [
	"npx",
	"mocha",
	"test/unit/adapters/http.js",
	"-R",
	"tap",
	"-g",
	"compression",
] as const;
export const AXIOS_SMOKE_TAP_PATTERN = "^(ok|not ok) (\\d+) (.+)$" as const;
export const AXIOS_HARNESS_ADAPTER_SHA256 = "a8aaaffee376dbbc91e48682d49b334fa617eb1dd38156637cda5809f1d24857" as const;

const SHA256_PATTERN = "^[a-f0-9]{64}$";
export const IMAGE_ID_PATTERN = "^sha256:[a-f0-9]{64}$";
const REPOSITORY_DIGEST_PATTERN = "^[^\\s@]+@sha256:[a-f0-9]{64}$";
const VOLUME_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const RELATIVE_DATA_PATH_PATTERN = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$";
const DECIMAL_BYTES_PATTERN = "^(0|[1-9][0-9]*)$";
const DOCKER_OBJECT_ID_PATTERN = "^[a-f0-9]{64}$";
const CONTAINER_HOSTNAME_PATTERN = "^[a-f0-9]{12,64}$";
const COMPOSE_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,62}$";
const OPERATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$";
const ABSOLUTE_CONTAINER_PATH_PATTERN = "^/(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$";

const Sha256Schema = Type.String({ pattern: SHA256_PATTERN });
const ImageIdSchema = Type.String({ pattern: IMAGE_ID_PATTERN });
const RepositoryDigestSchema = Type.String({ pattern: REPOSITORY_DIGEST_PATTERN });
const VolumeNameSchema = Type.String({ pattern: VOLUME_NAME_PATTERN });
const RelativeDataPathSchema = Type.String({ pattern: RELATIVE_DATA_PATH_PATTERN });
const TimestampSchema = Type.String({ minLength: 1, maxLength: 64 });
const DecimalBytesSchema = Type.String({ pattern: DECIMAL_BYTES_PATTERN });
const DockerObjectIdSchema = Type.String({ pattern: DOCKER_OBJECT_ID_PATTERN });
const ContractIdSchema = Type.String({ minLength: 1, maxLength: 160 });
const InstanceIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const OperationIdSchema = Type.String({ pattern: OPERATION_ID_PATTERN });
const AbsoluteContainerPathSchema = Type.String({ pattern: ABSOLUTE_CONTAINER_PATH_PATTERN });

const DatasetIdentitySchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 200 }),
		revision: Type.String({ minLength: 7, maxLength: 160 }),
	},
	{ additionalProperties: false },
);

const DatasetVolumeSetSchema = Type.Object(
	{
		public: VolumeNameSchema,
		control: VolumeNameSchema,
		private: VolumeNameSchema,
	},
	{ additionalProperties: false },
);

const DatasetFileSchema = Type.Object(
	{
		scope: Type.Union([Type.Literal("public"), Type.Literal("control"), Type.Literal("private")]),
		path: RelativeDataPathSchema,
		bytes: Type.Integer({ minimum: 0 }),
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const SealMarkerSchema = Type.Object(
	{
		sha256: Sha256Schema,
		written_at: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const DatasetLockSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		lock_type: Type.Literal("dataset"),
		lock_id: ContractIdSchema,
		dataset: DatasetIdentitySchema,
		generation_id: Type.String({ minLength: 1, maxLength: 128 }),
		volumes: DatasetVolumeSetSchema,
		record_count: Type.Integer({ minimum: 1 }),
		files: Type.Array(DatasetFileSchema, { minItems: 1 }),
		aggregate_sha256: Sha256Schema,
		ready: SealMarkerSchema,
		seal: SealMarkerSchema,
		created_by_image_id: ImageIdSchema,
		created_at: TimestampSchema,
	},
	{
		$id: "urn:repofixlab:schema:v1:dataset-lock",
		additionalProperties: false,
	},
);

const DatasetPreparerDirectoryChecksSchema = Type.Object(
	{
		public: Type.Boolean(),
		control: Type.Boolean(),
		private: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const DatasetPreparerSelfCheckDatasetSchema = Type.Object(
	{
		name: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetName),
		revision: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision),
		source_sha256: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.sourceSha256),
		source_bytes: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.sourceBytes),
		expected_source_record_count: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedSourceRecordCount),
		expected_record_count: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedRecordCount),
		required_instance_id: Type.Literal(DATASET_PREPARER_SELF_CHECK_CONSTANTS.requiredInstanceId),
	},
	{ additionalProperties: false },
);

const DatasetPreparerSelfCheckRuntimeSchema = Type.Object(
	{
		python_version: Type.String({ minLength: 1, maxLength: 64 }),
		pyarrow_version: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
		uid: Type.Integer(),
		gid: Type.Integer(),
	},
	{ additionalProperties: false },
);

const DatasetPreparerSelfCheckChecksSchema = Type.Object(
	{
		image_id_bound: Type.Boolean(),
		runtime_user: Type.Boolean(),
		pyarrow_version: Type.Boolean(),
		data_directories_exist: DatasetPreparerDirectoryChecksSchema,
		docker_socket_absent: Type.Boolean(),
		sensitive_environment_absent: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const DatasetPreparerSelfCheckObservationsSchema = Type.Object(
	{
		docker_socket_paths_present: Type.Array(
			Type.Union([Type.Literal("/var/run/docker.sock"), Type.Literal("/run/docker.sock")]),
			{ uniqueItems: true },
		),
		sensitive_environment_names_present: Type.Array(
			Type.Union([
				Type.Literal("ZHIPU_API_KEY"),
				Type.Literal("OPENAI_API_KEY"),
				Type.Literal("ANTHROPIC_API_KEY"),
				Type.Literal("DOCKER_HOST"),
			]),
			{ uniqueItems: true },
		),
	},
	{ additionalProperties: false },
);

export const DatasetPreparerSelfCheckReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("dataset_preparer_self_check"),
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		image_id: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
		dataset: DatasetPreparerSelfCheckDatasetSchema,
		runtime: DatasetPreparerSelfCheckRuntimeSchema,
		checks: DatasetPreparerSelfCheckChecksSchema,
		observations: DatasetPreparerSelfCheckObservationsSchema,
		errors: Type.Array(Type.String({ minLength: 1 })),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:dataset-preparer-self-check-report",
		additionalProperties: false,
	},
);

const LockReferenceSchema = Type.Object(
	{
		lock_id: ContractIdSchema,
		lock_sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const CandidateImageSchema = Type.Object(
	{
		local_image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
		provenance_sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const CandidateSecurityProfileSchema = Type.Object(
	{
		profile_id: ContractIdSchema,
		profile_sha256: Sha256Schema,
		network_mode: Type.Literal("none"),
		read_only_root_filesystem: Type.Literal(true),
		cap_drop: Type.Array(Type.Literal("ALL"), { minItems: 1, maxItems: 1, uniqueItems: true }),
		cap_add: Type.Array(Type.String(), { maxItems: 0 }),
		no_new_privileges: Type.Literal(true),
		privileged: Type.Literal(false),
		devices: Type.Array(Type.String(), { maxItems: 0 }),
		host_bind_mounts_allowed: Type.Literal(false),
		docker_socket_allowed: Type.Literal(false),
		published_ports_allowed: Type.Literal(false),
		sensitive_environment_allowed: Type.Literal(false),
		tty: Type.Literal(false),
		stdin_open: Type.Literal(false),
		auto_remove: Type.Literal(false),
	},
	{ additionalProperties: false },
);

const CandidateResourceProfileSchema = Type.Object(
	{
		profile_id: ContractIdSchema,
		profile_sha256: Sha256Schema,
		nano_cpus: Type.Integer({ minimum: 1 }),
		memory_bytes: Type.Integer({ minimum: 1 }),
		memory_swap_bytes: Type.Integer({ minimum: 1 }),
		pids_limit: Type.Integer({ minimum: 1 }),
		timeout_seconds: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const CandidateWritableMountSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("volume"), Type.Literal("tmpfs")]),
		destination: AbsoluteContainerPathSchema,
		read_write: Type.Literal(true),
	},
	{ additionalProperties: false },
);

const CandidateFilesystemProfileSchema = Type.Object(
	{
		profile_id: ContractIdSchema,
		profile_sha256: Sha256Schema,
		writable_mounts: Type.Array(CandidateWritableMountSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const WorkerRuntimeUserSchema = Type.Object(
	{
		uid: Type.Integer({ minimum: 1 }),
		gid: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const EvaluatorRuntimeUserSchema = Type.Object(
	{
		uid: Type.Integer({ minimum: 0 }),
		gid: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const WorkerCandidateRoleSchema = Type.Object(
	{
		role: Type.Literal("worker"),
		image: CandidateImageSchema,
		runtime_user: WorkerRuntimeUserSchema,
		security_profile: CandidateSecurityProfileSchema,
		resource_profile: CandidateResourceProfileSchema,
		filesystem_profile: CandidateFilesystemProfileSchema,
	},
	{ additionalProperties: false },
);

const EvaluatorCandidateRoleSchema = Type.Object(
	{
		role: Type.Literal("evaluator"),
		image: CandidateImageSchema,
		runtime_user: EvaluatorRuntimeUserSchema,
		security_profile: CandidateSecurityProfileSchema,
		resource_profile: CandidateResourceProfileSchema,
		filesystem_profile: CandidateFilesystemProfileSchema,
	},
	{ additionalProperties: false },
);

const CandidateBuildImageSchema = Type.Object(
	{
		local_image_id: ImageIdSchema,
		provenance_sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const CandidateBuildResourceProfileSchema = Type.Object(
	{
		nano_cpus: Type.Integer({ minimum: 1 }),
		memory_bytes: Type.Integer({ minimum: 1 }),
		memory_swap_bytes: Type.Integer({ minimum: 1 }),
		pids_limit: Type.Integer({ minimum: 1 }),
		timeout_seconds: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const CandidateBuildFilesystemProfileSchema = Type.Object(
	{
		writable_mounts: Type.Array(CandidateWritableMountSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const WorkerCandidateBuildRoleSchema = Type.Object(
	{
		image: CandidateBuildImageSchema,
		runtime_user: WorkerRuntimeUserSchema,
		resource_profile: CandidateBuildResourceProfileSchema,
		filesystem_profile: CandidateBuildFilesystemProfileSchema,
	},
	{ additionalProperties: false },
);

const EvaluatorCandidateBuildRoleSchema = Type.Object(
	{
		image: CandidateBuildImageSchema,
		runtime_user: EvaluatorRuntimeUserSchema,
		resource_profile: CandidateBuildResourceProfileSchema,
		filesystem_profile: CandidateBuildFilesystemProfileSchema,
	},
	{ additionalProperties: false },
);

export const TaskEnvironmentCandidateBuildInputSchema = Type.Object(
	{
		dataset_lock: LockReferenceSchema,
		official_image_source_lock: LockReferenceSchema,
		roles: Type.Object(
			{
				worker: WorkerCandidateBuildRoleSchema,
				evaluator: EvaluatorCandidateBuildRoleSchema,
			},
			{ additionalProperties: false },
		),
		probe_sha256: Sha256Schema,
		sanitizer_sha256: Sha256Schema,
		adapter_sha256: Sha256Schema,
		created_at: TimestampSchema,
	},
	{
		$id: "urn:repofixlab:schema:v1:task-environment-candidate-build-input",
		additionalProperties: false,
	},
);

export const TaskEnvironmentCandidateSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		candidate_type: Type.Literal("task_environment_candidate"),
		candidate_id: ContractIdSchema,
		instance_id: Type.Literal(AXIOS_SMOKE_INSTANCE_ID),
		base_commit: Type.Literal(AXIOS_SMOKE_BASE_COMMIT),
		dataset_lock: LockReferenceSchema,
		official_image_source_lock: LockReferenceSchema,
		roles: Type.Object(
			{
				worker: WorkerCandidateRoleSchema,
				evaluator: EvaluatorCandidateRoleSchema,
			},
			{ additionalProperties: false },
		),
		probe_sha256: Sha256Schema,
		sanitizer_sha256: Sha256Schema,
		adapter_sha256: Sha256Schema,
		created_at: TimestampSchema,
		candidate_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:task-environment-candidate",
		additionalProperties: false,
	},
);

export const TaskRoleFactoryProbeRequestSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		request_type: Type.Literal("task_role_factory_probe"),
		operation_id: OperationIdSchema,
		candidate_id: ContractIdSchema,
		candidate_sha256: Sha256Schema,
		probe_profile: Type.Literal(TASK_ROLE_FACTORY_PROBE_PROFILE),
		request_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:task-role-factory-probe-request",
		additionalProperties: false,
	},
);

const ObservedMountSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("bind"), Type.Literal("volume"), Type.Literal("tmpfs")]),
		source: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
		destination: AbsoluteContainerPathSchema,
		read_write: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ControllerExecutionNetworkSchema = Type.Object(
	{
		network_id: DockerObjectIdSchema,
		compose_project: Type.String({ pattern: COMPOSE_NAME_PATTERN }),
		compose_network: Type.Literal("repofix-control"),
		internal: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ControllerExecutionSchema = Type.Object(
	{
		container_hostname: Type.String({ pattern: CONTAINER_HOSTNAME_PATTERN }),
		container_id: DockerObjectIdSchema,
		image_id: ImageIdSchema,
		compose_project: Type.String({ pattern: COMPOSE_NAME_PATTERN }),
		compose_service: Type.Literal("controller"),
		compose_config_sha256: Sha256Schema,
		read_only_root_filesystem: Type.Boolean(),
		cap_drop: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
			uniqueItems: true,
		}),
		security_opt: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
			uniqueItems: true,
		}),
		published_ports: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
			uniqueItems: true,
		}),
		networks: Type.Array(ControllerExecutionNetworkSchema, {
			minItems: 1,
			maxItems: 1,
		}),
		mounts: Type.Array(ObservedMountSchema, {
			minItems: 4,
			maxItems: 4,
		}),
	},
	{ additionalProperties: false },
);

const RoleRuntimeInspectSchema = Type.Object(
	{
		configured_user: Type.String({ minLength: 1, maxLength: 100 }),
		uid: Type.Integer({ minimum: 0 }),
		gid: Type.Integer({ minimum: 0 }),
		network_mode: Type.String({ minLength: 1, maxLength: 100 }),
		read_only_root_filesystem: Type.Boolean(),
		cap_drop: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true }),
		cap_add: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true }),
		security_opt: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { uniqueItems: true }),
		privileged: Type.Boolean(),
		device_count: Type.Integer({ minimum: 0 }),
		nano_cpus: Type.Integer({ minimum: 0 }),
		memory_bytes: Type.Integer({ minimum: 0 }),
		memory_swap_bytes: Type.Integer({ minimum: 0 }),
		pids_limit: Type.Integer({ minimum: 0 }),
		tty: Type.Boolean(),
		stdin_open: Type.Boolean(),
		auto_remove: Type.Boolean(),
		published_ports: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { uniqueItems: true }),
		mounts: Type.Array(ObservedMountSchema),
		docker_socket_paths_present: Type.Array(
			Type.Union([Type.Literal("/var/run/docker.sock"), Type.Literal("/run/docker.sock")]),
			{ uniqueItems: true },
		),
		sensitive_environment_names_present: Type.Array(
			Type.Union([
				Type.Literal("ZHIPU_API_KEY"),
				Type.Literal("OPENAI_API_KEY"),
				Type.Literal("ANTHROPIC_API_KEY"),
				Type.Literal("DOCKER_HOST"),
			]),
			{ uniqueItems: true },
		),
	},
	{ additionalProperties: false },
);

const ActiveRoleProbeSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		probe_sha256: Sha256Schema,
		nonce_sha256: Sha256Schema,
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		timed_out: Type.Boolean(),
		duration_ms: Type.Integer({ minimum: 0 }),
		stdout_sha256: Type.Union([Sha256Schema, Type.Null()]),
		stderr_sha256: Type.Union([Sha256Schema, Type.Null()]),
		observed_uid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		observed_gid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		observed_base_commit: Type.Union([Type.String({ pattern: "^[a-f0-9]{40}$" }), Type.Null()]),
		writable_path_roundtrip: Type.Boolean(),
		docker_socket_paths_present: Type.Array(
			Type.Union([Type.Literal("/var/run/docker.sock"), Type.Literal("/run/docker.sock")]),
			{ uniqueItems: true },
		),
		sensitive_environment_names_present: Type.Array(
			Type.Union([
				Type.Literal("ZHIPU_API_KEY"),
				Type.Literal("OPENAI_API_KEY"),
				Type.Literal("ANTHROPIC_API_KEY"),
				Type.Literal("DOCKER_HOST"),
			]),
			{ uniqueItems: true },
		),
		errors: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const RoleCleanupEvidenceSchema = Type.Object(
	{
		container_removal_attempted: Type.Boolean(),
		container_removed: Type.Boolean(),
		created_volume_names: Type.Array(VolumeNameSchema, { uniqueItems: true }),
		removed_volume_names: Type.Array(VolumeNameSchema, { uniqueItems: true }),
		residual_container_ids: Type.Array(DockerObjectIdSchema, { uniqueItems: true }),
		residual_volume_names: Type.Array(VolumeNameSchema, { uniqueItems: true }),
		errors: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const FactoryProbeFailurePhaseSchema = Type.Union([
	Type.Literal("candidate_validation"),
	Type.Literal("image_inspect"),
	Type.Literal("create"),
	Type.Literal("start"),
	Type.Literal("active_probe"),
	Type.Literal("runtime_inspect"),
	Type.Literal("cleanup"),
	Type.Literal("residual_audit"),
]);

const FactoryRoleEvidenceCommon = {
	status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
	failure_phase: Type.Union([FactoryProbeFailurePhaseSchema, Type.Null()]),
	container_id: Type.Union([DockerObjectIdSchema, Type.Null()]),
	expected_image_id: ImageIdSchema,
	actual_image_id: Type.Union([ImageIdSchema, Type.Null()]),
	expected_platform: Type.Literal("linux/amd64"),
	actual_platform: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
	expected_provenance_sha256: Sha256Schema,
	actual_provenance_sha256: Type.Union([Sha256Schema, Type.Null()]),
	inspect: Type.Union([RoleRuntimeInspectSchema, Type.Null()]),
	active_probe: Type.Union([ActiveRoleProbeSchema, Type.Null()]),
	cleanup: RoleCleanupEvidenceSchema,
	errors: Type.Array(Type.String({ minLength: 1 })),
	evidence_sha256: Sha256Schema,
} as const;

const WorkerFactoryRoleEvidenceSchema = Type.Object(
	{
		role: Type.Literal("worker"),
		...FactoryRoleEvidenceCommon,
	},
	{ additionalProperties: false },
);

const EvaluatorFactoryRoleEvidenceSchema = Type.Object(
	{
		role: Type.Literal("evaluator"),
		...FactoryRoleEvidenceCommon,
	},
	{ additionalProperties: false },
);

export const TaskRoleFactoryProbeReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("task_role_factory_probe"),
		operation_id: OperationIdSchema,
		request_sha256: Sha256Schema,
		candidate_id: ContractIdSchema,
		candidate_sha256: Sha256Schema,
		probe_profile: Type.Literal(TASK_ROLE_FACTORY_PROBE_PROFILE),
		instance_id: Type.Literal(AXIOS_SMOKE_INSTANCE_ID),
		base_commit: Type.Literal(AXIOS_SMOKE_BASE_COMMIT),
		controller_execution: ControllerExecutionSchema,
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		started_at: TimestampSchema,
		finished_at: TimestampSchema,
		execution_order: Type.Array(Type.Union([Type.Literal("worker"), Type.Literal("evaluator")]), {
			minItems: 2,
			maxItems: 2,
			uniqueItems: true,
		}),
		roles: Type.Object(
			{
				worker: WorkerFactoryRoleEvidenceSchema,
				evaluator: EvaluatorFactoryRoleEvidenceSchema,
			},
			{ additionalProperties: false },
		),
		errors: Type.Array(Type.String({ minLength: 1 })),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:task-role-factory-probe-report",
		additionalProperties: false,
	},
);

const OfficialHarnessSourceFileSchema = Type.Object(
	{
		path: RelativeDataPathSchema,
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

export const OfficialHarnessSourceLockSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		lock_type: Type.Literal("official_harness_source"),
		lock_id: ContractIdSchema,
		upstream_version: Type.Literal(SWE_BENCH_HARNESS_VERSION),
		upstream_revision: Type.Literal(SWE_BENCH_HARNESS_REVISION),
		upstream_tree_sha1: Type.String({ pattern: "^[a-f0-9]{40}$" }),
		source_scope: Type.Literal("swebench"),
		source_file_count: Type.Literal(591),
		source_bytes: Type.Literal(1_953_143),
		source_aggregate_sha256: Sha256Schema,
		pyproject_sha256: Sha256Schema,
		files: Type.Array(OfficialHarnessSourceFileSchema, { minItems: 1 }),
		entrypoints: Type.Object(
			{
				run_evaluation_module: Type.Literal("swebench.harness.run_evaluation"),
				tap_parser: Type.Literal("swebench.harness.log_parsers.javascript.parse_log_tap"),
				grading_module: Type.Literal("swebench.harness.grading"),
			},
			{ additionalProperties: false },
		),
		test_command: Type.Array(Type.String({ minLength: 1 }), {
			minItems: AXIOS_SMOKE_TEST_COMMAND.length,
			maxItems: AXIOS_SMOKE_TEST_COMMAND.length,
		}),
		tap_pattern: Type.Literal(AXIOS_SMOKE_TAP_PATTERN),
		lock_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:official-harness-source-lock",
		additionalProperties: false,
	},
);

const HarnessProbeKindSchema = Type.Union([
	Type.Literal("base"),
	Type.Literal("no_op"),
	Type.Literal("malformed"),
	Type.Literal("gold"),
]);

const HarnessTestStatusSchema = Type.Union([
	Type.Literal("passed"),
	Type.Literal("failed"),
	Type.Literal("error"),
	Type.Literal("skipped"),
	Type.Literal("xfailed"),
]);

const HarnessTestStatusEntrySchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 1_000 }),
		status: HarnessTestStatusSchema,
	},
	{ additionalProperties: false },
);

const HarnessTestPartitionSchema = Type.Object(
	{
		success: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
		failure: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

const CandidatePatchApplyStatusSchema = Type.Union([
	Type.Literal("not_applicable"),
	Type.Literal("applied"),
	Type.Literal("error"),
	Type.Literal("rejected"),
]);

const TestPatchApplyStatusSchema = Type.Union([
	Type.Literal("not_run"),
	Type.Literal("applied"),
	Type.Literal("error"),
	Type.Literal("rejected"),
]);

const HarnessProbeErrorClassSchema = Type.Union([
	Type.Literal("patch_policy_error"),
	Type.Literal("patch_apply_error"),
	Type.Literal("test_patch_policy_error"),
	Type.Literal("test_patch_conflict"),
	Type.Literal("test_patch_apply_error"),
	Type.Literal("base_state_error"),
	Type.Literal("test_timeout"),
	Type.Literal("target_tests_not_collected"),
	Type.Literal("all_tests_skipped"),
	Type.Literal("test_execution_error"),
	Type.Literal("official_report_error"),
	Type.Literal("official_source_error"),
	Type.Literal("internal_error"),
]);

export const HarnessProbeReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("harness_probe"),
		harness_mode: Type.Union([Type.Literal("pristine"), Type.Literal("adapted")]),
		probe_kind: HarnessProbeKindSchema,
		instance_id: Type.Literal(AXIOS_SMOKE_INSTANCE_ID),
		base_commit: Type.Literal(AXIOS_SMOKE_BASE_COMMIT),
		harness_revision: Type.Literal(SWE_BENCH_HARNESS_REVISION),
		official_source_lock_sha256: Sha256Schema,
		pristine_runtime_lock_sha256: Sha256Schema,
		adapter_sha256: Type.Union([Type.Literal(AXIOS_HARNESS_ADAPTER_SHA256), Type.Null()]),
		candidate_patch_sha256: Type.Union([Sha256Schema, Type.Null()]),
		test_patch_sha256: Sha256Schema,
		candidate_patch_apply_status: CandidatePatchApplyStatusSchema,
		test_patch_apply_status: TestPatchApplyStatusSchema,
		test_executed: Type.Boolean(),
		test_collected: Type.Boolean(),
		test_status_map: Type.Array(HarnessTestStatusEntrySchema),
		collected_tests: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
		skipped_tests: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
		fail_to_pass: HarnessTestPartitionSchema,
		pass_to_pass: HarnessTestPartitionSchema,
		resolved: Type.Boolean(),
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		timed_out: Type.Boolean(),
		duration_ms: Type.Integer({ minimum: 0 }),
		test_log_sha256: Type.Union([Sha256Schema, Type.Null()]),
		official_report_sha256: Type.Union([Sha256Schema, Type.Null()]),
		error_class: Type.Union([HarnessProbeErrorClassSchema, Type.Null()]),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:harness-probe-report",
		additionalProperties: false,
	},
);

const HarnessEquivalenceEntrySchema = Type.Object(
	{
		probe_kind: HarnessProbeKindSchema,
		pristine_report_sha256: Sha256Schema,
		adapted_report_sha256: Sha256Schema,
		equivalent: Type.Boolean(),
		expected_outcome: Type.Boolean(),
		mismatched_fields: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const HarnessEquivalenceReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("harness_equivalence"),
		instance_id: Type.Literal(AXIOS_SMOKE_INSTANCE_ID),
		base_commit: Type.Literal(AXIOS_SMOKE_BASE_COMMIT),
		harness_revision: Type.Literal(SWE_BENCH_HARNESS_REVISION),
		official_source_lock_sha256: Sha256Schema,
		pristine_runtime_lock_sha256: Sha256Schema,
		adapter_sha256: Type.Literal(AXIOS_HARNESS_ADAPTER_SHA256),
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		probes: Type.Array(HarnessEquivalenceEntrySchema, { minItems: 4, maxItems: 4 }),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:harness-equivalence-report",
		additionalProperties: false,
	},
);

export const PristineRuntimeLockSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		lock_type: Type.Literal("pristine_runtime"),
		lock_id: Type.String({ pattern: "^pristine-runtime-v1-[a-f0-9]{64}$" }),
		created_at: TimestampSchema,
		image: Type.Object(
			{
				id: ImageIdSchema,
				repo_digest: RepositoryDigestSchema,
				created_at: TimestampSchema,
				size_bytes: Type.Integer({ minimum: 1 }),
				base_image: Type.Union([RepositoryDigestSchema, ImageIdSchema]),
				platform: Type.Literal("linux/amd64"),
				configured_user: Type.Literal("65532:65532"),
				oracle_runtime_user: Type.Literal("0:0"),
				entrypoint: Type.Array(
					Type.Union([
						Type.Literal("python"),
						Type.Literal("-m"),
						Type.Literal("repofixlab_evaluator.pristine_runtime"),
					]),
					{ minItems: 3, maxItems: 3 },
				),
				cmd: Type.Array(Type.Literal("self-check"), { minItems: 1, maxItems: 1 }),
				labels: Type.Object(
					{
						"io.repofixlab.harness.mode": Type.Literal("pristine"),
						"io.repofixlab.provenance.sha256": Sha256Schema,
						"org.opencontainers.image.revision": Type.Literal(SWE_BENCH_HARNESS_REVISION),
						"org.opencontainers.image.title": Type.Literal("RepoFixLab pristine SWE-bench harness"),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		provenance: Type.Object(
			{
				schema_version: Type.Literal(CONTRACT_VERSION),
				artifact_type: Type.Literal("repofixlab_pristine_harness"),
				platform: Type.Literal("linux/amd64"),
				base_image: Type.Union([RepositoryDigestSchema, ImageIdSchema]),
				sha256: Sha256Schema,
				source_archive_sha256: Sha256Schema,
				source_lock_sha256: Type.Literal("f7e8a6e953d3351fd9c4dcea471222a277d55af7b5c25d384bda251b91c51a71"),
				source_lock_file_sha256: Type.Literal("8b9ce8b01b58cbcfbef3a88e1b4cb99289553c948ccaa27afa83771ae5bb6741"),
				source_aggregate_sha256: Type.Literal("b8c8574e17fd0c11159c7fa3a63e17a247ca5b2f73fa0a9899ca542cfcb093e6"),
				upstream_revision: Type.Literal(SWE_BENCH_HARNESS_REVISION),
				upstream_tree_sha1: Type.Literal("f178530b37202c549b1b2b3300db2da90da648db"),
				dependency_lock_sha256: Type.Literal("b836155987474285284c3b8228e8575dda5d4d3ae12e1bce049fc2894424cba9"),
				evaluator_kernel_aggregate_sha256: Sha256Schema,
				evaluator_kernel_file_count: Type.Integer({ minimum: 1 }),
				evaluator_kernel_bytes: Type.Integer({ minimum: 1 }),
				dockerfile_sha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
		verification: Type.Object(
			{
				current_materials_bound: Type.Literal(true),
				build_time_self_check_passed: Type.Literal(true),
				restricted_runtime_self_check_passed: Type.Literal(true),
				run_evaluation_import: Type.Literal("swebench/harness/run_evaluation.py"),
				golden_oracle_resolved: Type.Literal(true),
				golden_oracle_status_map_sha256: Type.Literal(
					"00f69ade8e7237bb84f0d42c92c48fff1b4a7c4e37f3493804fbb978a0c9fbf0",
				),
				runtime_controls: Type.Object(
					{
						network: Type.Literal("none"),
						read_only_root: Type.Literal(true),
						cap_drop: Type.Array(Type.Literal("ALL"), { minItems: 1, maxItems: 1 }),
						no_new_privileges: Type.Literal(true),
						docker_socket: Type.Literal(false),
						published_ports: Type.Literal(false),
						sensitive_environment: Type.Literal(false),
						pids_limit: Type.Literal(128),
						memory_bytes: Type.Literal(1_073_741_824),
						cpus: Type.Literal(1),
						tmpfs: Type.Literal("/tmp:rw,noexec,nosuid,size=16m"),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		semantic_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:pristine-runtime-lock",
		additionalProperties: false,
	},
);

const OfficialImageSourceSchema = Type.Object(
	{
		image_key: Type.String({ minLength: 1, maxLength: 240 }),
		requested_reference: Type.String({ minLength: 1, maxLength: 500 }),
		repository_digest: RepositoryDigestSchema,
		local_image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
		registry_response_sha256: Sha256Schema,
		resolved_at: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const OfficialImageSourceLockSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		lock_type: Type.Literal("official_image_source"),
		lock_id: ContractIdSchema,
		dataset_revision: Type.String({ minLength: 7, maxLength: 160 }),
		harness_revision: Type.String({ minLength: 7, maxLength: 160 }),
		images: Type.Array(OfficialImageSourceSchema, { minItems: 1 }),
		seal_sha256: Sha256Schema,
		created_at: TimestampSchema,
	},
	{
		$id: "urn:repofixlab:schema:v1:official-image-source-lock",
		additionalProperties: false,
	},
);

const ResourceProfileSchema = Type.Object(
	{
		cpu_count: Type.Number({ exclusiveMinimum: 0 }),
		memory_bytes: Type.Integer({ minimum: 1 }),
		pids_limit: Type.Integer({ minimum: 1 }),
		network_mode: Type.Literal("none"),
		read_only_root_filesystem: Type.Literal(true),
	},
	{ additionalProperties: false },
);

const LockedSourceImageSchema = Type.Object(
	{
		repository_digest: RepositoryDigestSchema,
		local_image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
	},
	{ additionalProperties: false },
);

const LockedDerivedImageSchema = Type.Object(
	{
		local_image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
		provenance_sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const FinalEnvironmentVerificationSchema = Type.Object(
	{
		factory_probe_passed: Type.Literal(true),
		factory_probe_report_sha256: Sha256Schema,
		equivalence_passed: Type.Literal(true),
		security_profile_passed: Type.Literal(true),
		evidence_sha256: Sha256Schema,
		completed_at: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const TaskEnvironmentLockSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		lock_type: Type.Literal("task_environment"),
		lock_id: ContractIdSchema,
		instance_id: InstanceIdSchema,
		candidate_id: ContractIdSchema,
		candidate_sha256: Sha256Schema,
		dataset_lock_id: ContractIdSchema,
		official_image_source_lock_id: ContractIdSchema,
		source_image: LockedSourceImageSchema,
		worker_image: LockedDerivedImageSchema,
		evaluator_image: LockedDerivedImageSchema,
		resource_profile: ResourceProfileSchema,
		filesystem_profile_sha256: Sha256Schema,
		sanitizer_sha256: Sha256Schema,
		adapter_sha256: Sha256Schema,
		verification: FinalEnvironmentVerificationSchema,
		seal_sha256: Sha256Schema,
		created_at: TimestampSchema,
	},
	{
		$id: "urn:repofixlab:schema:v1:task-environment-lock",
		additionalProperties: false,
	},
);

const PublicTaskSchema = Type.Object(
	{
		instance_id: InstanceIdSchema,
		repo: Type.String({ minLength: 1, maxLength: 300 }),
		problem_statement: Type.String({ minLength: 1 }),
		base_commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
		language: Type.String({ minLength: 1, maxLength: 80 }),
	},
	{ additionalProperties: false },
);

export const PublicTaskManifestSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		manifest_id: ContractIdSchema,
		dataset_lock_id: ContractIdSchema,
		task_environment_lock_id: ContractIdSchema,
		task: PublicTaskSchema,
		worker_image_id: ImageIdSchema,
		resource_profile: ResourceProfileSchema,
		split: Type.Union([Type.Literal("dev"), Type.Literal("validation"), Type.Literal("test")]),
		manifest_sha256: Sha256Schema,
		created_at: TimestampSchema,
	},
	{
		$id: "urn:repofixlab:schema:v1:public-task-manifest",
		additionalProperties: false,
	},
);

const DoctorStateSchema = Type.Union([
	Type.Literal("pass"),
	Type.Literal("fail"),
	Type.Literal("warning"),
	Type.Literal("unverified"),
]);

const StorageDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		path: Type.String({ minLength: 1 }),
		minimum_available_bytes: Type.Integer({ minimum: 1 }),
		available_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
		volume_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		probe_image_digest: Type.Optional(RepositoryDigestSchema),
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const ComputeDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		minimum_cpu_count: Type.Number({ exclusiveMinimum: 0 }),
		minimum_memory_bytes: Type.Integer({ minimum: 1 }),
		cpu_count: Type.Optional(Type.Number({ minimum: 0 })),
		memory_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const DaemonDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		server_version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		operating_system: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		architecture: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const NullableStringSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const NullableBooleanSchema = Type.Union([Type.Boolean(), Type.Null()]);
const NullableDecimalBytesSchema = Type.Union([DecimalBytesSchema, Type.Null()]);
const NullableSocketAccessSchema = Type.Union([
	Type.Literal("read-write"),
	Type.Literal("read-only"),
	Type.Literal("none"),
	Type.Null(),
]);

const SocketTopologySchema = Type.Object(
	{
		controller: NullableSocketAccessSchema,
		orchestrator: NullableSocketAccessSchema,
		dataset_preparer: NullableSocketAccessSchema,
		worker: NullableSocketAccessSchema,
		evaluator: NullableSocketAccessSchema,
	},
	{ additionalProperties: false },
);

const BooleanDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		actual: NullableBooleanSchema,
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const SocketDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		required_roles: Type.Array(Type.Union([Type.Literal("controller"), Type.Literal("orchestrator")]), {
			minItems: 2,
			maxItems: 2,
			uniqueItems: true,
		}),
		deferred_roles: Type.Object(
			{
				dataset_preparer: Type.Literal("dataset_prepare"),
				worker: Type.Literal("smoke_formal"),
				evaluator: Type.Literal("smoke_formal"),
			},
			{ additionalProperties: false },
		),
		actual: SocketTopologySchema,
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const ControllerIntegrityCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		errors: Type.Array(Type.String({ minLength: 1 })),
		message: Type.String({ minLength: 1 }),
		evidence_sha256: Type.Optional(Sha256Schema),
	},
	{ additionalProperties: false },
);

const BootstrapNetworkObservationSchema = Type.Object(
	{
		network_id: DockerObjectIdSchema,
		compose_project: NullableStringSchema,
		compose_network: NullableStringSchema,
		internal: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const BootstrapBaseImageObservationSchema = Type.Object(
	{
		image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
		repository_digests: Type.Array(RepositoryDigestSchema, { minItems: 1 }),
		rootfs_layers: Type.Array(ImageIdSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const BootstrapServiceImageObservationSchema = Type.Object(
	{
		container_id: DockerObjectIdSchema,
		image_id: ImageIdSchema,
		platform: Type.Literal("linux/amd64"),
		compose_project: NullableStringSchema,
		compose_service: NullableStringSchema,
		compose_config_sha256: Type.Union([Sha256Schema, Type.Null()]),
		published_ports: Type.Array(Type.String({ minLength: 1, maxLength: 500 })),
		networks: Type.Array(BootstrapNetworkObservationSchema),
		image_rootfs_layers: Type.Array(ImageIdSchema, { minItems: 1 }),
		base_image: BootstrapBaseImageObservationSchema,
	},
	{ additionalProperties: false },
);

const ControllerBootstrapImageProvenanceSchema = Type.Object(
	{
		services: Type.Object(
			{
				controller: Type.Union([BootstrapServiceImageObservationSchema, Type.Null()]),
				orchestrator: Type.Union([BootstrapServiceImageObservationSchema, Type.Null()]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const NullableImageIdSchema = Type.Union([ImageIdSchema, Type.Null()]);
const NullableRepositoryDigestSchema = Type.Union([RepositoryDigestSchema, Type.Null()]);
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);

const BootstrapImageProvenanceServiceResultSchema = Type.Object(
	{
		state: DoctorStateSchema,
		expected_image_id: NullableImageIdSchema,
		actual_image_id: NullableImageIdSchema,
		expected_compose_config_sha256: NullableSha256Schema,
		actual_compose_config_sha256: NullableSha256Schema,
		base_repository_digest: NullableRepositoryDigestSchema,
		base_image_id: NullableImageIdSchema,
		errors: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const BootstrapImageProvenanceDoctorCheckSchema = Type.Object(
	{
		state: DoctorStateSchema,
		lock_sha256: NullableSha256Schema,
		evidence_sha256: NullableSha256Schema,
		services: Type.Object(
			{
				controller: BootstrapImageProvenanceServiceResultSchema,
				orchestrator: BootstrapImageProvenanceServiceResultSchema,
			},
			{ additionalProperties: false },
		),
		message: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const ControllerBootstrapHealthSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		response_type: Type.Literal("controller_bootstrap_health"),
		daemon_reachable: Type.Boolean(),
		server_version: NullableStringSchema,
		os_type: NullableStringSchema,
		architecture: NullableStringSchema,
		cpu_count: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		memory_bytes: NullableDecimalBytesSchema,
		docker_root_dir: NullableStringSchema,
		docker_volume_available_bytes: NullableDecimalBytesSchema,
		docker_volume_id: NullableStringSchema,
		probe_image_digest: RepositoryDigestSchema,
		control_network_internal: NullableBooleanSchema,
		image_provenance: ControllerBootstrapImageProvenanceSchema,
		socket_topology: SocketTopologySchema,
		errors: Type.Array(Type.String({ minLength: 1 })),
	},
	{
		$id: "urn:repofixlab:schema:v1:controller-bootstrap-health",
		additionalProperties: false,
	},
);

export const BootstrapDoctorReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("bootstrap_doctor"),
		report_id: ContractIdSchema,
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		started_at: TimestampSchema,
		finished_at: TimestampSchema,
		checks: Type.Object(
			{
				docker_daemon: DaemonDoctorCheckSchema,
				host_artifacts_storage: StorageDoctorCheckSchema,
				docker_managed_storage: StorageDoctorCheckSchema,
				compute: ComputeDoctorCheckSchema,
				control_network: BooleanDoctorCheckSchema,
				docker_socket_ownership: SocketDoctorCheckSchema,
				base_images: BootstrapImageProvenanceDoctorCheckSchema,
				controller_integrity: ControllerIntegrityCheckSchema,
			},
			{ additionalProperties: false },
		),
		warnings: Type.Array(Type.String({ minLength: 1 })),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:bootstrap-doctor-report",
		additionalProperties: false,
	},
);

const SmokeDoctorFactSchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,99}$" }),
		expected: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
		actual: Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
		matched: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const SmokeDoctorArtifactSchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,99}$" }),
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

const SmokeDoctorHardGateSchema = Type.Object(
	{
		state: DoctorStateSchema,
		artifacts: Type.Array(SmokeDoctorArtifactSchema, { maxItems: 32 }),
		facts: Type.Array(SmokeDoctorFactSchema, { minItems: 1, maxItems: 64 }),
		errors: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

export const SmokeDoctorReportSchema = Type.Object(
	{
		schema_version: Type.Literal(CONTRACT_VERSION),
		report_type: Type.Literal("smoke_doctor"),
		report_id: ContractIdSchema,
		status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		started_at: TimestampSchema,
		finished_at: TimestampSchema,
		instance_id: Type.Literal(AXIOS_SMOKE_INSTANCE_ID),
		operation_id: Type.Union([OperationIdSchema, Type.Null()]),
		checks: Type.Object(
			{
				bootstrap_control_plane: SmokeDoctorHardGateSchema,
				dataset_lock: SmokeDoctorHardGateSchema,
				official_image_source_lock: SmokeDoctorHardGateSchema,
				task_environment_lock: SmokeDoctorHardGateSchema,
				factory_probe: SmokeDoctorHardGateSchema,
				factory_controller_identity: SmokeDoctorHardGateSchema,
				pristine_runtime_lock: SmokeDoctorHardGateSchema,
				harness_probe_matrix: SmokeDoctorHardGateSchema,
				harness_equivalence: SmokeDoctorHardGateSchema,
				cross_bindings: SmokeDoctorHardGateSchema,
			},
			{ additionalProperties: false },
		),
		report_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:smoke-doctor-report",
		additionalProperties: false,
	},
);

export type DatasetLock = Static<typeof DatasetLockSchema>;
export type DatasetPreparerSelfCheckReport = Static<typeof DatasetPreparerSelfCheckReportSchema>;
export type TaskEnvironmentCandidateBuildInput = Static<typeof TaskEnvironmentCandidateBuildInputSchema>;
export type TaskEnvironmentCandidate = Static<typeof TaskEnvironmentCandidateSchema>;
export type TaskRoleFactoryProbeRequest = Static<typeof TaskRoleFactoryProbeRequestSchema>;
export type TaskRoleFactoryProbeReport = Static<typeof TaskRoleFactoryProbeReportSchema>;
export type OfficialHarnessSourceLock = Static<typeof OfficialHarnessSourceLockSchema>;
export type HarnessProbeReport = Static<typeof HarnessProbeReportSchema>;
export type HarnessEquivalenceReport = Static<typeof HarnessEquivalenceReportSchema>;
export type PristineRuntimeLock = Static<typeof PristineRuntimeLockSchema>;
export type OfficialImageSourceLock = Static<typeof OfficialImageSourceLockSchema>;
export type TaskEnvironmentLock = Static<typeof TaskEnvironmentLockSchema>;
export type PublicTaskManifest = Static<typeof PublicTaskManifestSchema>;
export type BootstrapDoctorReport = Static<typeof BootstrapDoctorReportSchema>;
export type ControllerBootstrapHealth = Static<typeof ControllerBootstrapHealthSchema>;
export type SmokeDoctorReport = Static<typeof SmokeDoctorReportSchema>;

export interface VersionedSchema {
	fileName: string;
	schema: TSchema;
}

export const V1_SCHEMAS = [
	{ fileName: "bootstrap-doctor-report.schema.json", schema: BootstrapDoctorReportSchema },
	{ fileName: "controller-bootstrap-health.schema.json", schema: ControllerBootstrapHealthSchema },
	{ fileName: "dataset-lock.schema.json", schema: DatasetLockSchema },
	{ fileName: "dataset-preparer-self-check-report.schema.json", schema: DatasetPreparerSelfCheckReportSchema },
	{ fileName: "official-image-source-lock.schema.json", schema: OfficialImageSourceLockSchema },
	{ fileName: "official-harness-source-lock.schema.json", schema: OfficialHarnessSourceLockSchema },
	{ fileName: "harness-probe-report.schema.json", schema: HarnessProbeReportSchema },
	{ fileName: "harness-equivalence-report.schema.json", schema: HarnessEquivalenceReportSchema },
	{ fileName: "pristine-runtime-lock.schema.json", schema: PristineRuntimeLockSchema },
	{ fileName: "public-task-manifest.schema.json", schema: PublicTaskManifestSchema },
	{ fileName: "smoke-doctor-report.schema.json", schema: SmokeDoctorReportSchema },
	{ fileName: "task-environment-candidate-build-input.schema.json", schema: TaskEnvironmentCandidateBuildInputSchema },
	{ fileName: "task-environment-candidate.schema.json", schema: TaskEnvironmentCandidateSchema },
	{ fileName: "task-environment-lock.schema.json", schema: TaskEnvironmentLockSchema },
	{ fileName: "task-role-factory-probe-request.schema.json", schema: TaskRoleFactoryProbeRequestSchema },
	{ fileName: "task-role-factory-probe-report.schema.json", schema: TaskRoleFactoryProbeReportSchema },
] as const satisfies readonly VersionedSchema[];
