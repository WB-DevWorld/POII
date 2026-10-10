'use client';

// #13 AI: the "Send" step. Same pattern as ActionForm (native form bound to a server action, transition
// submit with JavaScript), with its own state so the created candidates can be listed.
import { startTransition, useActionState, type FormEvent } from 'react';
import { ProblemNotice } from '@/components/ProblemNotice';
import { executeAiAction, type AiSendState } from './actions';
import { aiPageHref, explainAiCode, formatUsd, manualPathHref } from './logic';

type Props = {
  previewId: string;
  sourceId: string;
  providerLabel: string;
  startChar: number;
  endChar: number;
  blockedByCap: boolean;
};

const KIND_LABEL: Record<string, string> = { fact: 'Fact', requirement: 'Requirement', decision: 'Decision', question: 'Question' };

export function AiSendForm({ previewId, sourceId, providerLabel, startChar, endChar, blockedByCap }: Props) {
  const [state, formAction, pending] = useActionState<AiSendState, FormData>(executeAiAction, null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };
  const manual = manualPathHref(sourceId, startChar, endChar);

  if (state?.ok) {
    const { result } = state;
    return (
      <section className="card" data-testid="ai-result" data-outcome={result.outcome} aria-live="polite">
        <h2>Result</h2>
        <p>
          {result.records.length === 0
            ? 'No candidates were created.'
            : `${result.records.length} candidate${result.records.length === 1 ? '' : 's'} created. They stay candidates until a person confirms them.`}
        </p>
        {result.records.length ? (
          <ul className="record-list" data-testid="ai-candidates">
            {result.records.map(r => (
              <li key={r.id}>
                <a href={`/records/${r.id}`}>{r.title}</a>{' '}
                <span className="tag">{KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="tag warn">candidate</span>
                <span className="tag">ai_extracted</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result.errors.length ? (
          <div className="notice warn" role="status">
            <strong>{result.outcome === 'ok' ? 'Some proposals were dropped:' : `The provider answer could not be used (${result.outcome}).`}</strong>
            <ul className="compact">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="hint">
          Cost {formatUsd(result.usage.costUsd)}
          {result.usage.reconciled
            ? ` from the provider's reported usage (${result.usage.inputTokens ?? '?'} input, ${result.usage.outputTokens ?? '?'} output tokens).`
            : ` (no usage reported; ${result.usage.costUsd > 0 ? 'the reserved estimate is counted' : 'nothing was billed'}).`}
        </p>
        <p className="row">
          <a href={aiPageHref(sourceId, { start: startChar, end: endChar })}>Prepare another preview</a>
          <a href={`/sources/${encodeURIComponent(sourceId)}`}>Back to the source</a>
        </p>
      </section>
    );
  }

  const problem = state && !state.ok ? state.problem : null;
  return (
    <form action={formAction} onSubmit={onSubmit} aria-label="Send to AI" data-testid="ai-send-form" aria-busy={pending}>
      {problem ? (
        <>
          <ProblemNotice problem={problem} title="Nothing was sent." />
          {explainAiCode(problem.code) ? <p className="hint">{explainAiCode(problem.code)}</p> : null}
          {problem.code === 'cap_reached' || problem.code === 'ai_disabled' ? (
            <p data-testid="ai-manual-path">
              <a href={manual}>Use the manual path for this span</a>: select the text and create the candidate yourself.
            </p>
          ) : null}
          {['preview_expired', 'preview_used', 'preview_stale'].includes(problem.code) ? (
            <p>
              <a href={aiPageHref(sourceId, { start: startChar, end: endChar })}>Prepare a new preview</a>
            </p>
          ) : null}
        </>
      ) : null}
      <input type="hidden" name="previewId" value={previewId} />
      {blockedByCap ? (
        <p className="notice warn" role="status" data-testid="ai-cap-warning">
          This preview&apos;s estimate is more than what is left of the monthly cap, so sending will be refused and nothing will be sent.{' '}
          <a href={manual}>Use the manual path</a> instead.
        </p>
      ) : null}
      <button type="submit" disabled={pending} aria-disabled={pending}>
        {pending ? 'Sending…' : `Send exactly this text to ${providerLabel}`}
      </button>
      <p className="hint">Sent with a fixed output schema, the model name and the output-token limit; no other text.</p>
    </form>
  );
}
