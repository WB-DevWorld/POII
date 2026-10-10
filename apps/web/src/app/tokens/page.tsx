import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { TokenView } from '@poii/contracts';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
import { signOutEverywhereAction } from '../signin/actions';
import { revokeTokenAction } from './actions';
import { CreateTokenForm } from './CreateTokenForm';

export const metadata: Metadata = { title: 'Tokens' };
export const dynamic = 'force-dynamic';

const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

export default async function TokensPage() {
  const [tokens, store] = await Promise.all([apiTry<TokenView[]>('/v1/tokens'), cookies()]);
  const signedIn = store.has(SESSION_COOKIE);
  return (
    <section>
      <h1>Tokens</h1>
      <p className="lede">
        Owner tokens let an agent or tool read POII and, if allowed, propose sources and candidate records. Everything a token
        proposes stays a candidate until you confirm it. Revoking a token takes effect on its next request.
      </p>
      <div className="grid-2">
        <CreateTokenForm />
        <div className="card">
          <h2>Your tokens</h2>
          {!tokens.ok ? (
            <ProblemNotice problem={tokens.problem} />
          ) : tokens.data.length === 0 ? (
            <p className="hint">No tokens yet.</p>
          ) : (
            <table data-testid="token-list">
              <thead>
                <tr><th>Name</th><th>May</th><th>Status</th><th>Expires</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {tokens.data.map(token => (
                  <tr key={token.id} data-token-id={token.id}>
                    <td>
                      {token.name}
                      <div className="hint mono">{token.secretPrefix}…</div>
                    </td>
                    <td>{token.scopes.includes('propose') ? 'read + propose' : 'read'}</td>
                    <td>
                      <span className={`tag ${token.status === 'active' ? 'ok' : token.status === 'revoked' ? 'danger' : 'warn'}`}>{token.status}</span>
                    </td>
                    <td className="nowrap">{when(token.expiresAt)}</td>
                    <td className="nowrap">{when(token.lastUsedAt)}</td>
                    <td>
                      {token.status === 'active' ? (
                        <ActionForm action={revokeTokenAction} aria-label={`Revoke ${token.name}`}>
                          <input type="hidden" name="tokenId" value={token.id} />
                          <SubmitButton className="danger">Revoke</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {signedIn ? (
        <div className="card danger-zone">
          <h2>Sessions</h2>
          <p className="hint">Signs you out in every browser and device at once. Tokens are not affected; revoke them above.</p>
          <ActionForm action={signOutEverywhereAction} aria-label="Sign out everywhere">
            <SubmitButton className="danger">Sign out everywhere</SubmitButton>
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}
