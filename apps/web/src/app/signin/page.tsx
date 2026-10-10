import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { first, type SearchParams } from '@/lib/notices';
import { safeNextPath } from '@/lib/session';
import { signInAction } from './actions';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const signedOut = first(params.signedOut);
  const next = safeNextPath(first(params.next));
  return (
    <section>
      <h1>Sign in</h1>
      {signedOut ? (
        <p className="notice ok" role="status" data-testid="notice">
          {signedOut === 'all' ? 'Signed out on every device.' : 'Signed out.'}
        </p>
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
      <p className="hint">
        First start: the API creates the owner from POII_OWNER_LOGIN and POII_OWNER_BOOTSTRAP_PASSWORD while no sign-in user exists. Remove the password setting afterwards.
      </p>
    </section>
  );
}
