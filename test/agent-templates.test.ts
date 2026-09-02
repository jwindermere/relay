import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAgentTemplatePermissionCeiling,
  findAgentTemplateUpgrade,
  instantiateAgentTemplate,
  listAgentTemplates,
  loadAvailableAgentTemplateCapabilities,
  previewAgentTemplate,
  renderAgentTemplateExecutionBounds
} from '../src/lib/server/collaboration/agent-templates.js';

test('specialist Agent templates expose bounded responsibilities and dependency warnings', () => {
  const preview = previewAgentTemplate('security-reviewer', {
    availableCapabilities: [],
    existingAgents: [{ name: 'Sentinel', roleLabel: 'Security reviewer', ambientTriggers: ['security'] }],
    name: 'Sentinel'
  });

  assert.equal(preview.template.version, 2);
  assert.equal(preview.template.permissionCeiling, 'read_only');
  assert.deepEqual(preview.disabledCapabilities, ['repository_read']);
  assert.deepEqual(preview.warnings, [
    'An Agent named Sentinel already exists.',
    'Ambient topic “security” overlaps with Sentinel.',
    'Role responsibilities overlap with Sentinel.'
  ]);
});

test('specialist Agent templates do not include Support or General as automatic defaults', () => {
  assert.deepEqual(
    ['support', 'data-analyst', 'designer', 'security-reviewer']
      .map((key) => previewAgentTemplate(key, {
        availableCapabilities: [], existingAgents: []
      }).template.automatic),
    [false, false, false, false]
  );
});

test('latest Agent template versions declare when the specialist must stay silent', () => {
  const templates = listAgentTemplates();

  assert.ok(templates.every(({ version }) => version === 2));
  assert.ok(templates.every(({ staySilentWhen }) => staySilentWhen.length > 0));
  assert.match(
    templates.find(({ key }) => key === 'support')?.staySilentWhen.join(' ') ?? '',
    /resolved|internal/i
  );
});

test('Agent template version upgrades are visible without changing existing provenance', () => {
  const provenance = { key: 'support', version: 1 };

  assert.deepEqual(findAgentTemplateUpgrade(provenance), {
    key: 'support', fromVersion: 1, toVersion: 2
  });
  assert.deepEqual(provenance, { key: 'support', version: 1 });
  assert.equal(findAgentTemplateUpgrade({ key: 'support', version: 2 }), null);
});

test('customized responsibilities and ambient topics are checked before creation', () => {
  const preview = previewAgentTemplate('designer', {
    availableCapabilities: ['design_assets'],
    existingAgents: [{
      name: 'Maya', roleLabel: 'Product strategy', ambientTriggers: ['onboarding']
    }],
    roleLabel: 'Product strategy',
    ambientTriggers: ['Onboarding', 'journey']
  });

  assert.deepEqual(preview.warnings, [
    'Ambient topic “Onboarding” overlaps with Maya.',
    'Role responsibilities overlap with Maya.'
  ]);
});

test('responsibility overlap detects shared specialist concerns, not only identical labels', () => {
  const preview = previewAgentTemplate('data-analyst', {
    availableCapabilities: ['project_data'],
    existingAgents: [{
      name: 'Riley', roleLabel: 'Research analyst', ambientTriggers: []
    }]
  });

  assert.deepEqual(preview.warnings, ['Role responsibilities overlap with Riley.']);
});

test('Agent template execution bounds make outputs, silence, dependencies, and ceilings enforceable', () => {
  const bounds = renderAgentTemplateExecutionBounds({
    expectedResultShapes: ['structured_finding'],
    nonResponsibilities: ['Repository changes'],
    staySilentWhen: ['No authorised evidence supports the question'],
    disabledCapabilities: ['repository_read'],
    permissionCeiling: 'read_only'
  });

  assert.match(bounds, /final fenced relay-finding JSON object/);
  assert.match(bounds, /Do not take responsibility for: Repository changes/);
  assert.match(bounds, /ambient turn.*No authorised evidence supports the question/i);
  assert.match(bounds, /Unavailable capabilities.*repository_read/i);
  assert.match(bounds, /read-only permission ceiling/i);
});

test('Agent template permission ceilings cannot be broadened through customization', () => {
  assert.doesNotThrow(() => assertAgentTemplatePermissionCeiling('general', 'read_only'));
  assert.throws(
    () => assertAgentTemplatePermissionCeiling('engineering', 'read_only'),
    /permission ceiling/i
  );
  assert.throws(
    () => assertAgentTemplatePermissionCeiling('engineering', 'none'),
    /permission ceiling/i
  );
});

test('Agent template instantiation rejects name collisions before persistence', async () => {
  await assert.rejects(() => instantiateAgentTemplate({} as never, {} as never, 'designer', {
    availableCapabilities: ['design_assets'],
    existingAgents: [{ name: 'Designer', roleLabel: 'Another role', ambientTriggers: [] }]
  }), /already exists/);
});

test('Agent template capabilities expose only authorised Project data and integrations', async () => {
  const queries: unknown[][] = [];
  const pool = {
    async query(_statement: string, parameters: unknown[]) {
      queries.push(parameters);
      return queries.length === 1
        ? { rows: [{ id: 'project-1' }] }
        : { rows: [{ available: true }] };
    }
  };

  const capabilities = await loadAvailableAgentTemplateCapabilities(
    pool as never,
    { workspace: { id: 'workspace-1' } } as never
  );

  assert.deepEqual(capabilities, ['project_data', 'repository_read']);
  assert.deepEqual(queries, [['workspace-1'], ['workspace-1', 'project-1']]);
});

test('Agent template versions and permission ceilings are immutable catalog snapshots', () => {
  const first = listAgentTemplates();
  first[0]!.version = 99;
  first[0]!.permissionCeiling = 'repository_write';
  const second = listAgentTemplates();
  assert.equal(second[0]?.version, 2);
  assert.equal(second.find(({ key }) => key === 'support')?.permissionCeiling, 'none');
  assert.ok(second.every(({ permissionCeiling }) => permissionCeiling !== 'repository_write'));
});
