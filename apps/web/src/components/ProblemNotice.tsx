import type { Problem } from '@/lib/api';
import { explainCode } from '@/lib/format';

/** Readable API error: plain words first, then the API's code and message for reference. */
export function ProblemNotice({ problem, title }: { problem: Problem; title?: string }) {
  const plain = explainCode(problem.code);
  return (
    <div className="notice danger" role="alert" data-testid="problem" data-code={problem.code}>
      <strong>{title ?? 'That did not work.'}</strong> {plain ?? problem.message}
      {problem.issues?.length ? (
        <ul className="compact">
          {problem.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      ) : null}
      <div className="hint">
        <span className="mono">{problem.code}</span>
        {plain ? <> · {problem.message}</> : null}
        {problem.requestId ? <> · request {problem.requestId}</> : null}
      </div>
    </div>
  );
}
