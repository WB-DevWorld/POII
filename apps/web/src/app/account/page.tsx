import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { first, type SearchParams } from '@/lib/notices';
import { SESSION_COOKIE } from '@/lib/session';
import { signOutAction, signOutEverywhereAction } from '../signin/actions';
import { accessLobbyMessage } from '../signin/accesslobby/flow';
import { accessLobbyStatus } from '../signin/accesslobby/start';
import { connectAccessLobbyAction, disconnectAccessLobbyAction, signOutAllAppsAction } from './actions';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

const DONE: Record<string, string> = {
  connected: 'AccessLobby is connected. You can now also sign in with AccessLobby.',
  disconnected: 'AccessLobby is disconnected. Sign in with your password from now on.',
};

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, store, status] = await Promise.all([searchParams, cookies(), accessLobbyStatus()]);
  const signedIn = store.has(SESSION_COOKIE);
  const code = first(params.accesslobby);
  const done = code ? DONE[code] : undefined;
  return (
    <section>
      <h1>Account</h1>
      {done ? <p className="notice ok" role="status" data-testid="notice">{done}</p> : null}
      {code && !done ? (
        <div className="notice danger" role="alert" data-testid="accesslobby-problem" data-code={code}>
          <strong>That did not work.</strong> {accessLobbyMessage(code) ?? 'Try again.'}
          <div className="hint mono">{code}</div>
        </div>
      ) : null}
      {!signedIn ? (
        <p className="lede">This install signs every request in as the owner (local-owner); there is no sign-in to manage.</p>
      ) : (
        <>
          <p className="lede">
            You signed in {status?.sessionVia === 'accesslobby' ? 'with AccessLobby' : 'with your POII password'}. Your password always works,
            whether or not AccessLobby is connected.
          </p>
          {status?.enabled ? (
            <div className="card stack" data-testid="accesslobby-card">
              <h2>AccessLobby</h2>
              {status.link ? (
                <>
                  <p>
                    Connected to AccessLobby person <span className="mono">{status.link.personId}</span> since {when(status.link.linkedAt)};
                    last AccessLobby sign-in {when(status.link.lastSignInAt)}.
                  </p>
                  <ActionForm action={disconnectAccessLobbyAction} className="stack" aria-label="Disconnect AccessLobby" testId="accesslobby-disconnect">
                    <label htmlFor="disconnect-password">Your POII password</label>
                    <input id="disconnect-password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
                    <div className="row actions">
                      <SubmitButton className="danger">Disconnect</SubmitButton>
                    </div>
                    <p className="hint">Ends any POII session that came from AccessLobby. Your password sign-in stays as it is.</p>
                  </ActionForm>
                </>
              ) : (
                <ActionForm action={connectAccessLobbyAction} className="stack" aria-label="Connect AccessLobby" testId="accesslobby-connect">
                  <p>
                    Connect your AccessLobby account to sign in to POII with it. AccessLobby asks you to sign in there; POII then links that
                    account to you. Accounts are never matched by email.
                  </p>
                  <div className="row actions">
                    <SubmitButton>Connect AccessLobby</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </div>
          ) : null}
          <div className="card stack" data-testid="signout-choices">
            <h2>Sign out</h2>
            <div className="row actions">
              <form action={signOutAction} style={{ margin: 0 }}>
                <button type="submit" className="secondary" data-testid="signout-this-app">This app only</button>
              </form>
              {status?.enabled ? (
                <ActionForm action={signOutAllAppsAction} aria-label="Sign out of all connected apps">
                  <SubmitButton className="secondary">All connected apps</SubmitButton>
                </ActionForm>
              ) : null}
              <ActionForm action={signOutEverywhereAction} aria-label="Sign out on every device">
                <SubmitButton className="danger">Every device</SubmitButton>
              </ActionForm>
            </div>
            <p className="hint">
              This app only: ends this POII session; AccessLobby stays signed in.
              {status?.enabled ? ' All connected apps: ends all your POII sessions (every device) and signs you out of AccessLobby in this browser, which tells the other connected apps.' : ''}
              {' '}Every device: ends all your POII sessions.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
