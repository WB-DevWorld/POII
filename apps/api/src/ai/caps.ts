// #13 AI hard caps (ADR-0007, BUILD-BASELINE §8 item 9). Per provider per calendar month (UTC), in USD,
// enforced inside POII on top of provider-side limits. The ledger is `ai_usage`:
//   - before a call, the preview's upper estimate is reserved (state `reserved`), under a per-provider lock;
//   - after it, the row is settled with the cost computed from the provider's reported usage.
// A call is refused (409 cap_reached, nothing sent) when spent + reserved + this estimate would exceed the cap.
// A reservation that is never settled (process killed mid-call) keeps counting: the cap errs on the safe side.
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors.js';
import { aiUsage } from '../db/schema/index.js';
import type { Exec } from '../db/types.js';
import type { AiProviderName, AiUsageRow } from '../ports/ai-execution.js';
import { microToUsd } from './pricing.js';

export const currentMonth = (now: Date): string => now.toISOString().slice(0, 7);

export interface MonthTotals {
  spentMicro: number;
  reservedMicro: number;
  calls: number;
}

export async function monthTotals(exec: Exec, provider: AiProviderName, month: string): Promise<MonthTotals> {
  const row = (await exec.select({
    spent: sql<string>`coalesce(sum(${aiUsage.actualMicroUsd}) filter (where ${aiUsage.state} = 'settled'), 0)`,
    reserved: sql<string>`coalesce(sum(${aiUsage.reservedMicroUsd}) filter (where ${aiUsage.state} = 'reserved'), 0)`,
    calls: sql<string>`count(*)`,
  }).from(aiUsage).where(and(eq(aiUsage.provider, provider), eq(aiUsage.month, month))))[0];
  return { spentMicro: Number(row?.spent ?? 0), reservedMicro: Number(row?.reserved ?? 0), calls: Number(row?.calls ?? 0) };
}

export function usageRow(provider: AiProviderName, capMicro: number, totals: MonthTotals): AiUsageRow {
  return {
    provider,
    capUsd: microToUsd(capMicro),
    spentUsd: microToUsd(totals.spentMicro),
    reservedUsd: microToUsd(totals.reservedMicro),
    remainingUsd: microToUsd(Math.max(0, capMicro - totals.spentMicro - totals.reservedMicro)),
    calls: totals.calls,
  };
}

/** Serializes reservations per provider across every API instance sharing the database. */
export async function lockProvider(tx: Exec, provider: AiProviderName): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`poii.ai.cap:${provider}`}))`);
}

export interface Reservation {
  id: string;
  workspaceId: string;
  actorId: string;
  provider: AiProviderName;
  model: string;
  month: string;
  previewId: string;
  promptSha256: string;
  estimateMicro: number;
  capMicro: number;
}

/** Reserves the estimate or throws 409 cap_reached. Call inside a transaction after lockProvider. */
export async function reserve(tx: Exec, r: Reservation): Promise<void> {
  const totals = await monthTotals(tx, r.provider, r.month);
  const committed = totals.spentMicro + totals.reservedMicro;
  if (committed >= r.capMicro || committed + r.estimateMicro > r.capMicro) {
    throw new AppError(409, 'cap_reached', `The ${r.provider} cap for ${r.month} is reached (or this action would exceed it); nothing was sent. The manual path keeps working.`, {
      ...usageRow(r.provider, r.capMicro, totals),
      month: r.month,
      estimatedCostUsd: microToUsd(r.estimateMicro),
    });
  }
  await tx.insert(aiUsage).values({
    id: r.id, workspaceId: r.workspaceId, actorId: r.actorId, provider: r.provider, model: r.model, month: r.month,
    previewId: r.previewId, promptSha256: r.promptSha256, state: 'reserved', reservedMicroUsd: r.estimateMicro,
  });
}

export async function settle(
  exec: Exec,
  id: string,
  outcome: { actualMicro: number; inputTokens: number | null; outputTokens: number | null; outcome: string },
): Promise<void> {
  await exec.update(aiUsage).set({
    state: 'settled',
    actualMicroUsd: outcome.actualMicro,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    outcome: outcome.outcome,
    settledAt: new Date(),
  }).where(eq(aiUsage.id, id));
}
