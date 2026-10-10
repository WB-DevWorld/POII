// #13 AI: per-action preview page (BUILD-BASELINE §4.2). Shows exactly the text that would be sent, the
// provider, the model, the estimated cost and what is left of the monthly cap. Nothing is sent until "Send".
import type { Metadata } from 'next';
import type { AiPreviewResponse, AiStatusResponse, AiUsageResponse, MeResponse, SourceDetail } from '@poii/contracts';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { ProblemNotice } from '@/components/ProblemNotice';
import { apiTry } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { first, type SearchParams } from '@/lib/notices';
import { previewAiAction } from './actions';
import { AiSendForm } from './AiSendForm';
import { aiAvailability, aiPageHref, explainAiCode, formatUsd, manualPathHref, wouldExceedCap } from './logic';

export const metadata: Metadata = { title: 'AI-assisted extraction' };

type Params = Promise<{ id: string }>;

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

export default async function AiPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const [detail, me] = await Promise.all([
    apiTry<SourceDetail>(`/v1/sources/${encodeURIComponent(id)}`),
    apiTry<MeResponse>('/v1/me'),
  ]);
  const back = `/sources/${encodeURIComponent(id)}`;

  if (!detail.ok) {
    return (
      <section>
        <h1>AI-assisted extraction</h1>
        <ProblemNotice problem={detail.problem} title="The source could not be loaded." />
        <p>
          <a href="/sources">Back to sources</a>
        </p>
      </section>
    );
  }
  const source = detail.data;
  const availability = aiAvailability(source.aiAllowed, me.ok && me.data.aiEnabled);
  const startParam = first(sp.start);
  const endParam = first(sp.end);
  const previewId = first(sp.preview);

  const header = (
    <>
      <p className="crumbs">
        <a href="/sources">Sources</a> / <a href={back}>{source.title}</a>
      </p>
      <h1>AI-assisted extraction</h1>
      <p className="lede">
        An AI provider proposes candidate facts, requirements, decisions and questions from this source. Nothing is sent until you
        press Send, and only the text shown in the preview is sent. Everything the provider returns stays a candidate until a person
        confirms it.
      </p>
    </>
  );

  if (availability === 'never_send') {
    return (
      <section>
        {header}
        <div className="notice warn" role="status" data-testid="ai-unavailable" data-reason="never_send">
          <strong>AI is unavailable for this source.</strong> It is marked <em>never send to AI</em>, so nothing from it, and nothing
          derived from it, is ever sent to an AI provider. POII refuses it on the server whatever any page offers.
          <div className="hint">
            Only the owner can change this, on the source page (&ldquo;Allow sending to AI&rdquo;). The manual path is unaffected.
          </div>
        </div>
        <p>
          <a href={back}>Back to the source</a> to create candidates by hand.
        </p>
      </section>
    );
  }

  if (availability === 'off') {
    return (
      <section>
        {header}
        <div className="notice" role="status" data-testid="ai-unavailable" data-reason="off">
          <strong>AI is off on this POII instance.</strong> It needs <span className="mono">POII_AI_ENABLED=true</span> and an
          Anthropic or OpenAI key configured by the owner. The manual path works without it.
        </div>
        {!me.ok ? <ProblemNotice problem={me.problem} title="Whether AI is on could not be checked." /> : null}
        <p>
          <a href={manualPathHref(source.id, numberOrUndefined(startParam), numberOrUndefined(endParam))}>Back to the source</a> to
          create candidates by hand.
        </p>
      </section>
    );
  }

  const [status, usage, preview] = await Promise.all([
    apiTry<AiStatusResponse>('/v1/ai/status'),
    apiTry<AiUsageResponse>('/v1/ai/usage'),
    previewId ? apiTry<AiPreviewResponse>(`/v1/ai/previews/${encodeURIComponent(previewId)}`) : Promise.resolve(null),
  ]);
  const providers = status.ok ? status.data.providers.filter(p => p.configured) : [];
  const shownStart = preview?.ok ? String(preview.data.startChar) : startParam ?? '';
  const shownEnd = preview?.ok ? String(preview.data.endChar) : endParam ?? '';
  const textLength = source.currentRevision.contentText.length;

  return (
    <section>
      {header}

      <h2>Monthly caps ({usage.ok ? usage.data.month : 'unknown'})</h2>
      {usage.ok ? (
        <div className="table-wrap">
          <table data-testid="ai-usage">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Spent</th>
                <th>Reserved</th>
                <th>Remaining of cap</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.providers.map(u => {
                const p = status.ok ? status.data.providers.find(s => s.provider === u.provider) : undefined;
                return (
                  <tr key={u.provider} data-provider={u.provider}>
                    <td>{PROVIDER_LABEL[u.provider] ?? u.provider}{p && !p.configured ? <span className="hint"> (not configured)</span> : null}</td>
                    <td className="mono">{p?.model ?? '—'}</td>
                    <td>{formatUsd(u.spentUsd)}</td>
                    <td>{formatUsd(u.reservedUsd)}</td>
                    <td>
                      {formatUsd(u.remainingUsd)} of {formatUsd(u.capUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <ProblemNotice problem={usage.problem} title="Usage could not be loaded." />
      )}

      <h2>1. Prepare a preview</h2>
      <ActionForm action={previewAiAction} aria-label="Prepare AI preview" className="card stack">
        <input type="hidden" name="sourceId" value={source.id} />
        <label htmlFor="ai-provider">Provider</label>
        <select id="ai-provider" name="provider" defaultValue={preview?.ok ? preview.data.provider : status.ok ? status.data.defaultProvider ?? '' : ''}>
          {providers.map(p => (
            <option key={p.provider} value={p.provider}>
              {PROVIDER_LABEL[p.provider] ?? p.provider} · {p.model}
            </option>
          ))}
        </select>
        <div className="inline-fields">
          <div>
            <label htmlFor="ai-start">Span start (optional)</label>
            <input id="ai-start" name="startChar" inputMode="numeric" defaultValue={shownStart} />
          </div>
          <div>
            <label htmlFor="ai-end">Span end (optional)</label>
            <input id="ai-end" name="endChar" inputMode="numeric" defaultValue={shownEnd} />
          </div>
        </div>
        <p className="hint">
          Leave both empty to use the whole current revision ({textLength} characters
          {status.ok ? `; at most ${status.data.maxInputChars} per action` : ''}). Offsets come from a selection on the source page.
        </p>
        <SubmitButton>Prepare preview</SubmitButton>
      </ActionForm>

      {preview && !preview.ok ? (
        <>
          <ProblemNotice problem={preview.problem} title="That preview cannot be shown." />
          {explainAiCode(preview.problem.code) ? <p className="hint">{explainAiCode(preview.problem.code)}</p> : null}
        </>
      ) : null}

      {preview?.ok ? (
        <section data-testid="ai-preview">
          <h2>2. Exactly what will be sent</h2>
          <dl className="meta">
            <div>
              <dt>Provider and model</dt>
              <dd>
                {PROVIDER_LABEL[preview.data.provider] ?? preview.data.provider} · <span className="mono">{preview.data.model}</span>
              </dd>
            </div>
            <div>
              <dt>Span</dt>
              <dd>
                characters {preview.data.startChar}–{preview.data.endChar}
              </dd>
            </div>
            <div>
              <dt>Estimated cost (upper bound)</dt>
              <dd data-testid="ai-estimate">
                {formatUsd(preview.data.estimatedCostUsd)} · about {preview.data.inputTokensEstimate} input tokens, at most{' '}
                {preview.data.maxOutputTokens} output tokens
              </dd>
            </div>
            <div>
              <dt>Remaining cap</dt>
              <dd data-testid="ai-remaining">
                {formatUsd(preview.data.remainingCapUsd)} of {formatUsd(preview.data.monthlyCapUsd)}
              </dd>
            </div>
            <div>
              <dt>Preview expires</dt>
              <dd>{formatTime(preview.data.expiresAt)}</dd>
            </div>
          </dl>
          <p className="hint mono break">
            {preview.data.promptText.length} characters · sha256 {preview.data.promptSha256}
          </p>
          <pre className="source" data-testid="ai-prompt">
            {preview.data.promptText}
          </pre>
          <AiSendForm
            previewId={preview.data.previewId}
            sourceId={source.id}
            providerLabel={PROVIDER_LABEL[preview.data.provider] ?? preview.data.provider}
            startChar={preview.data.startChar}
            endChar={preview.data.endChar}
            blockedByCap={wouldExceedCap(preview.data.estimatedCostUsd, preview.data.remainingCapUsd)}
          />
        </section>
      ) : null}

      <p className="hint">
        Prefer to do it yourself? <a href={manualPathHref(source.id, numberOrUndefined(shownStart), numberOrUndefined(shownEnd))}>Use the manual path</a>.{' '}
        <a href={aiPageHref(source.id)}>Start over</a>.
      </p>
    </section>
  );
}

function numberOrUndefined(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}
