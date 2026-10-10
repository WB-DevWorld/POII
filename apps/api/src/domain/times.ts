// The three times on a record (ADR-0005): recorded (always known), effective and observed, each with a
// status. Unknown and conflicting stay explicit. Pure functions.
import type { TimeStatus } from '@poii/contracts';
import { AppError } from '../common/errors.js';

export type TimeConflictValue = {
  value: string | null;
  sourceId?: string;
  note?: string;
};

export interface TimesInput {
  effectiveAt?: string | null;
  effectiveAtStatus?: TimeStatus;
  observedAt?: string | null;
  observedAtStatus?: TimeStatus;
  timeConflicts?: TimeConflictValue[] | null;
}

export interface Times {
  effectiveAt: Date | null;
  effectiveAtStatus: TimeStatus;
  observedAt: Date | null;
  observedAtStatus: TimeStatus;
  timeConflicts: TimeConflictValue[] | null;
}

export const DEFAULT_TIMES: Times = {
  effectiveAt: null, effectiveAtStatus: 'unknown', observedAt: null, observedAtStatus: 'not_applicable', timeConflicts: null,
};

function mergeOne(
  field: 'effectiveAt' | 'observedAt',
  current: { at: Date | null; status: TimeStatus },
  value: string | null | undefined,
  status: TimeStatus | undefined,
  isCreate: boolean,
): { at: Date | null; status: TimeStatus } {
  const at = value === undefined ? current.at : value === null ? null : new Date(value);
  let next: TimeStatus;
  if (status !== undefined) next = status;
  else if (value === undefined) next = current.status;
  else if (value !== null) next = 'known';
  else next = isCreate ? current.status : current.status === 'known' ? 'unknown' : current.status;
  if (next === 'known' && !at) {
    throw new AppError(400, 'time_status_mismatch', `${field} is required when ${field}Status is known`);
  }
  if ((next === 'unknown' || next === 'not_applicable') && at) {
    if (value !== undefined) throw new AppError(400, 'time_status_mismatch', `${field} must be null when ${field}Status is ${next}`);
    return { at: null, status: next };
  }
  return { at, status: next };
}

/** Merges requested times into the current ones and validates the combination. */
export function mergeTimes(current: Times, input: TimesInput, isCreate = false): Times {
  const effective = mergeOne('effectiveAt', { at: current.effectiveAt, status: current.effectiveAtStatus }, input.effectiveAt, input.effectiveAtStatus, isCreate);
  const observed = mergeOne('observedAt', { at: current.observedAt, status: current.observedAtStatus }, input.observedAt, input.observedAtStatus, isCreate);
  const conflicts = input.timeConflicts !== undefined ? input.timeConflicts : current.timeConflicts;
  if ((effective.status === 'conflicting' || observed.status === 'conflicting') && !conflicts?.length) {
    throw new AppError(400, 'time_conflicts_required', 'A conflicting time needs the competing values in timeConflicts');
  }
  return {
    effectiveAt: effective.at,
    effectiveAtStatus: effective.status,
    observedAt: observed.at,
    observedAtStatus: observed.status,
    timeConflicts: conflicts?.length ? conflicts : null,
  };
}
