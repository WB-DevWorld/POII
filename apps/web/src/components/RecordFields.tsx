import type { ActorView, LifecycleStatus, RecordKind, StatedRole, StatementMode, TimeStatus } from '@poii/contracts';
import { conflictLines, conflictsFor, humanize, inputFromIso, type TimeConflictValue } from '@/lib/format';

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

/** Effective or observed time: status plus value (UTC) plus competing values when conflicting. */
export function TimeInputs({
  field,
  idPrefix,
  status,
  value,
  conflicts,
}: {
  field: 'effective' | 'observed';
  idPrefix: string;
  status?: TimeStatus;
  value?: string | null;
  conflicts?: TimeConflictValue[] | null;
}) {
  const label = field === 'effective' ? 'Effective time' : 'Observed time';
  const id = `${idPrefix}-${field}`;
  return (
    <fieldset className="time-inputs">
      <legend>{label}</legend>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${id}-status`}>Status</label>
          <select id={`${id}-status`} name={`${field}AtStatus`} defaultValue={status ?? 'unknown'}>
            {timeStatuses.map(s => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-at`}>When (UTC), if known</label>
          <input id={`${id}-at`} type="datetime-local" name={`${field}At`} defaultValue={inputFromIso(value)} />
        </div>
      </div>
      <label htmlFor={`${id}-conflicts`}>Competing values, if conflicting</label>
      <textarea
        id={`${id}-conflicts`}
        name={`${field}Conflicts`}
        className="short"
        placeholder={'2026-03-04 16:02 chat says\n2026-03-06 ticket says'}
        defaultValue={conflictLines(conflictsFor(field, conflicts))}
      />
      <p className="hint">One per line: date, optional time (UTC), then a note. Only used when the status is conflicting.</p>
    </fieldset>
  );
}

/** Attribution fields: who said it, in which role and mode. Kept apart from approval. */
export function AttributionFields({ idPrefix, actors, defaults }: { idPrefix: string; actors: ActorView[]; defaults: RecordDefaults }) {
  const selectable = actors.filter(a => a.kind === 'person' || a.kind === 'ai_assistant');
  return (
    <fieldset>
      <legend>Attribution: who said it</legend>
      <p className="hint">
        This is not approval. Pasted assistant text gets role <strong>assistant</strong> and mode <strong>pasted</strong>; it is never the
        owner&apos;s statement. Role owner is only for the workspace owner (leave &quot;stated by&quot; empty to mean them); role
        assistant needs an AI assistant as &quot;stated by&quot;.
      </p>
      <label htmlFor={`${idPrefix}-statedby`}>Stated by</label>
      <select id={`${idPrefix}-statedby`} name="statedByActorId" defaultValue={defaults.statedByActorId ?? ''}>
        <option value="">Unknown or not recorded</option>
        {selectable.map(a => (
          <option key={a.id} value={a.id}>
            {a.displayName} ({humanize(a.kind)}{a.authority ? `, ${a.authority} authority` : ''})
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
            <label htmlFor={`${idPrefix}-newkind`}>Kind</label>
            <select id={`${idPrefix}-newkind`} name="newActorKind" defaultValue="person">
              <option value="person">person</option>
              <option value="ai_assistant">AI assistant</option>
            </select>
          </div>
        </div>
        <p className="hint">When a name is entered, it is added and used as &quot;stated by&quot;. New people have no authority.</p>
      </details>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${idPrefix}-role`}>Stated role</label>
          <select id={`${idPrefix}-role`} name="statedRole" defaultValue={defaults.statedRole ?? 'unknown'}>
            {roles.map(r => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-mode`}>Statement mode</label>
          <select id={`${idPrefix}-mode`} name="statementMode" defaultValue={defaults.statementMode === 'ai_extracted' ? 'quoted' : (defaults.statementMode ?? 'quoted')}>
            {humanModes.map(m => (
              <option key={m} value={m}>
                {m}
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
}: {
  idPrefix: string;
  actors: ActorView[];
  defaults: RecordDefaults;
  title?: string;
  onTitleChange?: (value: string) => void;
}) {
  const titleProps = onTitleChange
    ? { value: title ?? '', onChange: (e: { target: { value: string } }) => onTitleChange(e.target.value) }
    : { defaultValue: defaults.title ?? '' };
  return (
    <>
      <div className="inline-fields">
        <div>
          <label htmlFor={`${idPrefix}-kind`}>Kind</label>
          <select id={`${idPrefix}-kind`} name="kind" required defaultValue={defaults.kind ?? ''}>
            <option value="" disabled>
              Choose…
            </option>
            {kinds.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-status`}>Lifecycle status</label>
          <select id={`${idPrefix}-status`} name="lifecycleStatus" defaultValue={defaults.lifecycleStatus ?? 'unknown'}>
            {statuses.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor={`${idPrefix}-title`}>Title</label>
      <input id={`${idPrefix}-title`} name="title" required maxLength={500} {...titleProps} />
      <label htmlFor={`${idPrefix}-body`}>Body</label>
      <textarea id={`${idPrefix}-body`} name="body" className="short" maxLength={100000} defaultValue={defaults.body ?? ''} />
      <AttributionFields idPrefix={idPrefix} actors={actors} defaults={defaults} />
      <TimeInputs
        field="effective"
        idPrefix={idPrefix}
        status={defaults.effectiveAtStatus}
        value={defaults.effectiveAt}
        conflicts={defaults.timeConflicts}
      />
      <TimeInputs
        field="observed"
        idPrefix={idPrefix}
        status={defaults.observedAtStatus}
        value={defaults.observedAt}
        conflicts={defaults.timeConflicts}
      />
    </>
  );
}
