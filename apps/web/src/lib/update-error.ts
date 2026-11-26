// Which page error means "POII was updated while this page was open".
//
// Every release builds a new web app. A form that was loaded from the previous build posts a Server Action id
// the new build does not know; Next answers `X-Nextjs-Action-Not-Found: 1` and the client throws an
// UnrecognizedActionError. Nothing ran on the server, so nothing was saved: reloading and doing the step again
// is safe. Staff test of 26 Nov 2026, Test 23.

export interface PageErrorText {
  title: string;
  body: string;
}

export function isStaleBuildError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'UnrecognizedActionError') return true;
  return typeof message === 'string' && /Server Action "[^"]*" was not found on the server/.test(message);
}

export function pageErrorText(error: unknown): PageErrorText {
  if (isStaleBuildError(error)) {
    return {
      title: 'POII was updated while this page was open',
      body:
        'Your last step did not reach POII, so nothing was saved. Reload the page and do the step again. ' +
        'Text you typed into a form may need to be entered again.',
    };
  }
  return {
    title: 'This page could not load',
    body:
      'Something went wrong while showing this page. Reload to try again. If it keeps happening, note the time ' +
      'and the page address and report it.',
  };
}
