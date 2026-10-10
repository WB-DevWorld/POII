// Owner-approval check for gated pull requests (docs/release-policy.md, "Classification").
// Pure functions, no dependencies. The same two functions are inlined in .github/workflows/risk-classify.yml
// (a workflow cannot import a file that may not exist yet on the base branch); owner-approval.test.mjs asserts
// the inlined copies stay byte-identical, whitespace aside. The required `classify` check fails while a gated
// PR lacks an approving review by every approver on the PR's current head commit. Changing this file is gated.

/**
 * Reviews as GitHub lists them (chronological). Only the latest review with a decisive state counts per
 * login; comments do not change a decision. An approval counts only for the commit it was given on, so a
 * push after the approval needs a new one (the ruleset dismisses stale reviews for the same reason).
 * @param {Array<{user?: {login?: string, type?: string}|null, state: string, commit_id?: string|null}>} reviews
 * @param {string[]} approvers logins that must each have approved
 * @param {string} headSha the PR's current head commit
 * @returns {{ approved: string[], missing: Array<{ login: string, reason: string }> }}
 */
export const approvalStatus = (reviews, approvers, headSha) => {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || review.user?.type === 'Bot') continue;
    const state = String(review.state).toUpperCase();
    if (state === 'COMMENTED' || state === 'PENDING') continue;
    latest.set(login, { state, commitId: review.commit_id ?? null });
  }
  const short = sha => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : String(sha));
  const approved = [];
  const missing = [];
  for (const login of approvers) {
    const review = latest.get(login);
    if (!review) missing.push({ login, reason: 'no review' });
    else if (review.state !== 'APPROVED') missing.push({ login, reason: `latest review is ${review.state}` });
    else if (review.commitId !== headSha) missing.push({ login, reason: `approved ${short(review.commitId)}, head is ${short(headSha)}` });
    else approved.push(login);
  }
  return { approved, missing };
};

/**
 * Approver logins: the policy's `approvers` list (version 3 and later). A base branch whose policy has no
 * such list yet (version 2) falls back to the user logins named in its CODEOWNERS, so the first PR that
 * introduces the list is itself gated by the owner's review. No approver at all is refused: fail closed.
 * @param {{ approvers?: unknown }} policy risk-classes.json from the base branch
 * @param {string} codeowners .github/CODEOWNERS from the base branch
 * @returns {string[]}
 */
export const approversOf = (policy, codeowners) => {
  const valid = login => typeof login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login);
  let approvers = Array.isArray(policy.approvers) ? policy.approvers : [];
  if (approvers.length === 0) {
    const logins = new Set();
    for (const line of String(codeowners).split('\n')) {
      const rule = line.replace(/#.*/, '').trim();
      if (!rule) continue;
      for (const owner of rule.split(/\s+/).slice(1)) {
        if (owner.startsWith('@') && !owner.includes('/') && !owner.includes('[')) logins.add(owner.slice(1));
      }
    }
    approvers = [...logins];
  }
  if (approvers.length === 0 || !approvers.every(valid)) {
    throw new Error('No valid approver login: risk-classes.json needs an "approvers" list (or CODEOWNERS must name a user)');
  }
  return approvers;
};
