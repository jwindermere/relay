import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ProviderRequestBoundary } from './agent-run.js';

type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };

interface FileSystemPermissions {
  read: string[] | null;
  write: string[] | null;
  entries?: Array<Record<string, unknown>>;
}

interface PermissionProfile {
  network: { enabled: boolean | null } | null;
  fileSystem: FileSystemPermissions | null;
}

export type ProviderActionRequest = ProviderRequestBoundary & (
  | {
      kind: 'command';
      command: string | null;
      cwd: string | null;
      commandActions: CommandAction[] | null;
      networkHost?: string | null;
    }
  | { kind: 'file_change'; grantRoot: string | null }
  | { kind: 'permissions'; cwd: string; permissions: PermissionProfile }
);

export type ProviderApprovalResponse =
  | { decision: 'accept' | 'decline' }
  | { permissions: PermissionProfile | Record<string, never>; scope: 'turn' };

export interface ClassifiedProviderAction {
  classification: 'autonomous' | 'approval_eligible' | 'forbidden';
  actionKind: ProviderActionRequest['kind'];
  scopeHash: string;
  summary: string;
  providerResponse: ProviderApprovalResponse;
}

const FORBIDDEN_COMMANDS = [
  /(?:^|\s)git\s+push(?:\s+[^\n]*)?\s(?:--force(?:-with-lease)?|-f)(?:\s|$)/i,
  /(?:^|\s)git\s+push\s+[^\n]*\s:[^\s]+/i,
  /(?:^|\s)gh\s+pr\s+merge(?:\s|$)/i,
  /(?:^|\s)gh\s+(?:repo|release|workflow|secret|variable|api)(?:\s|$)/i,
  /(?:^|\s)(?:kubectl|terraform)\s+(?:apply|destroy|delete)(?:\s|$)/i,
  /(?:^|\s)npm\s+publish(?:\s|$)/i,
  /(?:^|\s)(?:\/[a-zA-Z0-9_./-]+\/)?(?:bash|sh|zsh|fish|pwsh|powershell)\s+(?:-[a-z]*c\b|--command\b|-command\b)/i,
  /(?:^|\s)(?:\/[a-zA-Z0-9_./-]+\/)?(?:python\d*|node|ruby|perl|php)\s+(?:-c\b|-e\b)/i,
  /^\s*(?:sudo|eval)(?:\s|$)/i
];

const SAFE_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  cargo: new Set(['build', 'check', 'test']),
  gh: new Set(['issue', 'pr']),
  git: new Set([
    'add', 'branch', 'checkout', 'commit', 'diff', 'fetch', 'log', 'pull', 'push',
    'restore', 'show', 'status', 'switch'
  ]),
  npm: new Set(['build', 'install', 'pack', 'run', 'test']),
  pnpm: new Set(['build', 'install', 'pack', 'run', 'test']),
  yarn: new Set(['build', 'install', 'pack', 'run', 'test'])
});

export function classifyProviderAction(
  request: ProviderActionRequest,
  workspaceDirectory: string
): ClassifiedProviderAction {
  const scopeHash = createHash('sha256')
    .update(stableJson(request))
    .digest('hex');

  if (request.kind === 'command') {
    const policyCommand = normalizePathQualifiedTokens(request.command);
    if (policyCommand && FORBIDDEN_COMMANDS.some((pattern) => pattern.test(policyCommand))) {
      return classified('forbidden', request.kind, scopeHash, 'Blocked unsafe command', {
        decision: 'decline'
      });
    }
    if (isConfinedReadOnlyCommand(request, workspaceDirectory)) {
      return classified('autonomous', request.kind, scopeHash, 'Read AgentRun workspace', {
        decision: 'accept'
      });
    }
    if (!canDescribeCommandSafely(request, workspaceDirectory)) {
      return classified('forbidden', request.kind, scopeHash, 'Blocked opaque command request', {
        decision: 'decline'
      });
    }
    return classified(
      'approval_eligible',
      request.kind,
      scopeHash,
      commandSummary(request, workspaceDirectory),
      {
      decision: 'accept'
      }
    );
  }

  if (request.kind === 'file_change') {
    if (request.grantRoot && isWithin(workspaceDirectory, request.grantRoot)) {
      return classified('autonomous', request.kind, scopeHash, 'Write AgentRun workspace', {
        decision: 'accept'
      });
    }
    return classified('forbidden', request.kind, scopeHash, 'Blocked write outside AgentRun workspace', {
      decision: 'decline'
    });
  }

  if (hasWriteOutsideWorkspace(request.permissions.fileSystem, workspaceDirectory)) {
    return classified('forbidden', request.kind, scopeHash, 'Blocked write outside AgentRun workspace', {
      permissions: {}, scope: 'turn'
    });
  }
  if (!request.permissions.network?.enabled
    && hasOnlyWorkspaceReads(request.permissions.fileSystem, workspaceDirectory)) {
    return classified('autonomous', request.kind, scopeHash, 'Read AgentRun workspace', {
      permissions: request.permissions, scope: 'turn'
    });
  }
  return classified('forbidden', request.kind, scopeHash,
    'Blocked turn-wide permission request', { permissions: {}, scope: 'turn' });
}

