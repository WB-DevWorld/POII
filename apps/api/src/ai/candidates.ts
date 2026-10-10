// #13 AI: validating what a provider returned. Anything malformed becomes zero candidates plus an error,
// never a crash. Offsets are checked against the exact text that was sent; a candidate whose quote does not
// occur in it is dropped. Output is data: no field in it can change review state, authority or anything else.
import { z } from 'zod';
import { candidateKinds, type ExtractedCandidate, type RawCandidate } from '../ports/ai-execution.js';

export const MAX_CANDIDATES = 50;
const MAX_TITLE = 500;
const MAX_BODY = 20_000;

/** JSON schema sent to both providers (structured outputs). Only features both providers' strict modes accept. */
export const CANDIDATES_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...candidateKinds] },
          title: { type: 'string' },
          body: { type: 'string' },
          quote: { type: 'string' },
          startChar: { type: 'integer' },
          endChar: { type: 'integer' },
        },
        required: ['kind', 'title', 'body', 'quote', 'startChar', 'endChar'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

const RawCandidateSchema = z.object({
  kind: z.enum(candidateKinds),
  title: z.string(),
  body: z.string(),
  quote: z.string(),
  startChar: z.number().int(),
  endChar: z.number().int(),
});

const issueSummary = (error: z.ZodError) =>
  error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

export interface ParsedCandidates {
  candidates: RawCandidate[];
  errors: string[];
  malformed: boolean;
}

/** Parses the model's text answer. Never throws. */
export function parseCandidatesText(text: string | null | undefined): ParsedCandidates {
  if (typeof text !== 'string' || !text.trim()) {
    return { candidates: [], errors: ['The provider returned no text answer; no candidates were created.'], malformed: true };
  }
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    return { candidates: [], errors: ['The provider answer is not valid JSON; no candidates were created.'], malformed: true };
  }
  const top = z.object({ candidates: z.array(z.unknown()) }).safeParse(json);
  if (!top.success) {
    return {
      candidates: [],
      errors: [`The provider answer does not match the candidate schema (${issueSummary(top.error)}); no candidates were created.`],
      malformed: true,
    };
  }
  const errors: string[] = [];
  const candidates: RawCandidate[] = [];
  const items = top.data.candidates;
  items.slice(0, MAX_CANDIDATES).forEach((item, index) => {
    const parsed = RawCandidateSchema.safeParse(item);
    if (!parsed.success) errors.push(`Candidate ${index + 1} was dropped: ${issueSummary(parsed.error)}.`);
    else candidates.push(parsed.data);
  });
  if (items.length > MAX_CANDIDATES) errors.push(`Only the first ${MAX_CANDIDATES} of ${items.length} candidates were considered.`);
  return { candidates, errors, malformed: false };
}

/** Tolerates a Markdown code fence around the JSON (some models add one despite instructions). */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

/**
 * Verifies each candidate's span against the document that was sent and converts it to source offsets.
 * The quote is the ground truth: when the offsets do not hold the quote, the occurrence nearest to the
 * claimed offset is used; when the quote does not occur at all, the candidate is dropped.
 */
export function anchorCandidates(
  documentText: string,
  documentStartInSource: number,
  raw: RawCandidate[],
): { candidates: ExtractedCandidate[]; errors: string[] } {
  const out: ExtractedCandidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((c, index) => {
    const label = `Candidate ${index + 1}`;
    const title = c.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!title) {
      errors.push(`${label} was dropped: it has no title.`);
      return;
    }
    const span = locate(documentText, c);
    if (!span) {
      errors.push(`${label} was dropped: its quote does not occur in the sent text.`);
      return;
    }
    const key = `${c.kind}:${span.start}:${span.end}:${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: c.kind,
      title,
      body: c.body.trim().slice(0, MAX_BODY),
      startChar: documentStartInSource + span.start,
      endChar: documentStartInSource + span.end,
    });
  });
  return { candidates: out, errors };
}

function locate(text: string, c: RawCandidate): { start: number; end: number } | null {
  if (c.quote && c.startChar >= 0 && c.endChar > c.startChar && c.endChar <= text.length && text.slice(c.startChar, c.endChar) === c.quote) {
    return { start: c.startChar, end: c.endChar };
  }
  for (const quote of [c.quote, c.quote.trim()]) {
    if (!quote) continue;
    let best = -1;
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      if (best === -1 || Math.abs(at - c.startChar) < Math.abs(best - c.startChar)) best = at;
    }
    if (best !== -1) return { start: best, end: best + quote.length };
  }
  return null;
}
