import assert from 'node:assert/strict';
import test from 'node:test';

import {
  instantiateAgentTemplate,
  listAgentTemplates,
  previewAgentTemplate
} from '../src/lib/server/collaboration/agent-templates.js';

test('specialist templates expose bounded responsibilities and dependency warnings', () => {
  const preview = previewAgentTemplate('security-reviewer', {
    availableCapabilities: [],
    existingAgents: [{ name: 'Sentinel', roleLabel: 'Security reviewer', ambientTriggers: ['security'] }],
    name: 'Sentinel'
  });

  assert.equal(preview.template.version, 1);
  assert.equal(preview.template.permissionCeiling, 'read_only');
  assert.deepEqual(preview.disabledCapabilities, ['repository_read']);
  assert.deepEqual(preview.warnings, [
    'An Agent named Sentinel already exists.',
    'Ambient topic “security” overlaps with Sentinel.',
    'Role responsibilities overlap with Sentinel.'
  ]);
});

test('specialist templates do not include Support or General as automatic defaults', () => {
  assert.deepEqual(
    ['support', 'data-analyst', 'designer', 'security-reviewer']
      .map((key) => previewAgentTemplate(key, {
        availableCapabilities: [], existingAgents: []
      }).template.automatic),
    [false, false, false, false]
  );
});

test('template instantiation rejects name collisions before persistence', async () => {
  await assert.rejects(() => instantiateAgentTemplate({} as never, {} as never, 'designer', {
    availableCapabilities: ['design_assets'],
    existingAgents: [{ name: 'Designer', roleLabel: 'Another role', ambientTriggers: [] }]
  }), /already exists/);
});

test('template versions and permission ceilings are immutable catalog snapshots', () => {
  const first = listAgentTemplates();
  first[0]!.version = 99;
  first[0]!.permissionCeiling = 'repository_write';
  const second = listAgentTemplates();
  assert.equal(second[0]?.version, 1);
  assert.equal(second.find(({ key }) => key === 'support')?.permissionCeiling, 'none');
  assert.ok(second.every(({ permissionCeiling }) => permissionCeiling !== 'repository_write'));
});
