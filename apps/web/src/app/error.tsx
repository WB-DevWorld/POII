'use client';

// Error boundary for every page under the root layout. The site header and footer stay; only the page body is
// replaced. Without this file Next shows its built-in "This page couldn't load", which does not say why.
import { pageErrorText } from '@/lib/update-error';

export default function PageError({ error }: { error: Error & { digest?: string } }) {
  const text = pageErrorText(error);
  return (
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
  );
}
