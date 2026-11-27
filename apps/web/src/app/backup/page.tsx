import type { Metadata } from 'next';
import { restoreAction } from '@/app/actions';
import { ActionForm, SubmitButton } from '@/components/ActionForm';

export const metadata: Metadata = { title: 'Backup' };

export default function BackupPage() {
  return (
    <section>
      <h1>Back up and restore</h1>
      <p className="lede">
        A backup is the complete workspace in one JSON file (format poii.backup v1): sources with their original bytes,
        revisions, records and their history, evidence, confirmations, the audit log and a note of everything deleted, all with
        their original ids. A restore only works into an empty workspace.
      </p>
      <div className="grid-2">
        <div className="card">
          <h2>Download a backup</h2>
          <p className="hint">The file contains everything in the workspace, including private evidence. Store it somewhere you trust.</p>
          <form method="post" action="/backup/download" aria-label="Download backup">
            <button type="submit" data-testid="download-backup">Download backup</button>
          </form>
        </div>
        <div className="card">
          <h2>Restore</h2>
          <p className="hint">
            Restore only works into an empty workspace, such as a clean install. Restoring the same backup twice changes nothing.
          </p>
          <ActionForm action={restoreAction} aria-label="Restore backup" testId="restore-form">
            <label htmlFor="restore-file">Backup file (.json)</label>
            <input id="restore-file" name="backup" type="file" accept=".json,application/json" required />
            <SubmitButton>Restore</SubmitButton>
          </ActionForm>
        </div>
      </div>
    </section>
  );
}
