import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  ManagedCodexRuntime,
  ManagedLoginCompletion
} from './connection.js';

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ProtocolMessage {
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: Record<string, unknown>;
}

export class CodexProtocolError extends Error {
  constructor(readonly method: string, readonly protocolError: ProtocolMessage['error']) {
    super(`${method} failed${protocolError?.message ? `: ${protocolError.message}` : ''}`);
    this.name = 'CodexProtocolError';
  }
}

export interface CodexAppServerSession {
  onNotification?: (message: ProtocolMessage) => void;
  onRequest?: (message: ProtocolMessage & { id: string | number; method: string }) => void;
  onFailure?: (error: Error) => void;
  initialize(): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  respond?(id: string | number, result: unknown): Promise<void>;
  close(): void;
}

class ChildProcessCodexAppServerSession implements CodexAppServerSession {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private closed = false;
  onNotification?: (message: ProtocolMessage) => void;
  onRequest?: (message: ProtocolMessage & { id: string | number; method: string }) => void;
  onFailure?: (error: Error) => void;

  constructor(binary: string) {
    this.process = spawn(binary, ['app-server', '--stdio'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process.stderr.resume();
    this.process.once('error', (error) => this.fail(error));
    this.process.once('exit', (code) => this.fail(new Error(`Codex app-server stopped (${code})`)));
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let message: ProtocolMessage;
      try {
        message = JSON.parse(line) as ProtocolMessage;
      } catch {
        this.fail(new Error('Codex app-server returned an invalid protocol message'));
        return;
      }
      if (message.id !== undefined) {
        if (message.method) {
          this.onRequest?.(message as ProtocolMessage & {
            id: string | number;
            method: string;
          });
          return;
        }
        if (typeof message.id !== 'number') return;
        const request = this.pending.get(message.id);
        if (!request) {
          return;
        }
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) {
          request.reject(new CodexProtocolError(request.method, message.error));
        } else {
          request.resolve(message.result);
        }
        return;
      }
      this.onNotification?.(message);
    });
  }

  async initialize(): Promise<void> {
    await this.send('initialize', {
      clientInfo: { name: 'relay-provider-connection', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.process.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is unavailable'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${method} could not be sent`));
      });
    });
  }

  respond(id: string | number, result: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is unavailable'));
    return new Promise((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify({ id, result })}\n`, (error) => {
        if (error) reject(new Error('Codex clarification response could not be sent'));
        else resolve();
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.process.kill();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onFailure?.(error);
  }
}

export function createCodexAppServerSession(
  binary = process.env.RELAY_CODEX_BIN ?? 'codex'
): CodexAppServerSession {
  return new ChildProcessCodexAppServerSession(binary);
}

function isLoginResult(value: unknown): value is {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
} {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.type === 'chatgptDeviceCode'
    && typeof result.loginId === 'string'
    && typeof result.verificationUrl === 'string'
    && typeof result.userCode === 'string';
}

export class LocalCodexAppServerRuntime implements ManagedCodexRuntime {
  private readonly sessions = new Map<string, CodexAppServerSession>();

  constructor(
    private readonly binary = process.env.RELAY_CODEX_BIN ?? 'codex',
    private readonly createSession: (binary: string) => CodexAppServerSession =
      (sessionBinary) => new ChildProcessCodexAppServerSession(sessionBinary)
  ) {}

  async startManagedLogin(input: Parameters<ManagedCodexRuntime['startManagedLogin']>[0]) {
    this.sessions.get(input.credentialStoreReference)?.close();
    const session = this.createSession(this.binary);
    this.sessions.set(input.credentialStoreReference, session);
    try {
      await session.initialize();
      const result = await session.send('account/login/start', { type: input.loginType });
      if (!isLoginResult(result)) throw new Error('managed login returned an invalid response');
      let finished = false;
      const finish = (completion: ManagedLoginCompletion) => {
        if (finished) return;
        finished = true;
        void input.onCompleted(completion).catch(() => {}).finally(() => {
          session.close();
          if (this.sessions.get(input.credentialStoreReference) === session) {
            this.sessions.delete(input.credentialStoreReference);
          }
        });
      };
      session.onNotification = (message) => {
        if (message.method !== 'account/login/completed') return;
        if (message.params?.loginId !== result.loginId) return;
        finish({
          success: message.params.success === true,
          authMode: message.params.success === true ? 'chatgpt' : undefined,
          error: typeof message.params.error === 'string' ? message.params.error : undefined
        });
      };
      session.onFailure = () => finish({
        success: false,
        error: 'Codex app-server became unavailable during managed login'
      });
      return result;
    } catch (error) {
      session.close();
      this.sessions.delete(input.credentialStoreReference);
      throw error;
    }
  }

  async logout(input: { credentialStoreReference: string }): Promise<void> {
    this.sessions.get(input.credentialStoreReference)?.close();
    this.sessions.delete(input.credentialStoreReference);
    const session = this.createSession(this.binary);
    try {
      await session.initialize();
      await session.send('account/logout');
    } finally {
      session.close();
    }
  }
}

let managedCodexRuntime: ManagedCodexRuntime | undefined;

export function getManagedCodexRuntime(): ManagedCodexRuntime {
  managedCodexRuntime ??= new LocalCodexAppServerRuntime();
  return managedCodexRuntime;
}