function normalizePathQualifiedTokens(command: string | null): string | undefined {
  if (!command) return undefined;
  return command.replace(
    /(^|\s)(["']?)(\/[a-zA-Z0-9_./-]+)\2(?=\s|$)/g,
    (_match, leading, _quote, path) => {
      const basename = String(path).split('/').at(-1) ?? path;
      return `${leading}${basename}`;
    }
  );
}

function classified(
  classification: ClassifiedProviderAction['classification'],
  actionKind: ClassifiedProviderAction['actionKind'],
  scopeHash: string,
  summary: string,
  providerResponse: ProviderApprovalResponse
): ClassifiedProviderAction {
  return { classification, actionKind, scopeHash, summary, providerResponse };
}

function commandSummary(
  request: Extract<ProviderActionRequest, { kind: 'command' }>,
  workspaceDirectory: string
): string {
  const executable = readExecutable(request.command);
  const operation = readSafeOperation(executable, request.command);
  const host = readSafeHost(request.networkHost) ?? readCommandHost(request.command);
  const boundary = readTargetBoundary(request.command, workspaceDirectory);
  return [
    `Run one elevated ${executable}`,
    operation ? `${operation} operation` : 'command',
    host ? `for ${host}` : undefined,
    boundary
  ].filter(Boolean).join(' ').slice(0, 200);
}

function readExecutable(command: string | null): string {
  const candidate = command?.trim().split(/\s+/, 1)[0]?.split('/').at(-1);
  return candidate && /^[a-zA-Z0-9._+-]{1,40}$/.test(candidate) ? candidate : 'shell';
}

function readSafeOperation(executable: string, command: string | null): string | undefined {
  const candidate = command?.trim().split(/\s+/)[1];
  return candidate && SAFE_OPERATIONS[executable]?.has(candidate) ? candidate : undefined;
}

function canDescribeCommandSafely(
  request: Extract<ProviderActionRequest, { kind: 'command' }>,
  workspaceDirectory: string
): boolean {
  const executable = readExecutable(request.command);
  return Boolean(
    readSafeOperation(executable, request.command)
      || readSafeHost(request.networkHost)
      || readCommandHost(request.command)
      || readTargetBoundary(request.command, workspaceDirectory)
  );
}

function readTargetBoundary(
  command: string | null,
  workspaceDirectory: string
): string | undefined {
  const paths = command?.match(/(?:^|\s)["']?(\/[a-zA-Z0-9_./-]+)["']?(?=\s|$)/g)
    ?.map((value) => value.trim().replace(/^["']|["']$/g, '')) ?? [];
  if (paths.some((path) => !isWithin(workspaceDirectory, path))) {
    return 'outside the AgentRun workspace';
  }
  if (paths.length > 0) return 'inside the AgentRun workspace';
  return undefined;
}

function readSafeHost(value: string | null | undefined): string | undefined {
  return value && /^[a-zA-Z0-9.-]{1,100}$/.test(value) ? value.toLowerCase() : undefined;
}

function readCommandHost(command: string | null): string | undefined {
  const url = command?.match(/https?:\/\/[^\s"']+/i)?.[0];
  if (!url) return undefined;
  try {
    return readSafeHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function isConfinedReadOnlyCommand(
  request: Extract<ProviderActionRequest, { kind: 'command' }>,
  workspaceDirectory: string
): boolean {
  if (!request.commandActions?.length) return false;
  return request.commandActions.every((action) => {
    if (action.type === 'unknown') return false;
    if (!action.path) return request.cwd ? isWithin(workspaceDirectory, request.cwd) : false;
    return isWithin(workspaceDirectory, action.path);
  });
}

function hasWriteOutsideWorkspace(
  permissions: FileSystemPermissions | null,
  workspaceDirectory: string
): boolean {
  if (!permissions) return false;
  if ((permissions.entries?.length ?? 0) > 0) return true;
  return (permissions.write ?? []).some((path) => !isWithin(workspaceDirectory, path));
}

function hasOnlyWorkspaceReads(
  permissions: FileSystemPermissions | null,
  workspaceDirectory: string
): boolean {
  if (!permissions) return true;
  return (permissions.read ?? []).every((path) => isWithin(workspaceDirectory, path))
    && (permissions.write ?? []).every((path) => isWithin(workspaceDirectory, path))
    && (permissions.entries?.length ?? 0) === 0;
}

function isWithin(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = isAbsolute(candidate) ? resolve(candidate) : resolve(rootPath, candidate);
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
