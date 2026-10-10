'use client';

import { createContext, startTransition, useActionState, useContext, type FormEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/lib/action-state';
import { ProblemNotice } from './ProblemNotice';

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
  testId?: string;
};

const PendingContext = createContext(false);

/** A native form bound to a server action. Errors come back as readable notices; success usually redirects. */
export function ActionForm({ action, children, className, testId, ...rest }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  // With JavaScript, submit through a transition so React does not reset the fields when the action
  // returns an error. Without JavaScript the native form posts to the same server action.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    // Same as FormData(form, submitter): include the clicked button's name and value.
    const data = new FormData(form);
    if (submitter?.name) data.append(submitter.name, submitter.value);
    startTransition(() => formAction(data));
  };
  return (
    <form action={formAction} onSubmit={onSubmit} className={className} aria-label={rest['aria-label']} data-testid={testId} aria-busy={pending}>
      {state && !state.ok ? <ProblemNotice problem={state.problem} /> : null}
      {state?.ok && state.message ? (
        <p className="notice ok" role="status" data-testid="action-message">
          {state.message}
        </p>
      ) : null}
      <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
    </form>
  );
}

/** Submit button that disables itself while the action runs (prevents double submits). */
export function SubmitButton({ children, className, name, value }: { children: ReactNode; className?: string; name?: string; value?: string }) {
  const contextPending = useContext(PendingContext);
  const { pending: formPending } = useFormStatus();
  const pending = contextPending || formPending;
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending} name={name} value={value}>
      {pending ? 'Working…' : children}
    </button>
  );
}
