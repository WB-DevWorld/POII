#!/usr/bin/env node
// POII Claude Code hook: opt-in capture of a session's prompts and final answers as a POII source (issue #21).
//
// Exactly what it captures, what it never captures, the opt-in file, the settings.json snippet and how to
// remove it are documented in docs/claude-code-hook.md. In short:
//   - It does nothing unless the project directory has `.poii/capture.json` with `"enabled": true`, the hook
//     event is listed in its `events`, and POII_API_URL and POII_TOKEN are set (environment, or the file's
//     `envFile`).
//   - When enabled it reads the session transcript (JSONL) and keeps only the user's own typed prompts and the
//     assistant's final answer to each of them. Tool calls, tool output, file contents, thinking, attachments,
//     system and subagent messages are dropped. Every line that looks like a key, token, password or private
//     key (plus the project's own `redact` patterns) is withheld and never sent.
//   - It proposes, never decides: it creates or extends one source per session (`POST /v1/sources`, origin key
//     `claude-code:<sessionId>`; a longer transcript later becomes a new revision via
//     `POST /v1/sources/:id/revisions`) and ensures an `ai_assistant` actor "Claude Code (hook)" exists. It
//     never creates records or approvals; a `propose` token cannot confirm anything anyway.
//   - It never blocks Claude Code: every failure is logged to stderr with the prefix `[poii-hook]` and the
//     process exits 0, at the latest after POII_HOOK_TIMEOUT_MS (default 10000 ms, at most 60000 ms).
//
// Node 24, no dependencies. Reads the hook event JSON on stdin. Never prints the token or captured text.
//
// Usage (from .claude/settings.json, see docs/claude-code-hook.md):
//   node /path/to/poii/scripts/poii-hook.mjs

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_VERSION = 1;
export const ASSISTANT_ACTOR_NAME = 'Claude Code (hook)';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;
export const SUPPORTED_EVENTS = ['Stop', 'SessionEnd'];
export const CAPTURE_KINDS = ['prompts', 'answers'];
const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024;
const MAX_CONTENT_CHARS = 5_000_000;

// ----- logging ----------------------------------------------------------------------------------------

function log(message) {
  try { process.stderr.write(`[poii-hook] ${message}\n`); } catch { /* never fail on logging */ }
}

// ----- redaction --------------------------------------------------------------------------------------

/** Built-in patterns for obvious secrets. A line matching any of them is withheld in full. */
export const BUILTIN_REDACTIONS = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'poii-token', re: /\bpoii_[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'bearer-credential', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'url-with-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i },
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  {
    name: 'secret-assignment',
    re: /\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
];

/** Compiles the project's own `redact` patterns. Throws on an invalid pattern (the caller then sends nothing). */
export function compileRedactions(patterns = []) {
  if (!Array.isArray(patterns)) throw new Error('"redact" must be an array of regular-expression strings');
  return patterns.map((p, i) => {
    if (typeof p !== 'string' || p.length === 0 || p.length > 500) throw new Error(`"redact"[${i}] must be a non-empty string`);
    return { name: `project-pattern-${i + 1}`, re: new RegExp(p, 'i') };
  });
}

/**
 * Withholds every line that matches a redaction pattern (and whole private-key blocks). Returns the text with
 * each withheld line replaced by a marker that names the pattern, never the value.
 */
export function redactText(text, patterns) {
  const lines = text.split('\n');
  const out = [];
  const hits = new Set();
  let withheld = 0;
  let inKeyBlock = false;
  for (const line of lines) {
    if (inKeyBlock) {
      withheld++;
      if (/-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/.test(line)) inKeyBlock = false;
      continue;
    }
    const hit = patterns.find(p => p.re.test(line));
    if (!hit) { out.push(line); continue; }
    hits.add(hit.name);
    withheld++;
    if (hit.name === 'private-key' && !/-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/.test(line)) {
      inKeyBlock = true;
      out.push('[withheld by the POII hook: private-key block]');
    } else {
      out.push(`[withheld by the POII hook: line matched ${hit.name}]`);
    }
  }
  return { text: out.join('\n'), withheld, patterns: [...hits] };
}

// ----- transcript extraction --------------------------------------------------------------------------

const NOT_A_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)>/;

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  // A user line that carries a tool result is tool output, never a prompt.
  if (content.some(b => b && b.type === 'tool_result')) return null;
  const texts = content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text);
  return texts.length ? texts.join('\n\n') : null;
}

