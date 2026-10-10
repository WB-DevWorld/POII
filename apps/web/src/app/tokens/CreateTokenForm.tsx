'use client';

import { useActionState } from 'react';
import { ProblemNotice } from '@/components/ProblemNotice';
import { createTokenAction } from './actions';

/** Creates a token and shows its secret exactly once; the secret is never stored or shown again. */
export function CreateTokenForm() {
  const [state, action, pending] = useActionState(createTokenAction, null);
  return (
    <div className="card">
      <h2>Create a token</h2>
      {state && !state.ok ? <ProblemNotice problem={state.problem} /> : null}
      {state?.ok ? (
        <div className="notice ok" role="status" data-testid="token-secret">
          <strong>Copy this token now. It will not be shown again.</strong>
          <p className="hint">
            {state.name} · {state.scopes.join(' + ')} · expires {new Date(state.expiresAt).toUTCString()}
          </p>
          <input readOnly aria-label="New token secret" className="mono" value={state.secret} onFocus={e => e.currentTarget.select()} />
          <p className="hint">Use it as <span className="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
        </div>
      ) : null}
      <form action={action} aria-label="Create token" data-testid="token-form" aria-busy={pending}>
        <label htmlFor="token-name">Name</label>
        <input id="token-name" name="name" required maxLength={100} placeholder="e.g. coding agent on my laptop" />
        <fieldset>
          <legend>May</legend>
          <label className="check">
            <input type="radio" name="scope" value="read" defaultChecked /> read sources, records, views, search and context packs
          </label>
          <label className="check">
            <input type="radio" name="scope" value="propose" /> read, and propose sources and candidate records
          </label>
          <p className="hint">A token can never confirm, reject, delete, restore, change &quot;never send to AI&quot; or manage tokens.</p>
        </fieldset>
        <label htmlFor="token-days">Expires after</label>
        <select id="token-days" name="days" defaultValue="30">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">365 days</option>
        </select>
        <div className="row actions">
          <button type="submit" disabled={pending} aria-disabled={pending}>{pending ? 'Working…' : 'Create token'}</button>
        </div>
      </form>
    </div>
  );
}
