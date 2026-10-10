'use client';

// #20 conversation import: choose the export file, review its conversations, import the selected ones.
// The file is read in the browser (size and JSON check) and sent to the API through server actions.
import { useState, useTransition, type ChangeEvent } from 'react';
import type { ConversationImportResponse, ConversationPreviewResponse } from '@poii/contracts';
import { ProblemNotice } from '@/components/ProblemNotice';
import type { Problem } from '@/lib/api';
import { importConversationsAction, previewConversationsAction } from './actions';
import { checkExportFile, formatSpan, isSelectable, MAX_SELECTED, OUTCOME_LABEL, parseExportText, STATE_LABEL, toggleSelection } from './logic';

const PROVIDER: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude.ai' };

export function ImportConversations() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ConversationPreviewResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<ConversationImportResponse | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [neverSendToAi, setNeverSendToAi] = useState(false);
  const [pending, startTransition] = useTransition();

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setFile(null);
    setPreview(null);
    setSelected([]);
    setResult(null);
    setProblem(null);
    const fileProblem = checkExportFile(chosen);
    if (fileProblem || !chosen) {
      setProblem({ code: 'invalid_input', message: fileProblem ?? 'Choose a file.' });
      return;
    }
    const parsed = parseExportText(await chosen.text());
    if (!parsed.ok) {
      setProblem({ code: 'invalid_input', message: parsed.message });
      return;
    }
    setFile(chosen);
    const fd = new FormData();
    fd.set('file', chosen);
    startTransition(async () => {
      const state = await previewConversationsAction(fd);
      if (state.ok) setPreview(state.preview);
      else setProblem(state.problem);
    });
  };

  const onImport = () => {
    if (!file || !selected.length || pending) return;
    const fd = new FormData();
    fd.set('file', file);
    fd.set('conversationIds', JSON.stringify(selected));
    if (neverSendToAi) fd.set('neverSendToAi', 'on');
    setProblem(null);
    startTransition(async () => {
      const state = await importConversationsAction(fd);
      if (state.ok) {
        setResult(state.result);
        setSelected([]);
      } else {
        setProblem(state.problem);
      }
    });
  };

  const conversations = preview?.conversations ?? [];
  const full = selected.length >= MAX_SELECTED;

  return (
    <div className="stack">
      <div className="card">
        <label htmlFor="import-file">Export file (conversations.json)</label>
        <input id="import-file" type="file" accept=".json,application/json" onChange={onFile} disabled={pending} data-testid="import-file" />
        <p className="hint">
          Unzip the export from ChatGPT or Claude.ai and choose its <span className="mono">conversations.json</span> (up to 50 MB). The file is
          only listed until you import; nothing is stored before that.
        </p>
      </div>

      {problem ? <ProblemNotice problem={problem} title="Nothing was imported." /> : null}
      {pending ? <p className="muted" role="status">Working…</p> : null}

      {preview ? (
        <section aria-label="Conversations in the file">
          <h2>
            {preview.conversationCount} conversation{preview.conversationCount === 1 ? '' : 's'} in this {PROVIDER[preview.provider] ?? preview.provider} export
          </h2>
          <p className="hint">
            Select the conversations to import (at most {MAX_SELECTED} at a time). Each becomes one source. Re-importing an unchanged
            conversation does nothing; a changed one becomes a new revision.
          </p>
          <div className="table-wrap">
            <table data-testid="import-table">
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Select</span></th>
                  <th scope="col">Title</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Dates</th>
                  <th scope="col">In POII</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map(conversation => {
                  const checked = selected.includes(conversation.id);
                  const selectable = isSelectable(conversation);
                  const state = STATE_LABEL[conversation.importState];
                  const notes = [
                    conversation.unknownTimeCount ? `${conversation.unknownTimeCount} without a time` : '',
                    conversation.otherBranchMessageCount ? `${conversation.otherBranchMessageCount} on other branches (not imported)` : '',
                    conversation.skippedMessageCount ? `${conversation.skippedMessageCount} system, tool or empty (not imported)` : '',
                  ].filter(Boolean);
                  return (
                    <tr key={conversation.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${conversation.title}`}
                          checked={checked}
                          disabled={pending || !selectable || (!checked && full)}
                          onChange={e => setSelected(toggleSelection(conversations, selected, conversation.id, e.target.checked))}
                          style={{ width: 'auto' }}
                        />
                      </td>
                      <td>
                        {conversation.title}
                        <div className="hint mono">{conversation.originKey}</div>
                      </td>
                      <td>
                        {conversation.messageCount}
                        {notes.length ? <div className="hint">{notes.join('; ')}</div> : null}
                      </td>
                      <td className="nowrap">{formatSpan(conversation.firstMessageAt, conversation.lastMessageAt)}</td>
                      <td>
                        <span className={`tag ${state.tone}`.trim()}>{state.label}</span>
                        {conversation.sourceId ? <a href={`/sources/${conversation.sourceId}`}>source</a> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="check">
            <input type="checkbox" checked={neverSendToAi} onChange={e => setNeverSendToAi(e.target.checked)} /> Never send to AI
          </label>
          <div className="row actions">
            <button type="button" onClick={onImport} disabled={pending || !selected.length} data-testid="import-submit">
              Import selected ({selected.length})
            </button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="card" aria-live="polite" data-testid="import-results">
          <h2>Imported</h2>
          <p className="hint">
            Assistant messages are attributed to “{result.assistantActor.displayName}”, never to you. No records were created; cite spans of
            these sources to propose candidates.
          </p>
          <ul>
            {result.results.map(item => (
              <li key={item.originKey}>
                {item.sourceId ? <a href={`/sources/${item.sourceId}`}>{item.title}</a> : item.title}{' '}
                <span className={`tag ${item.outcome === 'created' || item.outcome === 'revised' ? 'ok' : ''}`.trim()}>{OUTCOME_LABEL[item.outcome]}</span>
                {item.revisionNo && item.revisionNo > 1 ? <span className="tag">revision {item.revisionNo}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
