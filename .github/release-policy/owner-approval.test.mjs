// Tests for the owner-approval check used by risk-classify.yml. Run: node --test ".github/release-policy/*.test.mjs"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPolicy, repoRoot } from './check-coverage.mjs';
import { approvalStatus, approversOf } from './owner-approval.mjs';

const owner = { login: 'wbdevworld', type: 'User' };
const bot = { login: 'wbdevworld-poii-agent[bot]', type: 'Bot' };
const head = 'a'.repeat(40);
const older = 'b'.repeat(40);
const codeowners = readFileSync(join(repoRoot, '.github', 'CODEOWNERS'), 'utf8');
const squash = s => s.replace(/\s+/g, '');

function inlined(yml, name) {
  const marker = `const ${name} = `;
  const start = yml.indexOf(marker);
  assert.ok(start > 0, `risk-classify.yml defines ${name}`);
  const end = yml.indexOf('\n            };', start);
  assert.ok(end > start, `${name} ends with "};" at the script indentation`);
  return yml.slice(start + marker.length, end + '\n            };'.length).trim().replace(/;$/, '');
}

test('the approval functions inlined in risk-classify.yml are the same code as this module', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'risk-classify.yml'), 'utf8');
  assert.equal(squash(inlined(yml, 'approvalStatus')), squash(approvalStatus.toString()));
  assert.equal(squash(inlined(yml, 'approversOf')), squash(approversOf.toString()));
});

test('risk-classify.yml runs on reviews, reads policy and CODEOWNERS from the base branch and fails without approval', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'risk-classify.yml'), 'utf8');
  assert.match(yml, /pull_request_review:\n\s+types: \[submitted, edited, dismissed\]/);
  assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(yml, /readFileSync\('\.github\/CODEOWNERS'/);
  assert.match(yml, /pulls\.listReviews/);
  assert.match(yml, /core\.setFailed\(/);
});

test('the policy names the owner as the only approver; CODEOWNERS is the fallback for an older base policy', () => {
  assert.deepEqual(approversOf(loadPolicy(), codeowners), ['wbdevworld']);
  assert.deepEqual(approversOf({}, codeowners), ['wbdevworld']);
  assert.deepEqual(approversOf({ version: 2 }, '# comment\n/.github/ @wbdevworld @WB-DevWorld/team\n/x @wbdevworld\n'), ['wbdevworld']);
  assert.throws(() => approversOf({}, '# nothing\n'), /approver/);
  assert.throws(() => approversOf({ approvers: ['not a login!'] }, codeowners), /approver/);
  assert.throws(() => approversOf({ approvers: ['-leading'] }, codeowners), /approver/);
});

test('no review at all: missing', () => {
  const r = approvalStatus([], ['wbdevworld'], head);
  assert.deepEqual(r, { approved: [], missing: [{ login: 'wbdevworld', reason: 'no review' }] });
});

test('an approval on the current head counts', () => {
  const r = approvalStatus([{ user: owner, state: 'APPROVED', commit_id: head }], ['wbdevworld'], head);
  assert.deepEqual(r, { approved: ['wbdevworld'], missing: [] });
});

test('an approval on an earlier commit does not count after a push', () => {
  const r = approvalStatus([{ user: owner, state: 'APPROVED', commit_id: older }], ['wbdevworld'], head);
  assert.equal(r.approved.length, 0);
  assert.match(r.missing[0].reason, /approved bbbbbbb, head is aaaaaaa/);
});

test('the latest decisive review wins; comments do not change it', () => {
  const approvedThenChanges = [
    { user: owner, state: 'APPROVED', commit_id: head },
    { user: owner, state: 'CHANGES_REQUESTED', commit_id: head },
    { user: owner, state: 'COMMENTED', commit_id: head },
  ];
  assert.deepEqual(approvalStatus(approvedThenChanges, ['wbdevworld'], head).missing, [{ login: 'wbdevworld', reason: 'latest review is CHANGES_REQUESTED' }]);
  const changesThenApproved = [
    { user: owner, state: 'CHANGES_REQUESTED', commit_id: older },
    { user: owner, state: 'APPROVED', commit_id: head },
    { user: owner, state: 'COMMENTED', commit_id: head },
  ];
  assert.deepEqual(approvalStatus(changesThenApproved, ['wbdevworld'], head).approved, ['wbdevworld']);
});

test('a dismissed approval no longer counts', () => {
  const r = approvalStatus([{ user: owner, state: 'DISMISSED', commit_id: head }], ['wbdevworld'], head);
  assert.deepEqual(r.missing, [{ login: 'wbdevworld', reason: 'latest review is DISMISSED' }]);
});

test('approvals by anyone else, including the agent bot, never count', () => {
  const reviews = [
    { user: bot, state: 'APPROVED', commit_id: head },
    { user: { login: 'someone-else', type: 'User' }, state: 'APPROVED', commit_id: head },
    { user: null, state: 'APPROVED', commit_id: head },
  ];
  assert.deepEqual(approvalStatus(reviews, ['wbdevworld'], head).approved, []);
});
