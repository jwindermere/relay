# Relay domain glossary

## Workspace

The top-level collaboration, ownership, and authorization boundary. Projects, Channels, Agents, AgentRuns, Tasks, Artifacts, provider connections, approvals, and linked repositories belong to exactly one Workspace and may not cross its boundary. A User may participate in multiple Workspaces without weakening those boundaries.

## Active Workspace

The one Workspace selected by a User for the current Relay interaction. A User may hold active memberships in multiple Workspaces, but authorization, realtime subscriptions, navigation, and all collaboration data remain scoped to the Active Workspace.

## Pilot workspace

The first real Relay Workspace, operated by the existing business and any teammates its owner invites. It is the reference operating context for product decisions and validation, rather than a hypothetical generic organisation.

## Workspace member

A Workspace-local participant identity used for authorship, mentions, Project membership, and attribution. Every Workspace member is exactly one of a Pilot member or an Agent; the shared identity does not imply shared authentication, configuration, permissions, or lifecycle.

## Engineering Agent

The first specialised agent role in the MVP. It receives engineering requests, performs persistent work against a linked GitHub repository, and returns a reviewable artifact, initially expected to be a pull request.

## Shared Agent Channel

The primary collaboration surface where Pilot members and specialist Agents communicate, see concise execution status, and review resulting Artifacts. It is not a separate task dashboard.

## Pilot member

The human kind of Workspace member, linked to an authenticated human identity. Every invited collaborator has a separate account, membership, and attributable actions; the membership is distinct from the human's login identity.

## Manually delivered invitation

An email-bound, one-time Workspace invitation that the owner gives to its intended recipient through a trusted channel. Possession of its short-lived secret establishes the invited account's email for this Workspace without proving control of the corresponding mailbox.

## Agent

The active or disabled agent kind of Workspace member, linked to its configurable name, type, role, instructions, participation policy, runtime configuration, and permissions. A Workspace may have multiple specialist Agents. Disabling prevents new work without erasing authorship or execution history.

## Ambient Agent participation

An Agent's permission to consider an untagged Message when the Message matches its configured topics or concerns work it owns. Relay selects at most one relevant Agent, supplies recent authorized Channel context, and permits the Agent to remain silent. Ambient participation must not create uncontrolled Agent-to-Agent conversation.

## Agent reply placement

The Agent's configured choice of channel, Thread, or adaptive response placement. Adaptive placement responds to a channel-root Message in the Channel and keeps direct replies in their Thread.

## Project

A Workspace-owned context boundary for a goal, its participating members and Agent, and its linked resources. The MVP pilot has one Project, but a Workspace may contain multiple Projects.

## Project membership

The participation of one Workspace member in one Project. An Agent may be invoked or participate ambiently only from a Channel linked to a Project where it is a member.

## Channel

A Workspace-owned communication surface. A Channel may be linked to at most one Project, while a Project may link multiple Channels. The MVP's shared agent Channel is linked to its single Project.

## Message

A communication posted by exactly one Workspace member in exactly one Channel, either as a channel root or a reply to a root in that Channel. A Message inherits Project context through its Channel; changing its visible text cannot create, retarget, or retract a Task already snapshotted from it.

## Deleted Message

A Message whose visible body has been redacted by its author or a Workspace owner. Its identity, authorship, place in a Thread, replies, and existing work provenance remain durable; deletion is not Task cancellation and does not erase collaboration history.

## Call

A durable Channel-associated coordination session backed by an external voice/video room. A Channel has at most one active Call; ending it preserves its history and allows another Call to begin. The Call starter or a Workspace owner may end it.

## Call participant

A Pilot member who requested to join a Call. Participation records Relay's durable join history, not authoritative presence in the external voice/video room.

## Accepted Agent mention

An explicit Agent mention that Relay accepts for either conversation or engineering delegation after the relevant Agent, Project, and provider readiness checks pass. A Message whose mention fails readiness remains communication but creates no work.

## Agent conversation

