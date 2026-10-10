// Primary navigation. A server component: it shows "Sign out" only when the browser carries a session
// cookie (local-signin). With local-owner there is no cookie and nothing changes.
import { cookies } from 'next/headers';
import { signOutAction } from '@/app/signin/actions';
import { SESSION_COOKIE } from '@/lib/session';
import { NavLinks } from './NavLinks';

export async function Nav() {
  const signedIn = (await cookies()).has(SESSION_COOKIE);
  return (
    <nav aria-label="Primary">
      <NavLinks />
      {signedIn ? (
        <form action={signOutAction} style={{ display: 'inline', margin: 0 }}>
          <button type="submit" className="secondary" style={{ padding: '0.1rem 0.6rem' }} data-testid="sign-out">Sign out</button>
        </form>
      ) : null}
    </nav>
  );
}