/** True for a line that is a prompt the user typed (not a tool result, command echo, notification or meta line). */
function isOwnPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return false;
  if (entry.message?.role !== 'user') return false;
  if (entry.origin && typeof entry.origin === 'object' && entry.origin.kind !== 'human') return false;
  if (entry.turnOrigin !== undefined && entry.turnOrigin !== 'human') return false;
  if (entry.promptSource === 'system') return false;
  const text = textOfBlocks(entry.message.content);
  if (text === null || text.trim() === '') return false;
  if (NOT_A_PROMPT.test(text) || /^Caveat: The messages below were generated by the user while running local commands/.test(text)) return false;
  return true;
}

/** True for a user-side line that opens a turn the user did not type. */
function startsOtherTurn(entry) {
  if (entry.type !== 'user' || entry.isSidechain) return false;
  if (typeof entry.turnOrigin === 'string' && entry.turnOrigin !== 'human') return true;
  if (entry.isMeta) return false;
  const text = typeof entry.message?.content === 'string' ? entry.message.content : null;
  return text !== null && NOT_A_PROMPT.test(text);
}

/**
 * Turns transcript JSONL into the captured messages: each prompt the user typed, followed by the assistant's
 * final answer to it (the text of the last assistant message before the next prompt). Nothing else.
 * `lastAssistantMessage` (from the Stop event) replaces the last answer when the transcript has not caught up.
 */
export function extractMessages(jsonl, { lastAssistantMessage = null } = {}) {
  const turns = [];
  let current = null;
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (isOwnPrompt(entry)) {
      current = { prompt: { text: textOfBlocks(entry.message.content), timestamp: entry.timestamp ?? null }, answer: null };
      turns.push(current);
      continue;
    }
    if (startsOtherTurn(entry)) {
      // A turn started by something other than the user (task notification, subagent hand-back, local
      // command): what the assistant says next answers that, not the user's prompt.
      current = null;
      continue;
    }
    if (!current || entry.type !== 'assistant' || entry.isSidechain || entry.message?.role !== 'assistant') continue;
    const id = entry.message.id ?? entry.requestId ?? entry.uuid;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        // The assistant kept working: text before a tool call is not the final answer.
        current.answer = null;
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        current.answer = current.answer?.id === id
          ? { ...current.answer, text: `${current.answer.text}\n\n${block.text}` }
          : { id, text: block.text, timestamp: entry.timestamp ?? null };
      }
    }
  }
  if (typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim() && turns.length) {
    const last = turns[turns.length - 1];
    if (!last.answer || last.answer.text.trim() !== lastAssistantMessage.trim()) {
      last.answer = { id: 'stop-event', text: lastAssistantMessage, timestamp: null };
    }
  }
  const messages = [];
  for (const turn of turns) {
    messages.push({ role: 'user', text: turn.prompt.text, timestamp: turn.prompt.timestamp });
    if (turn.answer) messages.push({ role: 'assistant', text: turn.answer.text, timestamp: turn.answer.timestamp });
  }
  return messages;
}

/**
 * Builds the source text and per-message attribution. Deterministic for a given transcript, so an unchanged
 * transcript yields identical content (the API then deduplicates).
 */
