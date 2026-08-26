import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { migrateDatabase } from '../src/lib/server/database/migrations.js';

const skipDatabaseTests = process.env.SKIP_DATABASE_TESTS === 'true';
const containers: StartedPostgreSqlContainer[] = [];

after(async () => {
  await Promise.all(containers.map((container) => container.stop()));
});

if (skipDatabaseTests) {
  test('the isolated backup restoration seam', { skip: 'SKIP_DATABASE_TESTS=true' });
} else {
  test('an off-host backup restores inspectable AgentRun and collaboration history in isolation', async () => {
    const source = await new PostgreSqlContainer('postgres:17-alpine').start();
    const restored = await new PostgreSqlContainer('postgres:17-alpine').start();
    containers.push(source, restored);
    const sourcePool = new Pool({ connectionString: source.getConnectionUri() });
    const restoredPool = new Pool({ connectionString: restored.getConnectionUri() });
    const backupDirectory = await mkdtemp(join(tmpdir(), 'relay-off-host-backup-'));

    try {
      await migrateDatabase(sourcePool);
      await seedInspectableHistory(sourcePool);

      runPostgresOperation('backup.sh', {
        DATABASE_URL: source.getConnectionUri(),
        BACKUP_DIRECTORY: '/backups'
      }, backupDirectory);

      const files = await readdir(backupDirectory);
      const backupName = files.find((name) => name.endsWith('.dump'));
      assert.ok(backupName);
      assert.ok(files.includes(`${backupName}.sha256`));

      runPostgresOperation('restore-drill.sh', {
        DATABASE_URL: source.getConnectionUri(),
        RESTORE_DATABASE_URL: restored.getConnectionUri(),
        BACKUP_FILE: `/backups/${backupName}`
      }, backupDirectory);

      const restoredHistory = await restoredPool.query<{
        run_id: string;
        status: string;
        message_body: string;
        event_summary: string;
      }>(`
        SELECT run.id AS run_id, run.status, message.body AS message_body,
               event.summary AS event_summary
        FROM public.agent_run run
        JOIN public.task task ON task.id = run.task_id
        JOIN public.message message ON message.id = task.source_message_id
        JOIN public.agent_run_event event ON event.agent_run_id = run.id
        WHERE run.id = 'run-backup-drill'
      `);
      assert.deepEqual(restoredHistory.rows, [{
        run_id: 'run-backup-drill',
        status: 'working',
        message_body: '@Alex preserve this collaboration history.',
        event_summary: 'Engineering request is working'
      }]);

      const report = JSON.parse(
        await readFile(join(backupDirectory, `${backupName}.restore-report.json`), 'utf8')
      ) as { agentRuns: number; agentRunEvents: number; messages: number };
      assert.deepEqual(report, { agentRuns: 1, agentRunEvents: 1, messages: 1 });
    } finally {
      await Promise.all([sourcePool.end(), restoredPool.end()]);
    }
  });
}

function runPostgresOperation(
  script: string,
  environment: Record<string, string>,
  backupDirectory: string
): void {
  const args = [
    'run', '--rm', '--network', 'host',
    '--volume', `${resolve('ops/postgres')}:/ops:ro`,
    '--volume', `${backupDirectory}:/backups`,
    ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    'postgres:17-alpine', 'sh', `/ops/${script}`
  ];
  execFileSync('docker', args, { stdio: 'pipe' });
}

async function seedInspectableHistory(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO auth."user" (id, name, email, "emailVerified")
      VALUES ('user-backup-drill', 'Owner', 'owner@example.com', true);
    INSERT INTO public.workspace (id, name)
      VALUES ('workspace-backup-drill', 'Backup drill workspace');
    INSERT INTO public.workspace_membership (id, workspace_id, user_id, role)
      VALUES ('membership-backup-drill', 'workspace-backup-drill', 'user-backup-drill', 'owner');
    INSERT INTO public.project (id, workspace_id, name)
      VALUES ('project-backup-drill', 'workspace-backup-drill', 'Relay');
    INSERT INTO public.agent (id, workspace_id, name, role_label)
      VALUES ('agent-backup-drill', 'workspace-backup-drill', 'Alex', 'Engineering agent');
    INSERT INTO public.channel (id, workspace_id, project_id, name)
      VALUES ('channel-backup-drill', 'workspace-backup-drill', 'project-backup-drill', 'agent-work');
    INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
      VALUES ('pilot-backup-drill', 'workspace-backup-drill', 'pilot', 'membership-backup-drill');
    INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
      VALUES ('agent-member-backup-drill', 'workspace-backup-drill', 'agent', 'agent-backup-drill');
    INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
      VALUES ('workspace-backup-drill', 'project-backup-drill', 'pilot-backup-drill'),
             ('workspace-backup-drill', 'project-backup-drill', 'agent-member-backup-drill');
    INSERT INTO public.message (
      id, workspace_id, channel_id, author_workspace_member_id, body,
      agent_mention_status, mentioned_agent_id
    ) VALUES (
      'message-backup-drill', 'workspace-backup-drill', 'channel-backup-drill',
      'pilot-backup-drill', '@Alex preserve this collaboration history.',
      'accepted', 'agent-backup-drill'
    );
    INSERT INTO public.provider_connection (
      id, workspace_id, owner_membership_id, status, credential_store_reference, connected_at
    ) VALUES (
      'provider-backup-drill', 'workspace-backup-drill', 'membership-backup-drill',
      'ready', 'managed-login', now()
    );
    INSERT INTO public.github_connection (
      id, workspace_id, owner_membership_id, app_id, installation_id, status
    ) VALUES (
      'github-backup-drill', 'workspace-backup-drill', 'membership-backup-drill',
      '17', '101', 'active'
    );
    INSERT INTO public.linked_repository (
      id, workspace_id, project_id, github_connection_id, repository_id,
      repository_node_id, owner_node_id, repository_owner, repository_name,
      default_branch, ready_for_autonomous_work, verification
    ) VALUES (
      'repository-backup-drill', 'workspace-backup-drill', 'project-backup-drill',
      'github-backup-drill', '202', 'R_202', 'O_303', 'relay-owner', 'pilot',
      'main', true, '{}'
    );
    INSERT INTO public.task (
      id, workspace_id, project_id, assigned_agent_id, source_message_id,
      requested_by_workspace_member_id, request_snapshot, context_snapshot
    ) VALUES (
      'task-backup-drill', 'workspace-backup-drill', 'project-backup-drill',
      'agent-backup-drill', 'message-backup-drill', 'pilot-backup-drill',
      '@Alex preserve this collaboration history.', '{}'
    );
    INSERT INTO public.agent_run (
      id, workspace_id, task_id, agent_id, provider_connection_id,
      linked_repository_id, status, requested_by_workspace_member_id, request_message_id
    ) VALUES (
      'run-backup-drill', 'workspace-backup-drill', 'task-backup-drill',
      'agent-backup-drill', 'provider-backup-drill', 'repository-backup-drill',
      'working', 'pilot-backup-drill', 'message-backup-drill'
    );
    INSERT INTO public.agent_run_event (
      workspace_id, agent_run_id, sequence, event_type, status, summary
    ) VALUES (
      'workspace-backup-drill', 'run-backup-drill', 1,
      'run.working', 'working', 'Engineering request is working'
    );
  `);
}