An explicit mention, continued reply, or relevant ambient Message accepted for ordinary discussion, explanation, or an underspecified request. It creates a durable conversational turn and, unless the Agent chooses silence during ambient consideration, an attributable reply Message. It creates no Task, AgentRun, repository branch, or Artifact. Recent authorized Channel Messages provide scoped memory, while a continued conversation also resumes its Provider thread.

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

## Multi-Agent collaboration

A Workspace may configure multiple named specialist Agents. Relay routes each ordinary Message to at most one conversational Agent and retains a single Engineering AgentRun assignee. A Pilot member may separately approve one explicit, bounded Coordination plan whose visible steps can involve several Agents; that exception is budgeted, dependency-ordered, and cannot grant engineering authority. This prevents implicit fan-out and uncontrolled social loops while preserving deliberate parallel work.

## Agent handoff

A bounded request from an Agent answering a Pilot member to exactly one other specialist Agent for a concrete input. The receiving Agent may answer once but may not hand off again. An Agent handoff is conversational coordination: it creates no Task or AgentRun and cannot authorize engineering work.

## Message intent decision

Relay's durable, versioned interpretation of a Pilot member's Message, including its selected intent, target Agent, confidence, and rationale. A correction appends attributable Pilot-member judgment without rewriting the Message or erasing the original interpretation.

## Agent finding

A structured, attributable research result that separates observed evidence, inference, assumptions, open questions, and calibrated confidence. Finding evidence records stable source references and retrieval times; a high-confidence Finding without evidence is explicitly flagged.

## Project memory

A Project-scoped, source-backed statement promoted from a Finding or explicitly recorded by a Pilot member. Its lifecycle is active, superseded, archived, or deleted: supersession points to its replacement, archival withdraws it from active context while retaining ordinary visibility, and deletion retains only its durable audit identity. Project memory is context for later work, never hidden authority.

## Steering input

An ordered, durable constraint appended by a Pilot member to an active AgentRun. It is delivered at the next known Provider interaction boundary, is visible in the Shared Agent Channel, and cannot broaden the AgentRun's permissions.

## Coordination plan constraint input

A Pilot-member-authored constraint that narrows an approved Coordination plan without changing its participants or authority. It remains pending until delivered to a later Coordination step, then becomes an active plan constraint with an attributable delivery boundary.

## Coordination plan

A coordinating Agent's proposed goal, participants, steps, dependencies, execution policy, and explicit limits. It performs no work until a Project Pilot member approves it and may then be paused or cancelled by a Pilot member.

## Coordination step

One dependency-ordered assignment in an approved Coordination plan, targeting exactly one Agent and producing concise text, a structured Finding, or a reference to an existing Project Artifact. Conversational steps create no Task or AgentRun; repository-affecting work still requires an independently authorized Engineering delegation.

## Coordination budget

The approved participant, handoff, depth, AgentRun, elapsed-time, and optional Provider-usage limits attached to a Coordination plan. Relay reserves known capacity atomically before starting a step and pauses when a hard limit is exhausted; unknown Provider usage is displayed as unknown.

## Workspace coordination policy

The Workspace-owned default ceilings for Coordination plans: participants, handoffs, handoff depth, AgentRuns, elapsed time, and optional Provider usage. A proposed or edited plan's Coordination budget may be stricter but cannot exceed this policy; the approved per-plan budget remains the limit enforced while that plan runs.

## Agent inbox

A Project-scoped projection of an Agent's queued, active, waiting, blocked, review-ready, and completed work. Items identify their source Message and whether human action is required; the inbox grants no authority of its own.

## Collaboration evaluation

Versioned, Workspace-scoped evidence about routing decisions, policy rejections, Pilot overrides, unsupported certainty, duplicate investigation, and recursive coordination attempts. Pilot feedback is retained separately and can be analysed by Agent type and policy version.

## Agent template

A versioned starting configuration for a bounded specialist Agent. Instantiation records template provenance, previews role, instructions, permissions, and overlapping ambient triggers, and never grants permission beyond the Project and Workspace boundary.

## MVP pilot success

Invited Pilot members can collaborate with configured Agents through the Shared Agent Channel; an Engineering Agent completes at least one reviewable pull request; and its run remains understandable and recoverable through visible status, clarification, and a restart.
