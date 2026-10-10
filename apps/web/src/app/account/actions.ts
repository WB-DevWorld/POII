'use server';

// Account actions (ADR-0012): connect and disconnect AccessLobby, and the two sign-out choices' "all connected
// apps" half ("this app only" is signOutAction in ../signin/actions). Every call goes through the API with the
// browser's session; nothing here decides anything on its own.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ActionState } from '@/lib/action-state';
import { apiRaw } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
import { accessLobbyMessage, errorCode } from '../signin/accesslobby/flow';
import { startFlow } from '../signin/accesslobby/start';

const problem = (code: string, fallback: string): ActionState => ({ ok: false, problem: { code, message: accessLobbyMessage(code) ?? fallback } });

/** "Connect AccessLobby": the signed-in owner proves the AccessLobby account in a fresh AccessLobby login. */
export async function connectAccessLobbyAction(_state: ActionState, _fd: FormData): Promise<ActionState> {
  const started = await startFlow('link');
  if ('code' in started) return problem(started.code, 'Connecting AccessLobby could not start.');
  redirect(started.url);
}

/** "Disconnect": deliberate, with the local password, so the owner always keeps a way in. */
export async function disconnectAccessLobbyAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const password = fd.get('password');
  if (typeof password !== 'string' || !password) return problem('invalid_input', 'Enter your POII password to disconnect.');
  let response: Response;
  try {
    response = await apiRaw('/v1/auth/accesslobby/unlink', { method: 'POST', body: { password } });
  } catch {
    return problem('api_unreachable', 'The POII API is not reachable right now.');
  }
  if (!response.ok) return problem(await errorCode(response), 'Disconnecting did not work.');
  redirect('/account?accesslobby=disconnected');
}

/** "Sign out of all connected apps": POII ends every session first, then sends the browser to AccessLobby's logout. */
export async function signOutAllAppsAction(_state: ActionState, _fd: FormData): Promise<ActionState> {
  let response: Response;
  try {
    response = await apiRaw('/v1/auth/accesslobby/sign-out-all', { method: 'POST', body: {} });
  } catch {
    return problem('api_unreachable', 'The POII API is not reachable right now.');
  }
  if (!response.ok) return problem(await errorCode(response), 'Signing out did not work.');
  const body = (await response.json().catch(() => null)) as { endSessionUrl?: unknown } | null;
  (await cookies()).delete(SESSION_COOKIE);
  const target = typeof body?.endSessionUrl === 'string' && /^https?:\/\//.test(body.endSessionUrl) ? body.endSessionUrl : null;
  redirect(target ?? '/signin?signedOut=accesslobby-unreachable');
}
