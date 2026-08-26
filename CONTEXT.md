# Relay domain glossary

## Workspace

The top-level collaboration, ownership, and authorization boundary. Projects, Channels, Agents, AgentRuns, Tasks, Artifacts, provider connections, approvals, and linked repositories belong to exactly one Workspace and may not cross its boundary. The MVP pilot operates one Workspace, but that operational constraint does not redefine the concept.

## MVP pilot workspace

The first real Relay workspace operated by the existing two-person business. It is the reference operating context for MVP decisions and validation, rather than a hypothetical generic startup or a multi-team organisation.

## Workspace member

A Workspace-local participant identity used for authorship, mentions, Project membership, and attribution. Every Workspace member is exactly one of a Pilot member or an Agent; the shared identity does not imply shared authentication, configuration, permissions, or lifecycle.

## MVP engineering agent

The first specialised agent role in the MVP. It receives engineering requests, performs persistent work against a linked GitHub repository, and returns a reviewable artifact, initially expected to be a pull request.

## Shared agent channel

The MVP's primary collaboration surface: both pilot members can mention the MVP engineering agent, see concise execution status, and review its resulting artifact. It is not a separate task dashboard.

## Pilot member

The human kind of Workspace member, linked to an authenticated human identity. Each of the two business collaborators has a separate account, membership, and attributable actions; the membership is distinct from the human's login identity.

## Agent

The active or disabled agent kind of Workspace member, linked to its role, instructions, runtime configuration, and permissions. The MVP pilot has one Agent; disabling prevents new work without erasing its authorship or execution history.

## Project

A Workspace-owned context boundary for a goal, its participating members and Agent, and its linked resources. The MVP pilot has one Project, but a Workspace may contain multiple Projects.

## Project membership

The participation of one Workspace member in one Project. The MVP Project includes both Pilot members and the MVP engineering Agent; the Agent may be invoked only from a Channel linked to a Project where it is a member.

## Channel

A Workspace-owned communication surface. A Channel may be linked to at most one Project, while a Project may link multiple Channels. The MVP's shared agent Channel is linked to its single Project.

## Message

A communication posted by exactly one Workspace member in exactly one Channel, either as a channel root or a reply to a root in that Channel. A Message inherits Project context through its Channel; editing its text cannot create, retarget, or retract a Task already snapshotted from it.

## Accepted Agent mention

An explicit Agent mention that Relay accepts for either conversation or engineering delegation after the relevant Agent, Project, and provider readiness checks pass. A Message whose mention fails readiness remains communication but creates no work.

## Conversational Agent mention

An Accepted Agent mention intended for ordinary discussion, explanation, or an underspecified request. It creates a durable conversational turn and an attributable reply Message, but no Task, AgentRun, repository branch, or Artifact. Direct human replies in the same Thread continue the conversation without requiring another mention.

## Engineering delegation

An Accepted Agent mention that requests a concrete repository outcome. It creates a Task and initial AgentRun atomically after repository and safety readiness checks also pass. Ambiguous intent remains conversational until a concrete outcome is established.

## Thread

A root Message and its direct replies within one Channel. Replies do not create nested Threads in the MVP.

## Task

The durable requested outcome created when Relay accepts an Agent mention, with an independent lifecycle of open, completed, or cancelled. A Message creates at most one Task in the MVP; a Task belongs to exactly one Project and assigned Agent and may be attempted by multiple sequential AgentRuns.

## AgentRun

One persistent execution attempt by an Agent toward exactly one Task; a Task begins with one AgentRun and may gain later attempts. Its initiating, clarification, status, and result Messages communicate about the execution but do not contain or replace its lifecycle.

## AgentRun lifecycle

The durable progression through `queued`, `planning`, `working`, waiting for input or approval, recovery or pause, and exactly one immutable terminal outcome of completed, failed, or cancelled. A clarification answered after execution has yielded re-enters the queue. An Approval waiting on one action in an active execution boundary continues only within that same boundary; losing the boundary expires the Approval and pauses the run. An unknown execution outcome passes through recovery into pause and is never replayed automatically.

## Artifact

A durable, user-reviewable output reference produced by exactly one AgentRun for exactly one Project. The MVP's Artifact is a GitHub pull request; its branch and commits are provenance rather than separate Artifacts.

## Approval

A persistent, single-use decision by a Pilot member on one precisely scoped action requested by an AgentRun. An Approval can permit or deny only an approval-eligible action; forbidden actions never enter the Approval workflow.

## Linked pilot repository

The single GitHub repository connected as a Workspace-owned resource of the MVP's Project. Its GitHub connection may let the MVP engineering agent create branches, commits, and pull requests, but the Agent neither owns the repository nor may merge pull requests or administer it.

## GitHub connection

The Workspace-owned GitHub App installation and credential boundary through which Relay accesses the Linked pilot repository. It is distinct from the repository link, the Project, and the Agent that receives scoped access for an AgentRun.

## Self-hosted MVP

The MVP pilot is deployed on infrastructure controlled by the business, rather than operated as a hosted Relay service.

## Existing Codex account integration

The MVP's engineering agent must be proven using the business owner's existing Codex/ChatGPT account. A business-owned, usage-billed OpenAI API credential is not an acceptable substitute for the initial validation journey.

## Provider account owner

The business owner who connects and owns the existing Codex/ChatGPT account used by the MVP engineering agent. Both pilot members may invoke the shared agent, subject to Relay's permissions.

## Provider connection

A Workspace-owned link to an external agent runtime account, established and owned by exactly one Pilot member as Provider account owner. The MVP engineering Agent uses the Workspace's single connected Codex connection without exposing its credentials to other Pilot members, with at most one AgentRun executing through it at a time.

## MVP engineering autonomy

Once either pilot member delegates a scoped engineering request, the MVP engineering agent may autonomously create a branch, commits, and a pull request in the linked pilot repository. Merge, administration, deployment, destructive actions, and actions beyond this boundary are unavailable or require human approval.

## Recoverable AgentRun

An AgentRun whose durable state and execution arrangement allow an in-progress delegated request to survive and recover from a Relay web-server restart or deployment, not merely retain its completed history.

## Waiting AgentRun

An AgentRun that has posted a concise clarification request to the shared agent channel, persists in a visible waiting state, and resumes when a pilot member replies.

## Paused AgentRun

An AgentRun stopped at an uncertain execution boundary that requires human review before it may resume from a known safe boundary.

## Single-agent MVP

The MVP validates only the shared MVP engineering agent. Additional specialist agents and agent-to-agent coordination are deferred until this single-agent collaboration loop is reliable.

## MVP pilot success

Both pilot members independently delegate real repository work through the shared agent channel; the MVP engineering agent completes at least one reviewable pull request; and its run remains understandable and recoverable through visible status, clarification, and a restart.
