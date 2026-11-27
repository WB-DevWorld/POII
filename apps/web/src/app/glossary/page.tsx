import type { Metadata } from 'next';
import { glossary } from '@/lib/labels';

export const metadata: Metadata = { title: 'Glossary' };

/** Every word the screens use for a POII code, with the code itself (ADR-0014). Generated from lib/labels.ts. */
export default function GlossaryPage() {
  return (
    <section>
      <h1>Glossary</h1>
      <p className="lede">
        The words POII shows, what they mean, and the code each one stands for. People see the words. The API, exports and AI
        agents use the codes, which never change, so a colleague and an agent can always tell they mean the same thing.
      </p>
      <h2>Words used everywhere</h2>
      <dl className="pairs">
        <dt>Source</dt>
        <dd>A chat, document or note added to POII. Its original text is kept unchanged.</dd>
        <dt>Revision</dt>
        <dd>A later version of a source. Earlier revisions are kept.</dd>
        <dt>Record</dt>
        <dd>A fact, requirement, decision or open question, quoting the passages of the sources it rests on.</dd>
        <dt>Passage (evidence)</dt>
        <dd>The exact text of a source that a record quotes. The API calls its position a span.</dd>
        <dt>Awaiting review</dt>
        <dd>Saved, not yet confirmed. The API calls such a record a candidate.</dd>
        <dt>Confirm</dt>
        <dd>A person with authority agrees the record is right. Name and time are recorded (an approval in the API).</dd>
        <dt>Replace</dt>
        <dd>
          A new record takes over from an earlier one once it is confirmed. The earlier record is kept, but stops being current.
          The API calls this supersede.
        </dd>
        <dt>Context pack</dt>
        <dd>An export of records with their quoted evidence, for a colleague or an AI agent to read.</dd>
        <dt>Never send to AI</dt>
        <dd>A source marked this way, and every record quoting it, is never sent to an AI provider or put in an export for an AI.</dd>
      </dl>
      {glossary.map(group => (
        <div key={group.heading}>
          <h2>{group.heading}</h2>
          <p className="hint">
            Field in the API: <span className="mono">{group.field}</span>
          </p>
          <div className="table-wrap">
            <table data-testid="glossary-table">
              <thead>
                <tr>
                  <th scope="col">Shown as</th>
                  <th scope="col">Meaning</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(group.terms).map(([code, term]) => (
                  <tr key={code}>
                    <td>{term.label}</td>
                    <td>{term.meaning}</td>
                    <td className="mono">{code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
