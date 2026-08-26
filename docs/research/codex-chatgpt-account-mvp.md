# Can a self-hosted MVP use the owner's ChatGPT/Codex account?

## Conclusion

**Yes, as an owner-operated MVP:** run the open-source `codex app-server` alongside
the self-hosted application and have the owner complete Codex's managed ChatGPT OAuth
login. This is a documented alternative to API-key auth and uses the account's Codex
entitlement/usage limits rather than the API key path. It is not a zero-cost or
unlimited route: limits are plan-dependent, shared with other agentic uses, and some
plans can consume added ChatGPT credits. The app-server's remote/WebSocket operation
and external-token mode are explicitly experimental, so this is unsuitable as the
only production-grade, multi-tenant integration boundary.

## Evidence and MVP implications

| Concern | First-party finding | MVP implication |
| --- | --- | --- |
| Auth | App-server supports managed ChatGPT OAuth (browser or device-code flow), persists and refreshes its tokens; it separately supports API keys. Its `chatgptAuthTokens` mode is **experimental**, for hosts that already own a user's ChatGPT auth lifecycle and can refresh the supplied access token. [App Server: authentication](https://developers.openai.com/codex/app-server/#auth-endpoints) | Do not collect the owner's password or treat a copied session token as an application credential. Let the owner log in through the managed flow; protect the resulting local Codex credential store. |
| Entitlement/billing | Codex is included on eligible ChatGPT plans. Its consumption counts against the plan's shared agentic allowance; usage varies with task size/context, and Plus/Pro accounts may use added credits after included limits. ChatGPT subscriptions and API billing are separate. [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan/) [Credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-free-go-plus-pro-sora) [API versus ChatGPT billing](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account) | The owner account, not an API key, pays through its plan/optional credits. Surface the current limit and an exhausted-limit state; do not promise fixed throughput. |
| Execution surface | App-server is specifically documented for embedding Codex in a product, including authentication, history, approvals, and streamed events. It accepts a client over stdio, local WebSocket, or Unix socket. [App Server overview](https://developers.openai.com/codex/app-server/) | The app should be a UI/orchestrator around one local app-server process, not an attempt to call an undocumented ChatGPT backend. For unattended/CI jobs, OpenAI instead directs users to the Codex SDK. |
| Concurrency | Codex Cloud advertises isolated environments and parallel tasks. In app-server, every thread in one process shares the selected Code Mode host connection; documentation does not state an account-level concurrency guarantee. [Codex Cloud](https://developers.openai.com/codex/cloud/) [App Server remote host](https://developers.openai.com/codex/app-server/#connect-a-remote-code-mode-host) | Queue/limit work yourself and avoid assuming an owner plan supplies a stable parallelism quota. Use separate workspaces/worktrees to prevent local file conflicts. |
| Status and cancellation | A turn streams item/tool progress and ends with `completed`, `interrupted`, or `failed`. `turn/interrupt` cancels an in-flight turn; command sessions also have a terminate operation. [Lifecycle](https://developers.openai.com/codex/app-server/#lifecycle-overview) [Turn events and interrupt](https://developers.openai.com/codex/app-server/#turn-events) | Persist thread/turn IDs in the app and map notifications to job status. Provide Cancel by calling `turn/interrupt`; do not infer completion from a silent connection. |
| Persistence/handoff | Threads can be listed/read/resumed/forked; Codex stores thread logs locally as JSONL and supports archive/unarchive. [Thread persistence](https://developers.openai.com/codex/app-server/#manage-threads) | Store the thread ID plus app-level job metadata. A restarted UI can resume a stored thread, but back up/encrypt the server's Codex state if handoff/recovery matters. |
| Sandboxing and approval | Per-turn policies can be read-only or workspace-write, constrain writable/readable roots, and control network access. Command/file changes can require client approval; bypassing both approvals and sandboxing is documented as appropriate only in an externally hardened environment. `thread/shellCommand` is outside the sandbox and documented only for explicit user actions. [Sandbox policy](https://developers.openai.com/codex/app-server/#sandbox-policy) [Approvals](https://developers.openai.com/codex/app-server/#approvals) [CLI reference](https://developers.openai.com/codex/cli/reference/) | Default to `workspaceWrite` limited to one job workspace, restricted reads, network disabled, and explicit approval UI for escalation. Do not expose unsandboxed shell actions or a remote server unauthenticated. |
| Remote security and policy | For non-local app-server connections, OpenAI requires WebSocket authentication and TLS, and says the WebSocket transport is experimental/not supported for production workloads. ChatGPT-account Codex use is governed by the applicable ChatGPT terms/privacy policy. [Remote app-server guidance](https://developers.openai.com/codex/app-server/#connect-the-cli-terminal-ui) [ChatGPT-plan terms](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan/) | Bind locally where possible. If a web frontend reaches a server host, put it behind WSS/TLS and bearer authentication, apply normal access control and audit logging, and obtain owner consent for repository/secrets access. |

## Recommended decision

Choose **local, owner-authorized `codex app-server`** for a single-owner MVP, with a
job queue, thread-ID persistence, streamed status, cancellation, and least-privilege
workspace sandboxing. Treat it as an experimental integration and make an API/SDK-backed
execution path the likely production successor—especially before supporting multiple
customers or unattended shared-server workloads.

## Limits of this finding

OpenAI's published app-server material documents the integration protocol and its
authentication modes, but does not publish a contractual concurrency/SLA or a general
public OAuth protocol for arbitrary hosted SaaS apps. The recommendation above is
therefore an inference from the documented local/host-app interface and its explicit
experimental status, not a claim of production support.
