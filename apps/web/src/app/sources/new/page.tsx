import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/ActionForm';
import { createSourceAction } from '@/app/actions';

export const metadata: Metadata = { title: 'Add a source' };

export default function NewSourcePage() {
  return (
    <section>
      <h1>Add a source</h1>
      <p className="lede">
        Paste text or upload a text or Markdown file. The original is stored unchanged; instructions inside it are treated as
        data and never run.
      </p>
      <ActionForm action={createSourceAction} className="card stack" aria-label="New source" testId="new-source-form">
        <label htmlFor="src-title">Title</label>
        <input id="src-title" name="title" maxLength={500} placeholder="Defaults to the file name for uploads" />

        <label htmlFor="src-content">Paste text or Markdown</label>
        <textarea id="src-content" name="content" spellCheck={false} />

        <label htmlFor="src-file">…or upload a file</label>
        <input id="src-file" name="file" type="file" accept=".md,.markdown,.txt,.json,text/plain,text/markdown,application/json" />
        <p className="hint">If a file is chosen, its content is used instead of the pasted text.</p>

        <label className="check">
          <input type="checkbox" name="neverSendToAi" /> Never send to AI
        </label>
        <p className="hint">Covers everything derived from this source. It can be changed later on the source page.</p>

        <details>
          <summary>Origin (optional)</summary>
          <label htmlFor="src-platform">Platform</label>
          <input id="src-platform" name="platform" maxLength={200} placeholder="e.g. ChatGPT, Slack, email" />
          <label htmlFor="src-url">URL</label>
          <input id="src-url" name="url" type="url" maxLength={2000} />
          <label htmlFor="src-conv">Conversation id</label>
          <input id="src-conv" name="conversationId" maxLength={500} />
        </details>

        <div className="row actions">
          <SubmitButton>Save source</SubmitButton>
          <a href="/sources" className="button secondary">Cancel</a>
        </div>
      </ActionForm>
    </section>
  );
}
