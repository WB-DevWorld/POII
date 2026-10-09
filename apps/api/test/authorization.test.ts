import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, capabilitiesOf, requireCapability, type AuthorizableActor, type Capability } from '../src/authorization/authorization.js';
import { AppError } from '../src/common/errors.js';

const owner: AuthorizableActor = { kind: 'person', authority: 'owner', revokedAt: null };
const delegated: AuthorizableActor = { kind: 'person', authority: 'delegated', revokedAt: null };
const plainPerson: AuthorizableActor = { kind: 'person', authority: null, revokedAt: null };
const token: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null };
const revokedToken: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: new Date() };
const assistant: AuthorizableActor = { kind: 'ai_assistant', authority: null, revokedAt: null };
const system: AuthorizableActor = { kind: 'system', authority: null, revokedAt: null };
const revokedOwner: AuthorizableActor = { kind: 'person', authority: 'owner', revokedAt: new Date() };

const all: Capability[] = ['read', 'propose', 'confirm', 'delete'];

function code(actor: AuthorizableActor, capability: Capability): string | null {
  try {
    requireCapability(actor, capability);
    return null;
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 403);
    return error.code;
  }
}

test('authorization: a person with authority holds every capability', () => {
  for (const actor of [owner, delegated]) for (const c of all) assert.equal(code(actor, c), null);
  assert.deepEqual(capabilitiesOf(owner), { read: true, propose: true, confirm: true, delete: true });
});

test('authorization: an agent token reads and proposes but never confirms or deletes', () => {
  assert.equal(code(token, 'read'), null);
  assert.equal(code(token, 'propose'), null);
  assert.equal(code(token, 'confirm'), 'authority_required');
  assert.equal(code(token, 'delete'), 'authority_required');
});

test('authorization: AI actors, the system actor and persons without authority are denied', () => {
  for (const actor of [assistant, system, plainPerson]) {
    for (const c of all) {
      assert.equal(can(actor, c), false);
      assert.equal(code(actor, c), 'forbidden');
    }
  }
});

test('authorization: revocation takes effect immediately', () => {
  for (const actor of [revokedToken, revokedOwner]) for (const c of all) assert.equal(code(actor, c), 'forbidden');
});
