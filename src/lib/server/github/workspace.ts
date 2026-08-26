import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

import type { PullRequestPublication } from '../collaboration/pull-request-result.js';
import { executeGitHubBrokerOperation, type GitHubBrokerRemote } from './broker.js';
import type { GitHubFileMode } from './broker-policy.js';

const executeFile = promisify(execFile);

interface AgentRunRepositoryContext {
  workspace_id: string;
  task_id: string;
  project_id: string;
  attempt_number: number;
  repository_id: string;
  actor_workspace_member_id: string;
  root_message_id: string;
  channel_id: string;
}

export interface PreparedAgentRunRepository {
  baseCommitSha: string;
  assignedBranch: string;
  originalFiles: Map<string, WorkspaceFileSnapshot>;
}

export interface WorkspaceFileSnapshot {
  content: string;
  mode: GitHubFileMode;
}

export class AgentRunGitHubWorkspaceBroker {
  constructor(private readonly pool: Pool, private readonly remote: GitHubBrokerRemote) {}

  async prepare(agentRunId: string, workspaceDirectory: string): Promise<PreparedAgentRunRepository> {
    const context = await this.context(agentRunId);
    const common = this.commonRequest(agentRunId, context);
    const clone = await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...common,
      operation: 'clone'
    });
    if (!clone.result.commitSha || !clone.result.files) {
      throw new Error('GitHub broker clone omitted repository content');
    }
    for (const entry of await readdir(workspaceDirectory)) {
      await rm(safeWorkspacePath(workspaceDirectory, entry), { recursive: true, force: true });
    }
    const originalFiles = new Map<string, WorkspaceFileSnapshot>();
    for (const file of clone.result.files) {
      const target = safeWorkspacePath(workspaceDirectory, file.path);
      await mkdir(dirname(target), { recursive: true });
      const mode = file.mode ?? '100644';
      await writeFile(target, Buffer.from(file.content, 'base64'), {
        mode: mode === '100755' ? 0o700 : 0o600
      });
      originalFiles.set(file.path, { content: file.content, mode });
    }
    await initializeCredentialFreeGitWorkspace(workspaceDirectory, clone.decision.assignedBranch);
    const branch = await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...common,
      operation: 'create_branch',
      branch: clone.decision.assignedBranch,
      commitSha: clone.result.commitSha
    });
    return {
      baseCommitSha: branch.result.commitSha ?? clone.result.commitSha,
      assignedBranch: clone.decision.assignedBranch,
      originalFiles
    };
  }

  async resume(agentRunId: string): Promise<PreparedAgentRunRepository> {
    const context = await this.context(agentRunId);
    const clone = await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...this.commonRequest(agentRunId, context),
      operation: 'clone'
    });
    if (!clone.result.commitSha || !clone.result.files) {
      throw new Error('GitHub broker clone omitted repository content');
    }
    return {
      baseCommitSha: clone.result.commitSha,
      assignedBranch: clone.decision.assignedBranch,
      originalFiles: new Map(clone.result.files.map(({ path, content, mode }) => [
        path,
        { content, mode: mode ?? '100644' }
      ]))
    };
  }

  async publish(
    agentRunId: string,
    workspaceDirectory: string,
    prepared: PreparedAgentRunRepository
  ): Promise<PullRequestPublication> {
    const context = await this.context(agentRunId);
    const common = this.commonRequest(agentRunId, context);
    const changedFiles = await collectWorkspaceChanges(
      workspaceDirectory,
      prepared.originalFiles
    );
    if (changedFiles.length === 0) throw new Error('AgentRun completed without repository changes');

    const commit = await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...common,
      operation: 'commit',
      branch: prepared.assignedBranch,
      commitSha: prepared.baseCommitSha,
      commitMessage: `Relay AgentRun ${agentRunId}`,
      files: changedFiles
    });
    if (!commit.result.commitSha) throw new Error('GitHub broker commit omitted its SHA');
    await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...common,
      operation: 'update_branch',
      branch: prepared.assignedBranch,
      commitSha: commit.result.commitSha
    });
    const pullRequest = await executeGitHubBrokerOperation(this.pool, this.remote, {
      ...common,
      operation: 'pull_request_upsert',
      branch: prepared.assignedBranch,
      pullRequestTitle: `Relay AgentRun ${agentRunId}`,
      pullRequestBody: 'Created by the Relay engineering Agent for human review.'
    });
    if (!pullRequest.result.pullRequestNumber || !pullRequest.result.pullRequestUrl) {
      throw new Error('GitHub broker pull request response was incomplete');
    }
    return {
      workspaceId: context.workspace_id,
      projectId: context.project_id,
      taskId: context.task_id,
      agentRunId,
      repositoryId: context.repository_id,
      actorWorkspaceMemberId: context.actor_workspace_member_id,
      rootMessageId: context.root_message_id,
      channelId: context.channel_id,
      branch: prepared.assignedBranch,
      commitSha: commit.result.commitSha,
      pullRequestNumber: pullRequest.result.pullRequestNumber,
      pullRequestUrl: pullRequest.result.pullRequestUrl
    };
  }

  private async context(agentRunId: string): Promise<AgentRunRepositoryContext> {
    const result = await this.pool.query<AgentRunRepositoryContext>(
      `SELECT run.workspace_id, run.task_id, task.project_id, run.attempt_number,
              repository.repository_id,
              agent_member.id AS actor_workspace_member_id,
              COALESCE(source.parent_message_id, source.id) AS root_message_id,
              source.channel_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
       JOIN public.message source
         ON source.id = task.source_message_id AND source.workspace_id = run.workspace_id
       JOIN public.linked_repository repository
         ON repository.id = run.linked_repository_id
        AND repository.workspace_id = run.workspace_id
       JOIN public.workspace_member agent_member
         ON agent_member.agent_id = run.agent_id
        AND agent_member.workspace_id = run.workspace_id
       WHERE run.id = $1`,
      [agentRunId]
    );
    const context = result.rows[0];
    if (!context) throw new Error('AgentRun repository context is unavailable');
    return context;
  }

  private commonRequest(agentRunId: string, context: AgentRunRepositoryContext) {
    return {
      repositoryId: context.repository_id,
      agentRunId,
      attemptNumber: context.attempt_number,
      actorWorkspaceMemberId: context.actor_workspace_member_id
    };
  }
}

