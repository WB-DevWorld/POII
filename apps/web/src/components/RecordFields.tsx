import type { ActorView, LifecycleStatus, RecordKind, StatedRole, StatementMode, TimeStatus } from '@poii/contracts';
import { conflictLines, conflictsFor, inputFromIso, type ConflictSource, type TimeConflictValue } from '@/lib/format';
import {
  actorKindTerms,
  authorityTerms,
  labelOf,
  lifecycleStatusTerms,
  recordKindTerms,
  statedRoleTerms,
  statementModeTerms,
  timeStatusTerms,
} from '@/lib/labels';

const kinds: RecordKind[] = ['fact', 'requirement', 'decision', 'question'];
const statuses: LifecycleStatus[] = ['proposed', 'decided', 'implemented', 'observed', 'unknown'];
const roles: StatedRole[] = ['owner', 'assistant', 'third_party', 'unknown'];
const humanModes: StatementMode[] = ['quoted', 'pasted', 'paraphrased'];
const timeStatuses: TimeStatus[] = ['known', 'unknown', 'not_applicable', 'conflicting'];

export type RecordDefaults = {
  kind?: RecordKind | '';
  title?: string;
  body?: string;
  lifecycleStatus?: LifecycleStatus;
  statedByActorId?: string | null;
  statedRole?: StatedRole;
  statementMode?: StatementMode;
  effectiveAt?: string | null;
  effectiveAtStatus?: TimeStatus;
  observedAt?: string | null;
  observedAtStatus?: TimeStatus;
  timeConflicts?: TimeConflictValue[] | null;
};

/**
 * Effective or observed time: status plus value (UTC) plus competing values when conflicting. With `sources`, a
 * competing value can be said to come from one of them: its line ends with the source's number, "[1]".
 */
