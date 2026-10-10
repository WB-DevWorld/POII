import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { first, type SearchParams } from '@/lib/notices';
import { safeNextPath } from '@/lib/session';
import { accessLobbySignInAction, signInAction } from './actions';
import { accessLobbyMessage } from './accesslobby/flow';
import { accessLobbyStatus } from './accesslobby/start';

const SIGNED_OUT: Record<string, string> = {
  all: 'Signed out on every device.',
  accesslobby: 'Signed out of POII and of AccessLobby in this browser.',
  'accesslobby-unreachable': 'Signed out of POII. AccessLobby could not be reached, so its session in this browser may still be active: sign out there separately.',
};

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const signedOut = first(params.signedOut);
  const next = safeNextPath(first(params.next));
  // #17: AccessLobby is offered only when the API has it configured.
  const accessLobby = await accessLobbyStatus();
  const accessLobbyCode = first(params.accesslobby);
  return (
    <section>
      <h1>Sign in</h1>
      {signedOut ? (
        <p className="notice ok" role="status" data-testid="notice">
          {SIGNED_OUT[signedOut] ?? 'Signed out.'}
        </p>
      ) : null}
      {accessLobbyCode ? (
        <div className="notice danger" role="alert" data-testid="accesslobby-problem" data-code={accessLobbyCode}>
          <strong>AccessLobby sign-in did not work.</strong> {accessLobbyMessage(accessLobbyCode) ?? 'Start again.'}
          <div className="hint mono">{accessLobbyCode}</div>
        </div>
      ) : null}
      <p className="lede">This POII install uses local sign-in. Sessions end when you sign out or when they expire.</p>
      <ActionForm action={signInAction} className="card stack" aria-label="Sign in" testId="signin-form">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="signin-login">Login</label>
        <input id="signin-login" name="login" autoComplete="username" required maxLength={30} defaultValue="owner" />
        <label htmlFor="signin-password">Password</label>
        <input id="signin-password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
        <div className="row actions">
          <SubmitButton>Sign in</SubmitButton>
        </div>
      </ActionForm>
      {accessLobby?.enabled ? (
        <ActionForm action={accessLobbySignInAction} className="card stack" aria-label="Sign in with AccessLobby" testId="accesslobby-signin-form">
          <input type="hidden" name="next" value={next} />
          <p className="hint">
            Works once your AccessLobby account is connected to this POII (Account page, after a password sign-in). If AccessLobby cannot be reached, this button says so; password sign-in above is unaffected.
          </p>
          <div className="row actions">
            <SubmitButton className="secondary">Sign in with AccessLobby</SubmitButton>
          </div>
        </ActionForm>
      ) : null}
      <p className="hint">
        First start: the API creates the owner from POII_OWNER_LOGIN and POII_OWNER_BOOTSTRAP_PASSWORD while no sign-in user exists. Remove the password setting afterwards.
      </p>
    </section>
  );
}
