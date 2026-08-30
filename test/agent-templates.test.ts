import assert from 'node:assert/strict';
import test from 'node:test';

import { previewAgentTemplate } from '../src/lib/server/collaboration/agent-templates.js';

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
