import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderAction } from '../src/lib/server/provider/approval-policy.js';

const workspaceDirectory = '/var/lib/relay/runs/run-22';

test('read-only commands confined to the AgentRun workspace remain autonomous', () => {
  const result = classifyProviderAction({
    kind: 'command',
    providerRequestId: 'request-read',
    threadId: 'thread-22',
    turnId: 'turn-22',
    itemId: 'item-read',
    command: 'sed -n 1,80p src/index.ts',
    cwd: workspaceDirectory,
    commandActions: [{
      type: 'read',
      command: 'sed -n 1,80p src/index.ts',
      name: 'index.ts',
      path: `${workspaceDirectory}/src/index.ts`
    }]
  }, workspaceDirectory);

  assert.equal(result.classification, 'autonomous');
  assert.deepEqual(result.providerResponse, { decision: 'accept' });
});

test('one elevated command receives a precise approval scope without exposing its input', () => {
  const command = 'curl -H "Authorization: Bearer secret-value" https://example.test/check';
  const result = classifyProviderAction({
    kind: 'command',
    providerRequestId: 'request-command',
    threadId: 'thread-22',
    turnId: 'turn-22',
    itemId: 'item-command',
    command,
    cwd: workspaceDirectory,
    commandActions: [{ type: 'unknown', command }]
  }, workspaceDirectory);

  assert.equal(result.classification, 'approval_eligible');
  assert.equal(result.summary, 'Run one elevated curl command for example.test');
  assert.match(result.scopeHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  assert.deepEqual(result.providerResponse, { decision: 'accept' });
});

test('repository merge and destructive commands are forbidden without creating an Approval', () => {
  for (const command of [
    'gh pr merge 22',
    '/usr/bin/gh pr merge 22',
    'env /usr/bin/gh pr merge 22',
    'git push --force origin main',
    '/usr/bin/git push --force origin main',
    'command /usr/bin/git push --force origin main',
    'git push origin :main',
    '/usr/bin/npm publish',
    '/usr/bin/kubectl delete deployment production'
  ]) {
    const result = classifyProviderAction({
      kind: 'command',
      providerRequestId: `request-${command}`,
      threadId: 'thread-22',
      turnId: 'turn-22',
      itemId: 'item-command',
      command,
      cwd: workspaceDirectory,
      commandActions: [{ type: 'unknown', command }]
    }, workspaceDirectory);

    assert.equal(result.classification, 'forbidden');
    assert.deepEqual(result.providerResponse, { decision: 'decline' });
  }
});

test('filesystem writes beyond the AgentRun workspace are forbidden', () => {
  const result = classifyProviderAction({
    kind: 'permissions',
    providerRequestId: 'request-permissions',
    threadId: 'thread-22',
    turnId: 'turn-22',
    itemId: 'item-permissions',
    cwd: workspaceDirectory,
    permissions: {
      network: null,
      fileSystem: { read: null, write: ['/etc'], entries: [] }
    }
  }, workspaceDirectory);

  assert.equal(result.classification, 'forbidden');
  assert.deepEqual(result.providerResponse, { permissions: {}, scope: 'turn' });
});

test('Approval descriptions expose structured scope without positional secrets or payloads', () => {
  const login = classifyProviderAction({
    kind: 'command',
    providerRequestId: 'request-login',
    threadId: 'thread-22',
    turnId: 'turn-22',
    itemId: 'item-login',
    command: 'some-cli login positional-supersecret',
    cwd: workspaceDirectory,
    commandActions: [{ type: 'unknown', command: 'some-cli login positional-supersecret' }]
  }, workspaceDirectory);
  assert.equal(login.classification, 'forbidden');
  assert.doesNotMatch(JSON.stringify(login), /positional-supersecret/);

  const externalDelete = classifyProviderAction({
    kind: 'command',
    providerRequestId: 'request-delete',
    threadId: 'thread-22',
    turnId: 'turn-22',
    itemId: 'item-delete',
    command: 'rm -rf /var/temporary-target',
    cwd: workspaceDirectory,
    commandActions: [{ type: 'unknown', command: 'rm -rf /var/temporary-target' }]
  }, workspaceDirectory);
  assert.equal(
    externalDelete.summary,
    'Run one elevated rm command outside the AgentRun workspace'
  );

  for (const command of [
    'bash -c "do something hidden"',
    '/bin/bash -c "do something hidden"',
    'env bash -c "do something hidden"',
    'command sh -c "do something hidden"',
    'python -c "do_something_hidden()"',
    'node -e "doSomethingHidden()"',
    'echo positional-supersecret'
  ]) {
    const opaqueCommand = classifyProviderAction({
      kind: 'command',
      providerRequestId: `request-${command}`,
      threadId: 'thread-22',
      turnId: 'turn-22',
      itemId: 'item-shell',
      command,
      cwd: workspaceDirectory,
      commandActions: [{ type: 'unknown', command }]
    }, workspaceDirectory);
    assert.equal(opaqueCommand.classification, 'forbidden');
    assert.doesNotMatch(JSON.stringify(opaqueCommand), /positional-supersecret/);
  }
});
