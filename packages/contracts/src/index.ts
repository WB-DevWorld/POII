// Shared vocabulary between the API, the web app and external clients.
// Enumerations here mirror BUILD-BASELINE.md §5 and ADR-0005. Changing meaning is a gated change.
import { z } from 'zod';

export const CONTRACT_VERSION = 'poii.v0';

export const recordKinds = ['fact', 'requirement', 'decision', 'question'] as const;
export const reviewStates = ['candidate', 'confirmed', 'rejected'] as const;
export const lifecycleStatuses = ['proposed', 'decided', 'implemented', 'observed', 'unknown'] as const;
export const statedRoles = ['owner', 'assistant', 'third_party', 'unknown'] as const;
export const statementModes = ['quoted', 'pasted', 'paraphrased', 'ai_extracted'] as const;
export const timeStatuses = ['known', 'unknown', 'not_applicable', 'conflicting'] as const;
export const actorKinds = ['person', 'ai_assistant', 'agent_token', 'system'] as const;
export const authorities = ['owner', 'delegated'] as const;
export const evidenceRoles = ['primary', 'supporting'] as const;
export const anchorResults = ['exact', 'moved', 'lost'] as const;

export const RecordKind = z.enum(recordKinds);
export const ReviewState = z.enum(reviewStates);
export const LifecycleStatus = z.enum(lifecycleStatuses);
export const StatedRole = z.enum(statedRoles);
export const StatementMode = z.enum(statementModes);
export const TimeStatus = z.enum(timeStatuses);
export const ActorKind = z.enum(actorKinds);
export const Authority = z.enum(authorities);
export const EvidenceRole = z.enum(evidenceRoles);
export const AnchorResult = z.enum(anchorResults);

export type RecordKind = z.infer<typeof RecordKind>;
export type ReviewState = z.infer<typeof ReviewState>;
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;
export type StatedRole = z.infer<typeof StatedRole>;
export type StatementMode = z.infer<typeof StatementMode>;
export type TimeStatus = z.infer<typeof TimeStatus>;
export type ActorKind = z.infer<typeof ActorKind>;
export type Authority = z.infer<typeof Authority>;
export type EvidenceRole = z.infer<typeof EvidenceRole>;
export type AnchorResult = z.infer<typeof AnchorResult>;

/** A span inside one immutable source revision. Offsets are UTF-16 code units of the stored text. */
export const Locator = z.object({
  revisionId: z.uuid(),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1).max(4000),
  excerptSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Locator = z.infer<typeof Locator>;

export const HealthReady = z.object({
  status: z.enum(['ready', 'unavailable']),
  version: z.string(),
  aiEnabled: z.boolean().optional(),
});
export type HealthReady = z.infer<typeof HealthReady>;
