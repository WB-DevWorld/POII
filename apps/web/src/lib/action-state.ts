import type { Problem } from './api';

/** What a server action hands back to its form. Successful actions usually redirect instead. */
export type ActionState = { ok: true; message?: string } | { ok: false; problem: Problem } | null;