function safeWorkspacePath(root: string, path: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, path);
  if (!target.startsWith(`${rootPath}${sep}`)) throw new Error('GitHub path escaped AgentRun workspace');
  return target;
}

export async function collectWorkspaceChanges(
  root: string,
  originalFiles: Map<string, WorkspaceFileSnapshot>
): Promise<Array<{
  path: string;
  content: string | null;
  encoding: 'base64';
  mode: GitHubFileMode;
}>> {
  const currentFiles = await readWorkspaceFiles(root);
  const changedFiles: Array<{
    path: string;
    content: string | null;
    encoding: 'base64';
    mode: GitHubFileMode;
  }> = [];
  for (const [path, file] of currentFiles) {
    const original = originalFiles.get(path);
    if (!original || original.content !== file.content || original.mode !== file.mode) {
      changedFiles.push({ path, ...file, encoding: 'base64' });
    }
  }
  for (const [path, file] of originalFiles) {
    if (!currentFiles.has(path)) {
      changedFiles.push({ path, content: null, encoding: 'base64', mode: file.mode });
    }
  }
  return changedFiles;
}

async function readWorkspaceFiles(root: string): Promise<Map<string, WorkspaceFileSnapshot>> {
  const files = new Map<string, WorkspaceFileSnapshot>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = safeWorkspacePath(root, path);
      if (entry.isDirectory()) await visit(absolute, path);
      else {
        const metadata = await lstat(absolute);
        if (!metadata.isFile()) throw new Error('AgentRun workspace contains an unsupported file type');
        files.set(path, {
          content: (await readFile(absolute)).toString('base64'),
          mode: metadata.mode & 0o111 ? '100755' : '100644'
        });
      }
    }
  };
  await visit(root, '');
  return files;
}

async function initializeCredentialFreeGitWorkspace(root: string, branch: string): Promise<void> {
  await executeFile('git', ['init', '--quiet'], { cwd: root });
  await executeFile('git', ['config', 'user.name', 'Relay engineering Agent'], { cwd: root });
  await executeFile('git', ['config', 'user.email', 'relay-agent@localhost'], { cwd: root });
  await executeFile('git', ['add', '--all'], { cwd: root });
  await executeFile('git', ['commit', '--quiet', '-m', 'Relay broker base snapshot'], { cwd: root });
  await executeFile('git', ['branch', '-M', branch], { cwd: root });
}