export function buildSource({ sessionId, projectName, messages, capture, redactions }) {
  const kept = messages.filter(m => (m.role === 'user' ? capture.includes('prompts') : capture.includes('answers')));
  const what = [capture.includes('prompts') ? "the user's typed prompts" : null, capture.includes('answers') ? "Claude Code's final answers" : null]
    .filter(Boolean).join(' and ');
  const header = [
    `Claude Code session ${sessionId}`,
    `Project: ${projectName}`,
    `Captured by the POII Claude Code hook: ${what} only. Tool calls, tool output and file contents are not included.`,
    '',
  ].join('\n');
  let content = header;
  const index = [];
  const hits = new Set();
  let withheld = 0;
  kept.forEach((m, i) => {
    const r = redactText(m.text.replace(/\r\n/g, '\n').trimEnd(), redactions);
    withheld += r.withheld;
    r.patterns.forEach(p => hits.add(p));
    const label = m.role === 'user' ? 'user prompt' : 'assistant answer (Claude Code)';
    content += `\n--- ${i + 1} · ${label} · ${m.timestamp ?? 'time unknown'} ---\n`;
    const startChar = content.length;
    content += r.text;
    index.push({ index: i + 1, role: m.role, timestamp: m.timestamp ?? null, startChar, endChar: content.length });
    content += '\n';
  });
  return { content, messages: index, redaction: { withheldLines: withheld, patterns: [...hits].sort() } };
}

// ----- configuration ----------------------------------------------------------------------------------

/** Reads `.poii/capture.json`. Returns null when the project has not opted in. Throws when the file is invalid. */
export function readCaptureConfig(projectDir) {
  const file = join(projectDir, '.poii', 'capture.json');
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('.poii/capture.json must be a JSON object');
  if (parsed.enabled !== true) return null;
  const events = parsed.events ?? ['Stop'];
  if (!Array.isArray(events) || events.some(e => !SUPPORTED_EVENTS.includes(e))) {
    throw new Error(`"events" must list only ${SUPPORTED_EVENTS.join(', ')}`);
  }
  const capture = parsed.capture ?? CAPTURE_KINDS;
  if (!Array.isArray(capture) || capture.length === 0 || capture.some(c => !CAPTURE_KINDS.includes(c))) {
    throw new Error(`"capture" must be a non-empty list of ${CAPTURE_KINDS.join(', ')}`);
  }
  if (parsed.aiAllowed !== undefined && typeof parsed.aiAllowed !== 'boolean') throw new Error('"aiAllowed" must be true or false');
  if (parsed.envFile !== undefined && (typeof parsed.envFile !== 'string' || !parsed.envFile)) throw new Error('"envFile" must be a path');
  return {
    events,
    capture: CAPTURE_KINDS.filter(c => capture.includes(c)),
    redactions: [...BUILTIN_REDACTIONS, ...compileRedactions(parsed.redact ?? [])],
    aiAllowed: parsed.aiAllowed ?? false,
    envFile: parsed.envFile ? (isAbsolute(parsed.envFile) ? parsed.envFile : join(projectDir, parsed.envFile)) : null,
  };
}

/** Reads only POII_API_URL and POII_TOKEN from a KEY=VALUE file. */
export function readEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(POII_API_URL|POII_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The API base URL, refusing plain http to anything but this machine (the token would travel in clear). */
export function apiBase(raw) {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('POII_API_URL must use https (plain http only for localhost)');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// ----- API calls --------------------------------------------------------------------------------------

async function call(base, token, method, path, body, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('timed out');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(remaining),
  });
  let json = null;
  try { json = await response.json(); } catch { /* empty or non-JSON body */ }
  return { status: response.status, body: json };
}

function describeError(reply) {
  return `${reply.status}${reply.body?.error ? ` ${reply.body.error}` : ''}`;
}