export function TimeInputs({
  field,
  idPrefix,
  status,
  value,
  conflicts,
  sources = [],
}: {
  field: 'effective' | 'observed';
  idPrefix: string;
  status?: TimeStatus;
  value?: string | null;
  conflicts?: TimeConflictValue[] | null;
  sources?: ConflictSource[];
}) {
  const label = field === 'effective' ? 'True from (effective time)' : 'Seen in practice (observed time)';
  const id = `${idPrefix}-${field}`;
  return (
    <fieldset className="time-inputs">
      <legend>{label}</legend>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${id}-status`}>Is the time known?</label>
          <select id={`${id}-status`} name={`${field}AtStatus`} defaultValue={status ?? 'unknown'}>
            {timeStatuses.map(s => (
              <option key={s} value={s}>
                {labelOf(timeStatusTerms, s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-at`}>When (UTC), if known</label>
          <input id={`${id}-at`} type="datetime-local" name={`${field}At`} defaultValue={inputFromIso(value)} />
        </div>
      </div>
      <label htmlFor={`${id}-conflicts`}>Times the sources give, if they disagree</label>
      <textarea
        id={`${id}-conflicts`}
        name={`${field}Conflicts`}
        className="short"
        placeholder={'2026-03-04 16:02 chat says\n2026-03-06 ticket says\nno date catalogue page'}
        defaultValue={conflictLines(conflictsFor(field, conflicts), sources.map(s => s.id))}
      />
      <p className="hint">
        One per line: date, optional time (UTC), then a note. For a value whose source carries no date, start the line with
        &quot;no date&quot;. Only used when &quot;Sources disagree&quot; is chosen above.
      </p>
      {sources.length ? (
        <div className="hint" data-testid={`${id}-conflict-sources`}>
          To say which source a value comes from, end its line with the source&apos;s number, for example{' '}
          <span className="mono">2026-03-04 chat says [1]</span>:
          <ul className="plain">
            {sources.map((s, i) => (
              <li key={s.id}>
                {/* The order of these inputs is the numbering the lines refer to. */}
                <input type="hidden" name={`${field}ConflictSource`} value={s.id} />
                <span className="mono">[{i + 1}]</span> <a href={`/sources/${s.id}`}>{s.title ?? `a source this record does not cite (…${s.id.slice(-8)})`}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Attribution fields: who said it, in which role and mode. Kept apart from approval. */
export function AttributionFields({ idPrefix, actors, defaults }: { idPrefix: string; actors: ActorView[]; defaults: RecordDefaults }) {
  const selectable = actors.filter(a => a.kind === 'person' || a.kind === 'ai_assistant');
  return (
    <fieldset>
      <legend>Who said it</legend>
      <p className="hint">
        Saying something is not confirming it. Text pasted from an AI chat is <strong>AI assistant</strong>, <strong>Pasted
        text</strong>; it never counts as the owner speaking. The role Owner is only for the workspace owner (leave &quot;Said
        by&quot; empty to mean them); the role AI assistant needs an AI assistant under &quot;Said by&quot;.
      </p>
      <label htmlFor={`${idPrefix}-statedby`}>Said by</label>
      <select id={`${idPrefix}-statedby`} name="statedByActorId" defaultValue={defaults.statedByActorId ?? ''}>
        <option value="">Not recorded (or the owner)</option>
        {selectable.map(a => (
          <option key={a.id} value={a.id}>
            {a.displayName} ({labelOf(actorKindTerms, a.kind)}{a.authority ? `, ${labelOf(authorityTerms, a.authority)} authority` : ''})
          </option>
        ))}
      </select>
      <details className="inline-add">
        <summary>Add a person or assistant</summary>
        <div className="inline-fields">
          <div>
            <label htmlFor={`${idPrefix}-newname`}>Name</label>
            <input id={`${idPrefix}-newname`} name="newActorName" maxLength={200} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-newkind`}>Person or AI</label>
            <select id={`${idPrefix}-newkind`} name="newActorKind" defaultValue="person">
              <option value="person">Person</option>
              <option value="ai_assistant">AI assistant</option>
            </select>
          </div>
        </div>
        <p className="hint">When a name is entered, it is added and used as &quot;Said by&quot;. New people cannot confirm records.</p>
      </details>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${idPrefix}-role`}>In the role of</label>
          <select id={`${idPrefix}-role`} name="statedRole" defaultValue={defaults.statedRole ?? 'unknown'}>
            {roles.map(r => (
              <option key={r} value={r}>
                {labelOf(statedRoleTerms, r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-mode`}>How it was captured</label>
          <select id={`${idPrefix}-mode`} name="statementMode" defaultValue={defaults.statementMode === 'ai_extracted' ? 'quoted' : (defaults.statementMode ?? 'quoted')}>
            {humanModes.map(m => (
              <option key={m} value={m}>
                {labelOf(statementModeTerms, m)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}

/** Every editable field of a record. Title can be controlled (the span selector prefills it). */
export function RecordFields({
  idPrefix,
  actors,
  defaults,
  title,
  onTitleChange,
  conflictSources,
}: {
  idPrefix: string;
  actors: ActorView[];
  defaults: RecordDefaults;
  title?: string;
  onTitleChange?: (value: string) => void;
  /** Sources a competing time value can be said to come from. */
  conflictSources?: ConflictSource[];
}) {
  const titleProps = onTitleChange
    ? { value: title ?? '', onChange: (e: { target: { value: string } }) => onTitleChange(e.target.value) }
    : { defaultValue: defaults.title ?? '' };
  return (
    <>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${idPrefix}-kind`}>Kind of record</label>
          <select id={`${idPrefix}-kind`} name="kind" required defaultValue={defaults.kind ?? ''}>
            <option value="" disabled>
              Choose…
            </option>
            {kinds.map(k => (
              <option key={k} value={k}>
                {labelOf(recordKindTerms, k)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-status`}>Stage</label>
          <select id={`${idPrefix}-status`} name="lifecycleStatus" defaultValue={defaults.lifecycleStatus ?? 'unknown'}>
            {statuses.map(s => (
              <option key={s} value={s}>
                {labelOf(lifecycleStatusTerms, s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor={`${idPrefix}-title`}>Title</label>
      <input id={`${idPrefix}-title`} name="title" required maxLength={500} {...titleProps} />
      <label htmlFor={`${idPrefix}-body`}>Text (optional)</label>
      <textarea id={`${idPrefix}-body`} name="body" className="short" maxLength={100000} defaultValue={defaults.body ?? ''} />
      <AttributionFields idPrefix={idPrefix} actors={actors} defaults={defaults} />
      <TimeInputs
        field="effective"
        idPrefix={idPrefix}
        status={defaults.effectiveAtStatus}
        value={defaults.effectiveAt}
        conflicts={defaults.timeConflicts}
        sources={conflictSources}
      />
      <TimeInputs
        field="observed"
        idPrefix={idPrefix}
        status={defaults.observedAtStatus}
        value={defaults.observedAt}
        conflicts={defaults.timeConflicts}
        sources={conflictSources}
      />
    </>
  );
}
