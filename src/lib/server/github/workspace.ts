import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

import { executeGitHubBrokerOperation, type GitHubBrokerRemote } from './broker.js';

const executeFile = promisify(execFile);

interface AgentRunRepositoryContext {
  workspace_id: string;
  task_id: string;
  project_id: string;
  attempt_number: number;
  repository_id: string;
  actor_workspace_member_id: string;
}

export interface PreparedAgentRunRepository {
  baseCommitSha: string;
  assignedBranch: string;
  originalFiles: Map<string, string>;
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
    const originalFiles = new Map<string, string>();
    for (const file of clone.result.files) {
      const target = safeWorkspacePath(workspaceDirectory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.content, 'base64'), { mode: 0o600 });
      originalFiles.set(file.path, file.content);
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
      originalFiles: new Map(clone.result.files.map(({ path, content }) => [path, content]))
    };
  }

  async publish(
    agentRunId: string,
    workspaceDirectory: string,
    prepared: PreparedAgentRunRepository
  ): Promise<{ commitSha: string; pullRequestNumber: number; pullRequestUrl: string }> {
    const context = await this.context(agentRunId);
    const common = this.commonRequest(agentRunId, context);
    const currentFiles = await readWorkspaceFiles(workspaceDirectory);
    const changedFiles: Array<{
      path: string;
      content: string | null;
      encoding: 'base64';
    }> = [];
    for (const [path, content] of currentFiles) {
      if (prepared.originalFiles.get(path) !== content) {
        changedFiles.push({ path, content, encoding: 'base64' });
      }
    }
    for (const path of prepared.originalFiles.keys()) {
      if (!currentFiles.has(path)) changedFiles.push({ path, content: null, encoding: 'base64' });
    }
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
    await this.pool.query(
      `INSERT INTO public.artifact (
         id, workspace_id, project_id, task_id, agent_run_id, kind,
         repository_id, branch, commit_sha, pull_request_number, url
       ) VALUES ($1, $2, $3, $4, $5, 'github_pull_request', $6, $7, $8, $9, $10)
       ON CONFLICT (agent_run_id) DO NOTHING`,
      [
        randomUUID(), context.workspace_id, context.project_id, context.task_id, agentRunId,
        context.repository_id, prepared.assignedBranch, commit.result.commitSha,
        pullRequest.result.pullRequestNumber, pullRequest.result.pullRequestUrl
      ]
    );
    return {
      commitSha: commit.result.commitSha,
      pullRequestNumber: pullRequest.result.pullRequestNumber,
      pullRequestUrl: pullRequest.result.pullRequestUrl
    };
  }

  private async context(agentRunId: string): Promise<AgentRunRepositoryContext> {
    const result = await this.pool.query<AgentRunRepositoryContext>(
      `SELECT run.workspace_id, run.task_id, task.project_id, run.attempt_number,
              repository.repository_id,
              agent_member.id AS actor_workspace_member_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
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

async function readWorkspaceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = safeWorkspacePath(root, path);
      if (entry.isDirectory()) await visit(absolute, path);
      else {
        const metadata = await lstat(absolute);
        if (!metadata.isFile()) throw new Error('AgentRun workspace contains an unsupported file type');
        files.set(path, (await readFile(absolute)).toString('base64'));
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
