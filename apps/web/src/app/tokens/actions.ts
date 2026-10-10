'use server';

// Owner tokens (ADR-0009): create (the secret is returned to this one response only), revoke.
import { revalidatePath } from 'next/cache';
import type { CreatedTokenResponse, TokenScope } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { apiJson, toProblem, type Problem } from '@/lib/api';

export type TokenCreateState =
  | { ok: true; secret: string; name: string; expiresAt: string; scopes: TokenScope[] }
  | { ok: false; problem: Problem }
  | null;

const LIFETIMES_DAYS = new Set([7, 30, 90, 365]);

export async function createTokenAction(_state: TokenCreateState, fd: FormData): Promise<TokenCreateState> {
  const name = String(fd.get('name') ?? '').trim();
  const scope = String(fd.get('scope') ?? '');
  const days = Number(fd.get('days') ?? 30);
  if (!name) return { ok: false, problem: { code: 'invalid_input', message: 'Give the token a name, for example the agent or tool that will use it.' } };
  if (scope !== 'read' && scope !== 'propose') return { ok: false, problem: { code: 'invalid_input', message: 'Choose what the token may do.' } };
  if (!LIFETIMES_DAYS.has(days)) return { ok: false, problem: { code: 'invalid_input', message: 'Choose a lifetime.' } };
  const scopes: TokenScope[] = scope === 'propose' ? ['read', 'propose'] : ['read'];
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  try {
    const created = await apiJson<CreatedTokenResponse>('/v1/tokens', { method: 'POST', body: { name, scopes, expiresAt } });
    revalidatePath('/tokens');
    return { ok: true, secret: created.secret, name: created.token.name, expiresAt: created.token.expiresAt, scopes: created.token.scopes };
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
}

export async function revokeTokenAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = String(fd.get('tokenId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, problem: { code: 'invalid_input', message: 'Unknown token.' } };
  try {
    await apiJson(`/v1/tokens/${id}`, { method: 'DELETE' });
  } catch (error) {
    return { ok: false, problem: toProblem(error) };
  }
  revalidatePath('/tokens');
  return { ok: true, message: 'Revoked. The token stopped working immediately.' };
}
