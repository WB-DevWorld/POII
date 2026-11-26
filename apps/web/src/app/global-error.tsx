'use client';

// Last-resort boundary for an error in the root layout itself. It replaces the whole document, so it brings its
// own html and body; the stylesheet keeps it looking like POII.
import { pageErrorText } from '@/lib/update-error';
import './globals.css';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const text = pageErrorText(error);
  return (
    <html lang="en">
      <body>
        <main className="page" id="main">
          <section className="card" role="alert" data-testid="page-error">
            <h1>{text.title}</h1>
            <p>{text.body}</p>
            <div className="row actions">
              <button type="button" onClick={() => window.location.reload()}>
                Reload the page
              </button>
              <button type="button" className="secondary" onClick={() => window.history.back()}>
                Go back
              </button>
            </div>
            {error.digest ? <p className="hint mono">Reference {error.digest}</p> : null}
          </section>
        </main>
      </body>
    </html>
  );
}