/** Finds or creates the ai_assistant actor the answers are attributed to. Returns its id, or null. */
async function ensureAssistantActor(base, token, deadline) {
  const list = await call(base, token, 'GET', '/v1/actors', undefined, deadline);
  if (list.status !== 200 || !Array.isArray(list.body)) {
    log(`could not list actors (${describeError(list)}); answers stay attributed by name only`);
    return null;
  }
  const found = list.body.find(a => a.kind === 'ai_assistant' && a.displayName === ASSISTANT_ACTOR_NAME && !a.revokedAt);
  if (found) return found.id;
  const created = await call(base, token, 'POST', '/v1/actors', {
    kind: 'ai_assistant', displayName: ASSISTANT_ACTOR_NAME, details: { createdBy: 'claude-code-hook' },
  }, deadline);
  if (created.status !== 201 && created.status !== 200) {
    log(`could not create the "${ASSISTANT_ACTOR_NAME}" actor (${describeError(created)}); answers stay attributed by name only`);
    return null;
  }
  return created.body?.id ?? null;
}

// ----- main -------------------------------------------------------------------------------------------

async function readStdin(deadline) {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  return await new Promise((resolveRead, reject) => {
    const timer = setTimeout(() => reject(new Error('no hook input on stdin')), Math.max(0, deadline - Date.now()));
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolveRead(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** The whole hook. Returns a short outcome string (for tests and the debug log); never throws to the caller. */
export async function run({ env = process.env, stdinText, now = () => new Date() } = {}) {
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(500, Number(env.POII_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const debug = env.POII_HOOK_DEBUG === '1';

  const raw = stdinText ?? await readStdin(deadline);
  let input;
  try { input = JSON.parse(raw); } catch { log('hook input is not JSON; nothing captured'); return 'bad-input'; }
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd;
  if (typeof projectDir !== 'string' || !projectDir) { if (debug) log('no project directory'); return 'disabled'; }

  let config;
  try { config = readCaptureConfig(resolve(projectDir)); } catch (error) {
    log(`.poii/capture.json is invalid, nothing captured: ${error.message}`);
    return 'invalid-config';
  }
  if (!config) { if (debug) log('capture is not enabled for this project'); return 'disabled'; }
  if (!config.events.includes(input.hook_event_name)) {
    if (debug) log(`event ${input.hook_event_name} is not in "events"`);
    return 'event-not-enabled';
  }

  let settings = { POII_API_URL: env.POII_API_URL, POII_TOKEN: env.POII_TOKEN };
  if ((!settings.POII_API_URL || !settings.POII_TOKEN) && config.envFile) {
    try {
      const fromFile = readEnvFile(config.envFile);
      settings = { POII_API_URL: settings.POII_API_URL || fromFile.POII_API_URL, POII_TOKEN: settings.POII_TOKEN || fromFile.POII_TOKEN };
    } catch { log('the "envFile" named in .poii/capture.json cannot be read; nothing captured'); return 'no-credentials'; }
  }
  if (!settings.POII_API_URL || !settings.POII_TOKEN) { log('POII_API_URL or POII_TOKEN is not set; nothing captured'); return 'no-credentials'; }
  if (!/^poii_[A-Za-z0-9_-]+$/.test(settings.POII_TOKEN)) { log('POII_TOKEN is not a POII owner token; nothing captured'); return 'no-credentials'; }
  let base;
  try { base = apiBase(settings.POII_API_URL); } catch (error) { log(`${error.message}; nothing captured`); return 'bad-url'; }

  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) { log('hook input has no usable session_id'); return 'bad-input'; }
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) { log('transcript file not found; nothing captured'); return 'no-transcript'; }
  if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) { log('transcript is larger than 100 MB; nothing captured'); return 'too-large'; }

  const messages = extractMessages(readFileSync(transcriptPath, 'utf8'), {
    lastAssistantMessage: input.hook_event_name === 'Stop' ? input.last_assistant_message : null,
  });
  const projectName = basename(resolve(projectDir));
  const built = buildSource({ sessionId, projectName, messages, capture: config.capture, redactions: config.redactions });
  if (built.messages.length === 0) { if (debug) log('nothing to capture yet'); return 'empty'; }
  if (built.content.length > MAX_CONTENT_CHARS) { log('captured text is larger than 5,000,000 characters; nothing sent'); return 'too-large'; }

  const originKey = `claude-code:${sessionId}`;
  const assistantActorId = config.capture.includes('answers') ? await ensureAssistantActor(base, settings.POII_TOKEN, deadline) : null;
  const created = await call(base, settings.POII_TOKEN, 'POST', '/v1/sources', {
    title: `Claude Code session ${sessionId.slice(0, 8)} (${projectName})`.slice(0, 500),
    kind: 'paste',
    content: built.content,
    mediaType: 'text/plain',
    aiAllowed: config.aiAllowed,
    originKey,
    origin: {
      importedFrom: 'claude-code-hook',
      hookVersion: HOOK_VERSION,
      sessionId,
      cwd: projectName,
      capturedAt: now().toISOString(),
      hookEvent: input.hook_event_name,
      captured: config.capture,
      attribution: {
        assistant: { actorKind: 'ai_assistant', actorName: ASSISTANT_ACTOR_NAME, actorId: assistantActorId },
        user: { statedRole: 'unknown', note: "Prompts become the owner's own words only when the owner confirms a record citing them." },
      },
      messages: built.messages,
      redaction: built.redaction,
    },
  }, deadline);

  if (created.status === 201) {
    log(`captured session ${sessionId.slice(0, 8)}: new source ${created.body?.id} (${built.messages.length} messages, ${built.redaction.withheldLines} lines withheld)`);
    return 'created';
  }
  if (created.status !== 200 || !created.body?.deduplicated) { log(`the API refused the source (${describeError(created)})`); return 'refused'; }
  if (created.body.originKey !== originKey) {
    // Same content as a source with another origin key: never add revisions to someone else's source.
    log(`identical content already exists as source ${created.body.id}; nothing added`);
    return 'duplicate-content';
  }
  const currentLength = created.body.currentRevision?.byteLength ?? 0;
  if (currentLength > Buffer.byteLength(built.content, 'utf8')) {
    // A later capture of the same session already landed (async hooks may finish out of order).
    if (debug) log('the stored capture is already longer; nothing added');
    return 'unchanged';
  }
  const revision = await call(base, settings.POII_TOKEN, 'POST', `/v1/sources/${created.body.id}/revisions`, {
    content: built.content,
    note: `claude-code-hook: ${built.messages.length} messages, ${built.redaction.withheldLines} lines withheld`,
  }, deadline);
  if (revision.status === 201) {
    log(`captured session ${sessionId.slice(0, 8)}: revision ${revision.body?.revisionNo} of source ${created.body.id}`);
    return 'revised';
  }
  if (revision.status === 200 || (revision.status === 409 && revision.body?.error === 'revision_content_exists')) {
    if (debug) log('transcript unchanged since the last capture');
    return 'unchanged';
  }
  log(`the API refused the revision (${describeError(revision)})`);
  return 'refused';
}

async function main() {
  process.exitCode = 0;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(500, Number(process.env.POII_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  // Last resort: if anything is still pending shortly after the deadline (every request already carries the
  // deadline as its own abort signal), stop. Unref'd, so it never keeps a finished hook alive.
  const guard = setTimeout(() => { log(`gave up after ${timeoutMs} ms; nothing more sent`); process.exit(0); }, timeoutMs + 500);
  guard.unref();
  try {
    const outcome = await run();
    if (process.env.POII_HOOK_DEBUG === '1') log(`outcome: ${outcome}`);
  } catch (error) {
    log(`capture failed: ${error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : error?.message ?? String(error)}`);
  }
  // Let the event loop drain instead of calling process.exit(): on Windows, exiting while fetch sockets are
  // closing can abort the process with a non-zero code.
  process.stdin.destroy();
  process.exitCode = 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
const same = process.platform === 'win32' ? invokedPath.toLowerCase() === selfPath.toLowerCase() : invokedPath === selfPath;
if (same) {
  process.on('unhandledRejection', error => { log(`capture failed: ${error?.message ?? String(error)}`); process.exitCode = 0; });
  process.on('uncaughtException', error => { log(`capture failed: ${error?.message ?? String(error)}`); process.exitCode = 0; });
  main();
}
