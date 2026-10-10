// #13 AI: pure helpers for the per-action AI preview page (unit-tested in test/ai.test.ts).
import type { AiProvider } from '@poii/contracts';

export type AiAvailability = 'never_send' | 'off' | 'on';

/** Never-send wins over everything: the page never offers AI for such a source (the API refuses it anyway). */
export function aiAvailability(sourceAiAllowed: boolean, aiEnabled: boolean): AiAvailability {
  if (!sourceAiAllowed) return 'never_send';
  return aiEnabled ? 'on' : 'off';
}

export type PreviewBody = { sourceId: string; provider?: AiProvider; startChar?: number; endChar?: number };

const field = (fd: FormData, name: string): string => {
  const value = fd.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Reads the preview form: provider (optional) and an optional span given as both offsets or neither. */
export function parsePreviewForm(fd: FormData): { ok: true; body: PreviewBody } | { ok: false; message: string } {
  const sourceId = field(fd, 'sourceId');
  if (!sourceId) return { ok: false, message: 'The source is missing.' };
  const body: PreviewBody = { sourceId };
  const provider = field(fd, 'provider');
  if (provider) {
    if (provider !== 'anthropic' && provider !== 'openai') return { ok: false, message: 'Choose a configured provider.' };
    body.provider = provider;
  }
  const start = field(fd, 'startChar');
  const end = field(fd, 'endChar');
  if (start || end) {
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) {
      return { ok: false, message: 'Give both span offsets as whole numbers, or leave both empty to send the whole source.' };
    }
    const s = Number(start);
    const e = Number(end);
    if (e <= s) return { ok: false, message: 'The span end must be after its start.' };
    body.startChar = s;
    body.endChar = e;
  }
  return { ok: true, body };
}

/** USD with enough precision for small AI costs: $0.0156, $1.25, $20.00. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** True when executing this preview would be refused with cap_reached. */
export function wouldExceedCap(estimatedCostUsd: number, remainingCapUsd: number): boolean {
  return remainingCapUsd <= 0 || estimatedCostUsd > remainingCapUsd;
}

/** Plain-language explanations for the AI error codes; null when the API's own message is enough. */
export function explainAiCode(code: string): string | null {
  switch (code) {
    case 'ai_disabled':
      return 'AI is off on this POII instance. Use the manual path: select a span on the source and create a candidate.';
    case 'ai_not_allowed':
      return 'This source, or a record derived from a never-send source, may never be sent to an AI provider. Nothing was sent.';
    case 'cap_reached':
      return "This provider's monthly cap is reached, or this action would exceed it. Nothing was sent. The manual path keeps working.";
    case 'preview_expired':
      return 'This preview has expired. Prepare a new one; nothing was sent.';
    case 'preview_used':
      return 'This preview was already sent once. Prepare a new one to send again.';
    case 'preview_stale':
      return 'Something in the previewed material or the provider settings changed since the preview. Prepare a new one; nothing was sent.';
    case 'span_too_large':
      return 'The selected text is too long for one AI action. Choose a smaller span.';
    case 'provider_unavailable':
      return 'That provider is not configured on this instance.';
    default:
      return null;
  }
}

export const aiPageHref = (sourceId: string, params: Record<string, string | number | undefined> = {}): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return `/sources/${encodeURIComponent(sourceId)}/ai${text ? `?${text}` : ''}`;
};

/** The manual path for the same span: the source page with the span highlighted and the candidate form ready. */
export const manualPathHref = (sourceId: string, startChar?: number, endChar?: number): string =>
  startChar !== undefined && endChar !== undefined
    ? `/sources/${encodeURIComponent(sourceId)}?start=${startChar}&end=${endChar}#span`
    : `/sources/${encodeURIComponent(sourceId)}`;
