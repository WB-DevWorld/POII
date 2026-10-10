// HTTP API contract for POII (release one, manual journey). Mirrors docs/api.md.
// Request and response shapes are zod schemas so the API validates input and the web app types output.
import { z } from 'zod';
import {
  ActorKind, AnchorResult, Authority, EvidenceRole, LifecycleStatus, Locator, RecordKind, ReviewState,
  StatedRole, StatementMode, TimeStatus,
} from './vocabulary.js';

export const Id = z.uuid();
export const IsoTime = z.iso.datetime({ offset: true });

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// ----- identity -------------------------------------------------------------------------------

export const ActorView = z.object({
  id: Id,
  kind: ActorKind,
  displayName: z.string(),
  authority: Authority.nullable(),
  details: z.record(z.string(), z.unknown()),
  revokedAt: IsoTime.nullable(),
});
export type ActorView = z.infer<typeof ActorView>;

export const MeResponse = z.object({
  actor: ActorView,
  workspace: z.object({ id: Id, name: z.string() }),
  capabilities: z.object({ canConfirm: z.boolean(), canDelete: z.boolean(), canPropose: z.boolean() }),
  aiEnabled: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const CreateActorRequest = z.object({
  kind: z.enum(['person', 'ai_assistant']),
  displayName: z.string().min(1).max(200),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type CreateActorRequest = z.infer<typeof CreateActorRequest>;

// ----- sources --------------------------------------------------------------------------------

export const SourceOrigin = z.record(z.string(), z.unknown());

export const CreateSourceRequest = z.object({
  title: z.string().min(1).max(500),
  kind: z.enum(['paste', 'upload']),
  content: z.string().min(1).max(20_000_000),
  mediaType: z.string().max(100).default('text/plain'),
  fileName: z.string().max(500).optional(),
  origin: SourceOrigin.default({}),
  originKey: z.string().max(500).optional(),
  aiAllowed: z.boolean().default(true),
});
export type CreateSourceRequest = z.infer<typeof CreateSourceRequest>;

export const RevisionMeta = z.object({
  id: Id,
  revisionNo: z.number().int().positive(),
  contentSha256: z.string(),
  byteLength: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  note: z.string().nullable(),
  createdAt: IsoTime,
  createdByActorId: Id,
  /** Only on the response to POST /v1/sources/:id/revisions when a new revision was added: how evidence re-anchored. */
  reanchored: z.object({ exact: z.number().int().nonnegative(), moved: z.number().int().nonnegative(), lost: z.number().int().nonnegative() }).optional(),
});
export type RevisionMeta = z.infer<typeof RevisionMeta>;

export const RevisionView = RevisionMeta.extend({ contentText: z.string() });
export type RevisionView = z.infer<typeof RevisionView>;

export const SourceView = z.object({
  id: Id,
  title: z.string(),
  kind: z.enum(['paste', 'upload', 'import']),
  mediaType: z.string(),
  origin: SourceOrigin,
  originKey: z.string().nullable(),
  aiAllowed: z.boolean(),
  archivedAt: IsoTime.nullable(),
  createdAt: IsoTime,
  createdByActorId: Id,
  currentRevision: RevisionMeta,
  revisionCount: z.number().int().positive(),
  recordCount: z.number().int().nonnegative(),
  /** True when this call found an identical source and returned it instead of creating one. */
  deduplicated: z.boolean().optional(),
});
export type SourceView = z.infer<typeof SourceView>;

export const SourceDetail = SourceView.extend({
  revisions: z.array(RevisionMeta),
  currentRevision: RevisionView,
});
export type SourceDetail = z.infer<typeof SourceDetail>;

export const AddRevisionRequest = z.object({ content: z.string().min(1).max(20_000_000), note: z.string().max(2000).optional() });
export const UpdateSourceRequest = z.object({
  title: z.string().min(1).max(500).optional(),
  aiAllowed: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export const DeleteSourceRequest = z.object({ reason: z.string().max(2000).optional() });
export const ListSourcesQuery = z.object({
  archived: z.enum(['true', 'false', 'all']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ----- records --------------------------------------------------------------------------------

export const EvidenceInput = z.object({
  sourceId: Id,
  /** Defaults to the source's current revision. */
  revisionId: Id.optional(),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().positive(),
  role: EvidenceRole.default('primary'),
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;

export const TimeConflict = z.object({ value: IsoTime.nullable(), sourceId: Id.optional(), note: z.string().max(500).optional() });

export const RecordTimes = z.object({
  effectiveAt: IsoTime.nullable().optional(),
  effectiveAtStatus: TimeStatus.optional(),
  observedAt: IsoTime.nullable().optional(),
  observedAtStatus: TimeStatus.optional(),
  timeConflicts: z.array(TimeConflict).nullable().optional(),
});

export const CreateRecordRequest = RecordTimes.extend({
  kind: RecordKind,
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).default(''),
  lifecycleStatus: LifecycleStatus.default('unknown'),
  statedByActorId: Id.nullable().optional(),
  statedRole: StatedRole.default('unknown'),
  statementMode: StatementMode,
  supersedesRecordId: Id.optional(),
  evidence: z.array(EvidenceInput).min(1),
});
export type CreateRecordRequest = z.infer<typeof CreateRecordRequest>;

export const UpdateRecordRequest = RecordTimes.extend({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
  kind: RecordKind.optional(),
  lifecycleStatus: LifecycleStatus.optional(),
  statedByActorId: Id.nullable().optional(),
  statedRole: StatedRole.optional(),
  statementMode: StatementMode.optional(),
  note: z.string().max(2000).optional(),
});
export type UpdateRecordRequest = z.infer<typeof UpdateRecordRequest>;

export const ConfirmRecordRequest = z.object({
  note: z.string().max(2000).optional(),
  /** Defaults to supersedesRecordId when the record supersedes another. */
  antecedentRecordId: Id.optional(),
});
export const RejectRecordRequest = z.object({ reason: z.string().min(1).max(2000) });
export const SetStatusRequest = z.object({
  lifecycleStatus: LifecycleStatus,
  observedAt: IsoTime.nullable().optional(),
  observedAtStatus: TimeStatus.optional(),
  note: z.string().max(2000).optional(),
});
export const SupersedeRecordRequest = CreateRecordRequest.omit({ supersedesRecordId: true });

export const EvidenceView = z.object({
  id: Id,
  sourceId: Id.nullable(),
  originalSourceId: Id,
  sourceTitle: z.string().nullable(),
  revisionId: Id.nullable(),
  revisionNo: z.number().int().nullable(),
  locator: Locator,
  role: EvidenceRole,
  anchorResult: AnchorResult,
  /** False when the source was deleted; exports list it as unavailable. */
  available: z.boolean(),
  sourceAiAllowed: z.boolean().nullable(),
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const ApprovalView = z.object({
  id: Id,
  approvedByActorId: Id,
  approvedByDisplayName: z.string(),
  authority: Authority,
  approvedAt: IsoTime,
  antecedentRecordId: Id.nullable(),
  note: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const RecordSummary = z.object({
  id: Id,
  kind: RecordKind,
  title: z.string(),
  reviewState: ReviewState,
  lifecycleStatus: LifecycleStatus,
  statedRole: StatedRole,
  statementMode: StatementMode,
  statedByDisplayName: z.string().nullable(),
  recordedAt: IsoTime,
  effectiveAt: IsoTime.nullable(),
  effectiveAtStatus: TimeStatus,
  observedAt: IsoTime.nullable(),
  observedAtStatus: TimeStatus,
  supersedesRecordId: Id.nullable(),
  supersededByRecordId: Id.nullable(),
  aiAllowed: z.boolean(),
  versionNo: z.number().int().positive(),
  updatedAt: IsoTime,
});
export type RecordSummary = z.infer<typeof RecordSummary>;

export const RecordVersionView = z.object({
  versionNo: z.number().int().positive(),
  changeKind: z.enum(['create', 'edit', 'confirm', 'reject', 'supersede', 'status', 'evidence']),
  changedByActorId: Id,
  changedByDisplayName: z.string(),
  changedAt: IsoTime,
  note: z.string().nullable(),
  snapshot: z.record(z.string(), z.unknown()),
});

export const RecordDetail = RecordSummary.extend({
  body: z.string(),
  statedByActorId: Id.nullable(),
  timeConflicts: z.array(TimeConflict).nullable(),
  rejectedAt: IsoTime.nullable(),
  rejectionReason: z.string().nullable(),
  origin: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(EvidenceView),
  approvals: z.array(ApprovalView),
  versions: z.array(RecordVersionView),
  /** The chain of confirmed successors, nearest first. Empty when the record is current or unconfirmed. */
  supersededBy: z.array(z.object({ id: Id, title: z.string(), reviewState: ReviewState })),
  supersedes: z.object({ id: Id, title: z.string(), reviewState: ReviewState }).nullable(),
});
export type RecordDetail = z.infer<typeof RecordDetail>;

export const ListRecordsQuery = z.object({
  kind: RecordKind.optional(),
  reviewState: ReviewState.optional(),
  lifecycleStatus: LifecycleStatus.optional(),
  sourceId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ----- views ----------------------------------------------------------------------------------

export const CurrentDecision = z.object({
  record: RecordSummary,
  approval: ApprovalView,
  /** Records this decision replaced, oldest last. */
  replaced: z.array(z.object({ id: Id, title: z.string(), approvedAt: IsoTime.nullable() })),
  primaryEvidence: EvidenceView.nullable(),
  staleness: z.object({
    lastObservedAt: IsoTime.nullable(),
    label: z.enum(['observed', 'stale', 'unknown']),
  }),
});
export type CurrentDecision = z.infer<typeof CurrentDecision>;

export const SearchQuery = z.object({ q: z.string().min(1).max(500), limit: z.coerce.number().int().min(1).max(100).default(20) });

export const SearchHit = z.object({
  type: z.enum(['source', 'record']),
  id: Id,
  title: z.string(),
  headline: z.string(),
  rank: z.number(),
  /** For sources: the first span that matches, so the UI can open the original there. */
  span: z.object({ revisionId: Id, startChar: z.number().int(), endChar: z.number().int(), startLine: z.number().int() }).nullable(),
  reviewState: ReviewState.nullable(),
  kind: z.string().nullable(),
});
export const SearchResponse = z.object({ query: z.string(), hits: z.array(SearchHit) });
export type SearchResponse = z.infer<typeof SearchResponse>;

// ----- exports --------------------------------------------------------------------------------

export const CONTEXT_PACK_FORMAT = 'poii.context-pack';
export const CONTEXT_PACK_VERSION = 1;
export const BACKUP_FORMAT = 'poii.backup';
export const BACKUP_VERSION = 1;

export const ContextPackRequest = z.object({
  /** 'ai' excludes never-send-to-AI sources and the records derived from them. */
  destination: z.enum(['person', 'ai']).default('person'),
  kinds: z.array(RecordKind).optional(),
  reviewStates: z.array(ReviewState).default(['confirmed']),
  lifecycleStatuses: z.array(LifecycleStatus).optional(),
  recordIds: z.array(Id).optional(),
  sourceIds: z.array(Id).optional(),
  includeExcerpts: z.boolean().default(true),
  title: z.string().max(200).optional(),
});
export type ContextPackRequest = z.infer<typeof ContextPackRequest>;

export const ManifestSource = z.object({
  sourceId: Id,
  title: z.string().nullable(),
  revisionId: Id.nullable(),
  contentSha256: z.string().nullable(),
  reason: z.string(),
});

export const ContextPackManifest = z.object({
  format: z.literal(CONTEXT_PACK_FORMAT),
  formatVersion: z.literal(CONTEXT_PACK_VERSION),
  exportRunId: Id,
  generatedAt: IsoTime,
  destination: z.enum(['person', 'ai']),
  selection: z.record(z.string(), z.unknown()),
  included: z.array(ManifestSource),
  excluded: z.array(ManifestSource),
  unavailable: z.array(ManifestSource),
  recordCount: z.number().int().nonnegative(),
});
export type ContextPackManifest = z.infer<typeof ContextPackManifest>;

export const ContextPackResponse = z.object({
  exportRunId: Id,
  manifest: ContextPackManifest,
  markdown: z.string(),
  json: z.record(z.string(), z.unknown()),
});
export type ContextPackResponse = z.infer<typeof ContextPackResponse>;

export const ExportRunView = z.object({
  id: Id,
  kind: z.enum(['context_pack', 'backup']),
  formatVersion: z.number().int(),
  createdAt: IsoTime,
  contentSha256: z.string(),
  manifest: z.record(z.string(), z.unknown()),
});

export const RestoreRequest = z.object({ backup: z.record(z.string(), z.unknown()) });
export const RestoreResponse = z.object({
  restored: z.object({
    sources: z.number().int(), revisions: z.number().int(), records: z.number().int(), approvals: z.number().int(),
    evidence: z.number().int(), versions: z.number().int(), actors: z.number().int(), tombstones: z.number().int(),
    auditEvents: z.number().int(),
  }),
  workspaceId: Id,
  /** True when this exact backup had already been restored into this workspace; nothing was written. */
  alreadyRestored: z.boolean().optional(),
});
export type RestoreResponse = z.infer<typeof RestoreResponse>;

/** One row of a backed-up table: column names in camelCase, times as ISO strings. */
export const BackupRow = z.record(z.string(), z.unknown());

/** The poii.backup v1 document (ADR-0008): the complete workspace with identical ids and original bytes. */
export const BackupDocument = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_VERSION),
  generatedAt: IsoTime,
  exportRunId: Id.optional(),
  workspace: z.object({ id: Id, name: z.string(), createdAt: IsoTime }),
  actors: z.array(BackupRow),
  sources: z.array(BackupRow),
  /** Each revision carries contentText and originalBase64 (the bytes from the storage port). */
  revisions: z.array(BackupRow),
  tombstones: z.array(BackupRow),
  records: z.array(BackupRow),
  versions: z.array(BackupRow),
  evidence: z.array(BackupRow),
  approvals: z.array(BackupRow),
  auditEvents: z.array(BackupRow),
  exportRuns: z.array(BackupRow),
});
export type BackupDocument = z.infer<typeof BackupDocument>;

export type SearchHit = z.infer<typeof SearchHit>;
export type ExportRunView = z.infer<typeof ExportRunView>;
export type ManifestSource = z.infer<typeof ManifestSource>;

// #13 AI ----------------------------------------------------------------------------------------------
// AI-assisted candidate extraction (ADR-0007). Two steps: preview shows exactly the text that would be sent;
// execute sends only that text. Sources and records that are never-send-to-AI are refused (409 ai_not_allowed).

export const aiProviders = ['anthropic', 'openai'] as const;
export const AiProvider = z.enum(aiProviders);
export type AiProvider = z.infer<typeof AiProvider>;

export const AiPreviewRequest = z.object({
  sourceId: Id,
  /** Defaults to the source's current revision. */
  revisionId: Id.optional(),
  /** Defaults to the whole revision. */
  startChar: z.number().int().nonnegative().optional(),
  endChar: z.number().int().positive().optional(),
  /** Existing records sent as "already recorded" context. */
  recordIds: z.array(Id).max(20).default([]),
  provider: AiProvider.optional(),
});
export type AiPreviewRequest = z.infer<typeof AiPreviewRequest>;

export const AiPreviewResponse = z.object({
  previewId: Id,
  provider: AiProvider,
  model: z.string(),
  /** Exactly what will be sent as the single user message, byte for byte. */
  promptText: z.string(),
  promptSha256: z.string(),
  sourceId: Id,
  revisionId: Id,
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().positive(),
  recordIds: z.array(Id),
  inputTokensEstimate: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().positive(),
  /** Upper estimate (estimated input plus the maximum output); this amount is reserved against the cap on execute. */
  estimatedCostUsd: z.number().nonnegative(),
  remainingCapUsd: z.number().nonnegative(),
  monthlyCapUsd: z.number().nonnegative(),
  expiresAt: IsoTime,
});
export type AiPreviewResponse = z.infer<typeof AiPreviewResponse>;

export const AiExecuteRequest = z.object({ previewId: Id });
export type AiExecuteRequest = z.infer<typeof AiExecuteRequest>;

export const AiOutcome = z.enum(['ok', 'malformed', 'refused', 'truncated', 'provider_error', 'network_error']);
export type AiOutcome = z.infer<typeof AiOutcome>;

export const AiExecuteResponse = z.object({
  previewId: Id,
  provider: AiProvider,
  model: z.string(),
  outcome: AiOutcome,
  /** Readable problems (malformed output, dropped candidates, provider errors). Never contains prompt text. */
  errors: z.array(z.string()),
  /** The candidate records created (reviewState candidate, statementMode ai_extracted). Never confirmed. */
  records: z.array(RecordSummary),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reservedUsd: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    /** True when the cost comes from the provider's reported usage. */
    reconciled: z.boolean(),
  }),
});
export type AiExecuteResponse = z.infer<typeof AiExecuteResponse>;

export const AiUsageProvider = z.object({
  provider: AiProvider,
  capUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  remainingUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export const AiUsageResponse = z.object({
  /** Calendar month in UTC, YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  providers: z.array(AiUsageProvider),
});
export type AiUsageResponse = z.infer<typeof AiUsageResponse>;

export const AiStatusResponse = z.object({
  enabled: z.boolean(),
  defaultProvider: AiProvider.nullable(),
  providers: z.array(z.object({
    provider: AiProvider,
    configured: z.boolean(),
    model: z.string(),
    reason: z.string().nullable(),
    monthlyCapUsd: z.number().nonnegative(),
    pricing: z.object({ inputUsdPerMTok: z.number(), outputUsdPerMTok: z.number() }).nullable(),
  })),
  previewTtlSeconds: z.number().int().positive(),
  maxInputChars: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  logRequestText: z.boolean(),
});
export type AiStatusResponse = z.infer<typeof AiStatusResponse>;
// end #13 AI ------------------------------------------------------------------------------------------
// #16 ops
/** GET /health/version: what is running. Informational; readiness never depends on it. */
export const HealthVersion = z.object({
  version: z.string(),
  builtAt: z.string().nullable(),
  node: z.string(),
  /** Newest applied and newest shipped migration names (without `.sql`); null when unknown. */
  migrations: z.object({ applied: z.string().nullable(), latest: z.string().nullable() }),
  /** The most recent backup run, or null when none was recorded (or the record is unreadable). */
  backup: z.object({
    lastRunAt: IsoTime,
    lastTarget: z.enum(['local', 's3']),
    lastStatus: z.enum(['running', 'succeeded', 'failed']),
  }).nullable(),
});
export type HealthVersion = z.infer<typeof HealthVersion>;
// #14 auth and tokens (ADR-0009) ----------------------------------------------------------------------

/**
 * Better Auth's session cookie on the API (local-signin; cookie prefix `poii`). With Secure cookies (a
 * non-loopback WEB_BASE_URL) the name carries the `__Secure-` prefix. The web app keeps the value in its own
 * cookie and forwards it under this name.
 */
export const AUTH_SESSION_COOKIE = 'poii.session_token';
export const AUTH_SESSION_COOKIE_SECURE = '__Secure-poii.session_token';
/** Header every cookie-authenticated mutation of a POII endpoint (outside /v1/auth) must carry: `x-poii-csrf: 1`. */
export const CSRF_HEADER = 'x-poii-csrf';

/** `POST /v1/auth/sign-in/username` (Better Auth username plugin). */
export const SignInRequest = z.object({
  username: z.string().trim().min(3).max(30),
  password: z.string().min(1).max(128),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Better Auth's sign-in reply; the session itself travels in the Set-Cookie header. */
export const SignInResponse = z.object({
  redirect: z.boolean(),
  token: z.string(),
  user: z.object({ id: z.string(), username: z.string().nullish(), actorId: Id.nullish() }).passthrough(),
});
export type SignInResponse = z.infer<typeof SignInResponse>;

/** `POST /v1/auth/change-password`; POII always revokes the other sessions. */
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
  revokeOtherSessions: z.literal(true),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** Better Auth's error body on /v1/auth/* (POII endpoints use `{ error, message, requestId }`). */
export const AuthErrorBody = z.object({ code: z.string().optional(), message: z.string() });
export type AuthErrorBody = z.infer<typeof AuthErrorBody>;

export const tokenScopes = ['read', 'propose'] as const;
export const TokenScope = z.enum(tokenScopes);
export type TokenScope = z.infer<typeof TokenScope>;

export const CreateTokenRequest = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(TokenScope).min(1).max(2),
  expiresAt: IsoTime,
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

export const TokenView = z.object({
  id: Id,
  name: z.string(),
  scopes: z.array(TokenScope),
  /** First characters of the secret, for recognising a token; never enough to use it. */
  secretPrefix: z.string(),
  /** The agent_token actor everything this token proposes is attributed to. */
  actorId: Id,
  ownerActorId: Id,
  createdAt: IsoTime,
  expiresAt: IsoTime,
  lastUsedAt: IsoTime.nullable(),
  revokedAt: IsoTime.nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export type TokenView = z.infer<typeof TokenView>;

/** The only response that ever contains the secret. */
export const CreatedTokenResponse = z.object({ token: TokenView, secret: z.string() });
export type CreatedTokenResponse = z.infer<typeof CreatedTokenResponse>;
// #19 agent instructions export ----------------------------------------------------------------------
// A rebuildable projection of the current-decisions view into AGENTS.md and CLAUDE.md (docs/agent-instructions-export.md).
// Stored as an export_run whose manifest carries `format: "poii.agent-instructions"`.

export const AGENT_INSTRUCTIONS_FORMAT = 'poii.agent-instructions';
export const AGENT_INSTRUCTIONS_VERSION = 1;
export const agentInstructionFileNames = ['AGENTS.md', 'CLAUDE.md'] as const;
export const AgentInstructionFileName = z.enum(agentInstructionFileNames);
export type AgentInstructionFileName = z.infer<typeof AgentInstructionFileName>;

/** `POST /v1/exports/agent-instructions` takes no options: the selection is always the current-decisions view. */
export const AgentInstructionsRequest = z.object({}).strict();
export type AgentInstructionsRequest = z.infer<typeof AgentInstructionsRequest>;

export const AgentInstructionsFile = z.object({
  name: AgentInstructionFileName,
  /** UTF-8 byte length of the whole file (header and body). */
  bytes: z.number().int().positive(),
  /** SHA-256 of the whole file; differs per run because the header carries the run id and time. */
  sha256: z.string(),
});
export type AgentInstructionsFile = z.infer<typeof AgentInstructionsFile>;

export const AgentInstructionsIncluded = z.object({
  recordId: Id,
  kind: RecordKind,
  title: z.string(),
  /** Number of evidence spans cited for this record. */
  citations: z.number().int().nonnegative(),
});
export const AgentInstructionsWithheld = z.object({
  recordId: Id,
  kind: RecordKind,
  title: z.string(),
  reason: z.literal('never_send_to_ai'),
});

export const AgentInstructionsResponse = z.object({
  format: z.literal(AGENT_INSTRUCTIONS_FORMAT),
  formatVersion: z.literal(AGENT_INSTRUCTIONS_VERSION),
  exportRunId: Id,
  generatedAt: IsoTime,
  workspace: z.object({ id: Id, name: z.string() }),
  /** SHA-256 of the canonical body (everything after the `<!-- poii:body -->` line); equal for equal decisions. */
  contentSha256: z.string(),
  files: z.array(AgentInstructionsFile),
  included: z.array(AgentInstructionsIncluded),
  withheld: z.array(AgentInstructionsWithheld),
});
export type AgentInstructionsResponse = z.infer<typeof AgentInstructionsResponse>;
// end #19 agent instructions export ------------------------------------------------------------------
