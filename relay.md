# Agent-Native Collaborative Workspace

## Purpose of This Document

This document is the starting brief for designing and building an agent-native collaborative workspace.

Use this brief with the **Wayfinder** process.

The goal at this stage is **not to immediately implement the entire product**. First identify architectural uncertainty, product decisions, technical risks, experiments, and prototypes necessary to establish a credible route from an empty repository to a useful MVP.

Where this document makes an explicit decision, treat that decision as settled unless implementation evidence shows that it is materially problematic.

Where this document describes an aspiration rather than a settled implementation detail, Wayfinder should explore the available options.

---

# 1. Product Vision

Build a collaborative workspace in which **humans and AI agents are first-class members of a team**.

The product should feel familiar to users of applications such as Slack:

* workspaces
* channels
* direct communication
* threads
* mentions
* reactions
* files
* notifications
* presence
* calls

However, AI agents should not behave merely as chatbots added to channels.

Agents should behave more like **specialised digital employees**.

An agent may:

* have a defined role
* have responsibilities
* belong to projects
* receive tasks
* use tools
* perform work over time
* report progress
* produce artifacts
* collaborate with humans
* collaborate with other agents when useful
* request approvals
* wait for information
* resume work later
* retain appropriate project context
* operate within explicit permissions and budgets

The long-term product should become:

> A place where humans and agents work together, rather than merely a place where they talk together.

---

# 2. Example Workspace

A small startup might configure:

```text
Acme Workspace

Humans
├── James — Founder
└── Sarah — Designer

Agents
├── Alex — Software Engineer
├── Maya — Product Manager
├── Scout — Researcher
└── Ada — Data Analyst
```

A conversation might look like:

```text
James
@Maya let's get the onboarding redesign shipped this week.

Maya
I've broken this into six pieces.

I've assigned:
- user research synthesis → Scout
- analytics review → Ada
- implementation preparation → Alex

Sarah, I need the updated onboarding mockups from you.

I'll keep #onboarding updated as work progresses.
```

The important behaviour is that Maya is not simply generating a plausible conversational response.

The system should allow Maya to actually:

1. create or delegate work
2. start agent runs
3. monitor those runs
4. receive structured results
5. request human input
6. synthesise progress
7. update the project

---

# 3. Core Product Principle

## Agents are not bots

Do not model an agent as merely:

```text
User
+
system prompt
```

Agents need first-class domain concepts.

Conceptually an agent may have:

```text
Agent
├── identity
├── role
├── instructions
├── responsibilities
├── capabilities
├── project memberships
├── context permissions
├── tool permissions
├── autonomy policy
├── runtime/provider
├── budget/usage constraints
└── current workload
```

Example:

```text
Agent: Alex

Role:
Senior Software Engineer

Responsibilities:
- implement assigned features
- investigate bugs
- review code
- help with architecture

Projects:
- Atlas

Resources:
- atlas-api
- atlas-web
- engineering documentation

Tools:
- Codex
- GitHub
- terminal
- browser

Permissions:
- create branches
- create commits
- open pull requests
- comment on issues
- cannot merge main
- cannot deploy production without approval

Autonomy:
- may perform reversible development work automatically
- must request approval for destructive or high-impact operations
```

---

# 4. Projects Are First-Class Context Boundaries

Projects should be a core part of the architecture rather than something layered on later.

A workspace contains projects.

A project may contain or reference:

```text
Project
├── goal
├── description
├── members
│   ├── humans
│   └── agents
├── linked channels
├── repositories
├── documents
├── files/resources
├── tasks
├── decisions
├── artifacts
├── meetings
├── agent runs
└── project memory/context
```

For example:

```text
Project: Atlas

Goal:
Build the next generation of the analytics platform.

Channels:
#atlas
#atlas-engineering
#atlas-design

Agents:
Alex — Engineering
Maya — Product
Scout — Research

Resources:
atlas-api
atlas-web
product specification
customer research

Current State:
12 open tasks
3 unresolved decisions
2 active agent runs
```

A project should provide an important context boundary for agents.

An agent working on Atlas should not automatically receive the complete history and data of the entire workspace.

---

# 5. Channels

The chat interface should use familiar collaboration conventions.

Initial channel capabilities should include:

* public workspace channels
* project-linked channels
* private channels where appropriate
* messages
* threads
* mentions
* reactions
* attachments
* message editing
* presence
* unread state
* notifications

Channels may optionally belong to a project.

Example:

```text
Workspace
├── #general
├── #random
│
└── Project: Atlas
    ├── #atlas
    ├── #atlas-engineering
    └── #atlas-design
```

A project may have multiple channels.

A channel does not itself represent the complete project context.

---

# 6. Messages and Agent Runs Must Be Separate Concepts

This is a major architectural constraint.

**Do not model an agent performing work as simply generating another message.**

A message represents communication.

An `AgentRun` represents execution.

Example:

```text
Human message
    ↓
Agent mention
    ↓
AgentRun created
    ↓
queued
    ↓
planning
    ↓
working
    ↓
waiting_for_input
    ↓
working
    ↓
completed
    ↓
agent posts concise result
```

Potential run states include:

```text
queued
planning
working
waiting_for_input
waiting_for_approval
paused
completed
failed
cancelled
```

A run may produce:

* messages
* tool calls
* tasks
* commits
* pull requests
* research
* documents
* decisions
* files
* other artifacts

The chat should expose an understandable representation of this work without dumping raw model execution traces into the conversation.

---

# 7. Agent Work UX

Agent execution should feel like a colleague performing work.

For example:

```text
James
@Alex investigate the intermittent login failures.
```

The channel might show:

```text
Alex is investigating

↳ Reviewing authentication service
↳ Examining recent changes
↳ Running relevant tests
```

Later:

```text
Alex

I found a likely race condition in token refresh.

I've prepared a fix and added a regression test.

PR #482
[View work] [Review PR]
```

Avoid exposing lengthy internal reasoning or streams of low-value agent chatter.

Prefer concise:

* activity
* status
* results
* artifacts
* decisions
* blockers
* approval requests

---

# 8. Agent Interaction Modes

The product should eventually support three broad modes.

## 8.1 Reactive

A human explicitly invokes an agent.

```text
@Alex fix this error.
```

---

## 8.2 Delegated

A human assigns a unit of work that may continue independently.

```text
@Alex take ownership of issue #423.
```

The work should have persistent state and should not depend on the initiating browser session remaining open.

---

## 8.3 Ambient

Certain agents may observe activity and intervene only under explicit rules.

Example:

```text
Support Agent

Intervene when:
- customer question is unanswered beyond threshold
- repeated bug reports appear
- escalation criteria are met

Do not intervene for:
- casual discussion
- internal chatter
- resolved questions
```

Ambient behaviour is **not required for the initial MVP**, but the architecture should avoid making it impossible.

---

# 9. Agent-to-Agent Collaboration

Avoid designing the product around agents endlessly chatting with each other.

Prefer structured coordination.

Example user request:

```text
Why has signup conversion dropped?
```

An orchestrator might determine:

```text
Investigation

Participants:
- Data Analyst
- Engineer
- Product Manager

Plan:
1. Analyst investigates funnel metrics.
2. Engineer checks recent signup changes.
3. Product Manager synthesises findings.
```

The user-visible channel should contain useful summaries and progress.

Behind the scenes, agents should preferably exchange:

* assignments
* structured inputs
* structured results
* artifacts
* status changes

rather than uncontrolled conversational loops.

---

# 10. Orchestration

Introduce an orchestration layer between chat and agent runtimes.

Conceptual architecture:

```text
┌────────────────────┐
│ SvelteKit Web App  │
└─────────┬──────────┘
          │
          │ HTTP / realtime events
          ▼
┌────────────────────┐
│ Application Layer  │
│                    │
│ Workspaces         │
│ Projects           │
│ Channels           │
│ Messages           │
│ Permissions        │
└─────────┬──────────┘
          │
          │ agent task/run
          ▼
┌────────────────────┐
│ Agent Orchestrator │
│                    │
│ routing            │
│ context assembly   │
│ scheduling         │
│ delegation         │
│ approvals          │
│ budgets            │
│ runtime selection  │
└────────┬───────────┘
         │
    ┌────┴──────────┐
    ▼               ▼
Codex Runtime    Other Runtimes
    │               │
    └───────┬───────┘
            ▼
      Tools / MCP
      GitHub
      Browser
      Files
      etc.
```

The orchestrator is likely to become one of the most important parts of the product.

It should ultimately determine:

* which agent should respond
* whether another agent is required
* what context is relevant
* which tools may be used
* whether approval is required
* whether work should run asynchronously
* whether work should be delegated
* what runtime/provider should execute it
* how much resource/budget may be consumed

Do not over-engineer orchestration for the MVP.

Find the smallest architecture that preserves the ability to evolve toward this model.

---

# 11. Agent Runtime Abstraction

Codex should initially be a major execution provider, particularly for software engineering agents.

However, the product should not hard-code its domain model around Codex.

Create a runtime/provider abstraction conceptually similar to:

```ts
interface AgentRuntime {
  startTask(task: AgentTask): Promise<AgentRunHandle>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  cancelTask(runId: string): Promise<void>;
  getStatus(runId: string): Promise<AgentRunStatus>;
}
```

Potential future implementations:

```text
CodexRuntime
OpenAIRuntime
LocalRuntime
OtherProviderRuntime
```

Exact interfaces should be discovered during Wayfinding and implementation rather than copied blindly from this example.

The important architectural decision is:

> Agent identity and product state must not be synonymous with a particular model provider or execution runtime.

---

# 12. Codex Integration

A major product hypothesis is:

> A workspace owner can connect their Codex/OpenAI capabilities and the application can intelligently use Codex to power appropriate specialised agents.

The exact authentication, entitlement, execution, usage, concurrency, and billing model needs specific research/prototyping.

Do not assume that:

```text
ChatGPT subscription
=
arbitrary server-side API allowance
```

Treat Codex connectivity as a provider integration whose implementation details can evolve.

Potential UX:

```text
Settings
└── AI Providers
    ├── Codex
    │   ├── connected identity
    │   ├── status
    │   └── available capabilities
    │
    ├── OpenAI API
    │   ├── API credentials
    │   └── budget
    │
    └── Local / future providers
```

Wayfinder should explicitly research and prototype the current supported Codex integration route before settling this architecture.

---

# 13. Tool Integrations

Agents should eventually be able to interact with external systems.

Initial priority:

1. Codex
2. GitHub
3. MCP-compatible tools
4. project files/resources
5. Jitsi

Later possibilities:

* Linear
* Jira
* Google Drive
* Notion
* Slack import/migration
* email
* calendars
* databases
* internal APIs

Integrations should be permission-aware.

An agent having access to a tool does not imply unlimited permission to perform every action offered by that tool.

---

# 14. GitHub

GitHub should be a first-class integration for engineering agents.

Possible capabilities:

* link repositories to projects
* inspect repository contents
* inspect issues
* inspect pull requests
* create branches
* create commits
* open pull requests
* comment on issues
* comment on pull requests
* report CI state

Actions such as merging, destructive changes, repository administration, and production deployment should require stronger permission policies.

Exact MVP capability should be determined during Wayfinding.

---

# 15. Calls

Use **Jitsi** for initial voice/video calls.

Do not build custom WebRTC infrastructure for the MVP.

A channel may expose:

```text
#atlas-engineering

[Start call]
```

A call should associate with:

* workspace
* channel
* optionally project
* participating members

Future enhancements may include:

```text
meeting
    ↓
transcription
    ↓
summary
    ↓
decisions
    ↓
tasks
    ↓
project memory
```

Agent voice participation is not an MVP requirement.

---

# 16. Technical Stack — Settled Decisions

These decisions are intentional.

## Application Framework

Use:

* **SvelteKit**
* **Svelte**
* **TypeScript**

Do **not** replace this with:

* React
* Next.js

unless there is overwhelming evidence of a hard technical blocker.

---

## UI

Use:

* **Tailwind CSS**
* **daisyUI**

daisyUI should provide the default visual vocabulary and component styling.

Prefer daisyUI primitives over bespoke UI components where suitable.

Create custom components where the product introduces domain-specific concepts.

Examples:

```text
AgentAvatar
AgentStatus
AgentRunCard
AgentActivity
AgentInbox
ApprovalRequest
ProjectCard
ProjectContextPanel
TaskCard
ArtifactCard
DecisionCard
ChannelHeader
MessageComposer
```

Keep custom global CSS limited.

Theme configuration should be centralised.

The first version does not need an elaborate bespoke design system.

Consistency and speed of development are more important.

---

# 17. Backend Direction

Prefer keeping the architecture simple enough for a small team or individual developer to operate.

Initial direction:

```text
SvelteKit
TypeScript
PostgreSQL
WebSockets/realtime transport
S3-compatible object storage
```

Potential later infrastructure:

```text
Redis
Temporal
dedicated workers
additional search infrastructure
```

Do not introduce those technologies merely because they are common in distributed systems.

Introduce infrastructure when a demonstrated requirement justifies it.

---

# 18. PostgreSQL

PostgreSQL should hold core application state.

Likely entities include:

```text
Workspace
WorkspaceMember

HumanUser
Agent

Project
ProjectMember
ProjectResource

Channel
ChannelMember

Message
Thread
Reaction
Attachment

AgentRun
AgentRunEvent

Task
Artifact
Decision

Integration
Permission
Approval
```

This is a conceptual model, not a final schema.

Wayfinder should determine:

* ownership boundaries
* cardinalities
* tenancy strategy
* event representation
* permission representation
* project context representation
* run persistence
* artifact modelling

before committing to a detailed schema.

---

# 19. Suggested Core Domain Relationships

Conceptually:

```text
Workspace
├── Members
│   ├── Humans
│   └── Agents
│
├── Projects
│   ├── Members
│   ├── Channels
│   ├── Resources
│   ├── Tasks
│   ├── Decisions
│   ├── Artifacts
│   └── AgentRuns
│
├── Channels
│   ├── Messages
│   └── Threads
│
└── Integrations
```

One member abstraction may be useful for concepts shared between humans and agents, such as:

* identity in conversations
* project membership
* channel membership
* mentions

Do not force humans and agents into identical schemas if their lifecycle and capabilities materially differ.

---

# 20. Context and Memory

Agent context is a key architectural problem and should receive explicit Wayfinder investigation.

Do not solve context by putting the complete channel/workspace history into every model invocation.

Possible context sources include:

```text
Agent identity/instructions
+
current task
+
current conversation/thread
+
project description
+
relevant project resources
+
relevant historical decisions
+
relevant artifacts
+
tool state
```

Context should be:

* scoped
* permission-aware
* relevant
* inspectable where possible
* cost-conscious
* reproducible enough to debug

Potential long-term project memory may contain:

* goals
* terminology
* architecture
* important people
* decisions
* completed work
* unresolved questions
* relevant artifacts

The appropriate retrieval/memory architecture remains an open design question.

---

# 21. Permissions and Safety

Autonomous agents require explicit permission boundaries.

Permissions should eventually be able to distinguish between actions such as:

```text
read repository
create branch
create commit
open PR
merge PR
delete branch
modify database
deploy staging
deploy production
send email
purchase service
modify secrets
```

Consider both:

* what the agent technically can access
* what the agent is authorised to do autonomously

A capability may therefore be:

```text
allowed automatically
allowed with approval
forbidden
```

Human approval should be a first-class workflow concept rather than a special chat message.

---

# 22. Approvals

Example:

```text
Alex needs approval

Action:
Apply database migration

Reason:
Adds unique constraint required by authentication fix.

Impact:
Production database schema

[Approve]
[Deny]
[Ask Alex]
```

Approval requests should be persistent and auditable.

---

# 23. Agent Inbox and Workload

Agents should eventually have an inspectable operational view.

Example:

```text
Alex
Senior Engineer

Working
────────
OAuth refresh bug

Inbox
────────
3 assigned tasks
2 mentions
1 review requested

Waiting
────────
Database migration approval
```

This reinforces the idea that agents are persistent team members rather than ephemeral chat completions.

Potential workload awareness:

```text
Alex    3 active tasks
Maya    1 active task
Scout   idle
Ada     2 active tasks
```

This does not need sophisticated capacity modelling in the MVP.

---

# 24. Tasks

Tasks should be distinct from messages and agent runs.

A message may create a task.

A task may result in one or many agent runs.

Conceptually:

```text
Message
"Issue #423 needs fixing"
      ↓
Task
"Fix issue #423"
      ↓
AgentRun
Alex investigates
      ↓
AgentRun
Alex implements
      ↓
Artifact
PR #482
      ↓
Task completed
```

This distinction should prevent execution lifecycle from becoming coupled to chat lifecycle.

---

# 25. Artifacts

Agent work often creates something more durable than a message.

Artifacts might include:

* pull requests
* commits
* documents
* reports
* plans
* datasets
* images
* research collections
* meeting summaries
* external URLs

Artifacts should be addressable entities that can be associated with:

* projects
* tasks
* agent runs
* messages
* agents

---

# 26. Decisions

Projects should eventually retain significant decisions.

Example:

```text
Decision

Use PostgreSQL rather than DynamoDB.

Context:
...

Reason:
...

Date:
...

Participants:
...

Source:
#architecture thread
```

This could become valuable agent context later.

Do not attempt automatic decision extraction in the earliest MVP unless it proves extremely easy and reliable.

---

# 27. Realtime Behaviour

The app needs realtime behaviour for:

* messages
* typing/presence where implemented
* agent activity
* run status
* approval requests
* task updates
* notifications

Investigate the simplest reliable realtime architecture that works naturally with SvelteKit and the intended hosting model.

Do not prematurely introduce complex distributed event infrastructure.

---

# 28. Hosting

The product should ultimately be hostable by another person or organisation.

A user should be able to run their own instance and connect the services/providers they want to use.

This makes configuration, secrets, migrations, object storage, agent execution, and external integrations important architectural concerns.

Wayfinder should explore likely deployment models.

An initial deployment may reasonably be optimised for a single-host or simple cloud setup before tackling large distributed deployments.

---

# 29. Multi-Tenancy

The product concept includes workspaces and should avoid making future multi-workspace hosting impossible.

However, do not allow speculative enterprise multi-tenancy requirements to dominate the MVP.

Wayfinder should decide whether the initial architecture should be:

* strongly multi-tenant from day one
* logically tenant-aware but operationally simple
* primarily single-instance/single-organisation with clean boundaries for later evolution

---

# 30. Authentication

Authentication is required for human workspace users.

Exact auth technology is not yet settled.

Requirements likely include:

* secure login
* workspace membership
* sessions
* invitations
* provider connection ownership
* role/permission handling

Do not choose an auth provider simply because it is fashionable.

Select the simplest solution compatible with self-hosting and the product's likely direction.

---

# 31. Initial Application Structure

An approximate SvelteKit organisation could look like:

```text
src/
├── routes/
│   ├── (auth)/
│   │
│   └── (workspace)/
│       └── [workspaceId]/
│           ├── channels/
│           │   └── [channelId]/
│           ├── projects/
│           │   └── [projectId]/
│           ├── agents/
│           │   └── [agentId]/
│           └── settings/
│
├── lib/
│   ├── components/
│   │   ├── agents/
│   │   ├── chat/
│   │   ├── projects/
│   │   ├── tasks/
│   │   └── ui/
│   │
│   ├── server/
│   │   ├── agents/
│   │   ├── auth/
│   │   ├── db/
│   │   ├── integrations/
│   │   ├── permissions/
│   │   └── realtime/
│   │
│   └── shared/
│
└── hooks.server.ts
```

This is illustrative, not mandatory.

Wayfinder and early prototypes should determine the final repository structure.

---

# 32. MVP Product Scope

The first meaningful version should concentrate on the core collaboration loop.

## Required

### Workspace

* create/access workspace
* membership
* basic workspace settings

### Humans

* authentication
* profiles
* workspace membership

### Channels

* create channel
* list channels
* send messages
* threads
* mentions
* basic reactions
* realtime updates

### Projects

* create project
* project description/goal
* associate channels
* associate members
* associate agents
* associate resources

### Agents

* create/configure agent
* name
* avatar/icon
* role
* instructions
* project membership
* runtime configuration
* basic tool permissions

### Agent Execution

* mention agent
* create persistent AgentRun
* execute work
* stream/show status
* complete/fail/cancel
* post concise result into channel
* preserve run history

### Codex

* establish supported authentication/integration route
* perform a meaningful software-development agent task
* expose status/results through AgentRun

### GitHub

At minimum, prove a useful engineering-agent workflow against a project repository.

### Jitsi

* start/join call from channel
* associate room with channel

---

# 33. MVP Non-Goals

Do not initially build:

* complete Slack feature parity
* enterprise administration
* custom WebRTC infrastructure
* voice AI agents
* autonomous agents responding everywhere
* elaborate workflow builder
* plugin marketplace
* dozens of predefined agents
* advanced billing
* complex workload optimisation
* fully autonomous organisations
* arbitrary agent-to-agent social conversation
* bespoke UI component library
* enterprise-grade distributed infrastructure
* exhaustive integrations

---

# 34. Suggested Initial Agents

The first product should demonstrate only a few strong roles.

Potential initial set:

## Software Engineer

Primary runtime:
Codex

Capabilities:

* inspect project code
* investigate bugs
* implement scoped changes
* interact with GitHub

---

## Product Manager

Capabilities:

* organise work
* synthesise progress
* create tasks
* coordinate agents
* identify blockers

---

## Researcher

Capabilities:

* investigate questions
* gather sources
* produce concise research artifacts

---

## Data Analyst

Potentially later in the MVP depending on scope.

Capabilities:

* inspect datasets
* analyse metrics
* produce findings

---

The system should also eventually support custom agents.

---

# 35. Critical End-to-End MVP Journey

A primary validation journey should look something like this:

### 1. Create workspace

User creates:

```text
Acme
```

### 2. Create project

```text
Project:
Atlas

Goal:
Improve onboarding conversion.
```

### 3. Link channel

```text
#atlas
```

### 4. Add engineering agent

```text
Alex
Software Engineer
Codex runtime
```

### 5. Link GitHub repository

```text
acme/atlas
```

### 6. Human sends request

```text
@Alex investigate why authentication occasionally fails during signup.
```

### 7. Agent run starts

UI displays persistent run state.

```text
Alex is investigating...
```

### 8. Agent performs useful work

Codex investigates the repository.

### 9. Result becomes visible

For example:

```text
Alex

I found a race condition in the token refresh flow.

I've prepared a fix and added a regression test.

[View work]
```

### 10. Artifact is associated with project

For example a GitHub pull request.

### 11. Run history remains inspectable

The user can see:

* originating request
* agent
* status
* relevant activity
* resulting artifact
* completion result

If the architecture cannot support this journey cleanly, reconsider it.

---

# 36. Second Validation Journey — Coordination

After the single-agent journey works, validate cross-agent coordination.

Example:

```text
James

@Maya work out why signup conversion has dropped and come back with a recommendation.
```

Maya may orchestrate:

```text
Ada
Analyse conversion metrics.

Alex
Investigate relevant code/deploy changes.
```

Maya receives their results and synthesises:

```text
Two likely causes:

1. OAuth failures increased after Tuesday's release.
2. Pricing experiment increased abandonment.

Alex has prepared an OAuth fix.
Ada has attached the funnel analysis.
```

This should be considered a later milestone than reliable single-agent execution.

---

# 37. UX Principles

## Familiar first

The collaboration surface should initially feel recognisable to Slack/Discord users.

Do not invent unusual navigation merely to emphasise AI.

---

## Agent state should be visible

Users should be able to tell whether an agent is:

* idle
* queued
* working
* waiting
* blocked
* awaiting approval
* completed
* failed

---

## Results over chatter

Prefer:

```text
Investigating...
3 relevant actions
1 result
```

over dozens of agent messages.

---

## Human control

Humans should be able to:

* cancel work
* redirect work
* approve actions
* deny actions
* ask follow-up questions
* inspect outcomes

---

## Persistent work

Closing a browser tab must not conceptually destroy a delegated task.

Agent work belongs to the workspace, not to a frontend request lifecycle.

---

# 38. Observability

Debugging agent behaviour will be important.

The product needs an internal distinction between:

### User-visible information

* run state
* useful progress
* result
* artifacts
* errors that matter

### Internal execution information

* provider request IDs
* tool activity
* timing
* token/resource usage where available
* provider errors
* retries
* orchestration events

Do not expose private model reasoning.

Provide enough structured execution data to debug why a run succeeded or failed.

---

# 39. Cost and Resource Management

Eventually the system may need:

* per-workspace usage
* per-agent usage
* concurrency limits
* runtime selection
* budgets
* task priorities
* rate limits

For the MVP, design clean seams without prematurely building a sophisticated scheduler.

---

# 40. Open Questions for Wayfinder

The following areas should be treated as genuine uncertainty and explored rather than assumed.

## Codex

* What is the best supported integration mechanism?
* How should users connect their Codex/OpenAI identity?
* What functionality is available through subscription-based Codex access?
* What requires API billing?
* How should long-running Codex sessions map to AgentRuns?
* How should Codex workspace/repository access be sandboxed?
* What concurrency constraints exist?

## Agent Runtime

* Which runtime interface is actually needed?
* Where does execution occur?
* Does execution live in the SvelteKit process, a worker, or another service?
* How are runs resumed?
* How are runs cancelled?
* How is crash recovery handled?

## Realtime

* Which realtime approach best fits SvelteKit and likely hosting?
* How are agent-run events delivered?
* What level of guaranteed delivery is required?

## Persistence

* Should AgentRun events use an event log?
* What run data should be durable?
* How should external artifacts be represented?

## Context

* What is the minimum viable project context system?
* How are resources indexed?
* When is vector search actually justified?
* How are historical decisions retrieved?
* How are permissions applied during retrieval?

## Permissions

* How should action-level agent permissions be represented?
* Which actions need approval in the MVP?
* How are permissions enforced at the tool boundary?

## Queueing

* Is PostgreSQL sufficient initially?
* When would a dedicated queue be justified?
* Is Temporal useful later, or unnecessary complexity?

## Deployment

* What does self-hosting look like?
* What processes/services are required?
* How are agent workers deployed?
* How are secrets configured?

## Authentication

* What auth approach best supports the self-hosted direction?
* How should workspace invitations work?

## GitHub

* GitHub App versus OAuth/user credentials?
* Which capabilities belong in v1?
* How should repository permissions interact with agent permissions?

## Jitsi

* Embedded versus external call UX?
* Self-hosted versus hosted Jitsi?
* How should room identity/access control work?

---

# 41. Questions Wayfinder Should Not Reopen Without Evidence

These choices are currently settled:

```text
Framework:
SvelteKit

Language:
TypeScript

UI:
Tailwind CSS + daisyUI

Primary database:
PostgreSQL

Calls for MVP:
Jitsi

Core product model:
Humans and agents are first-class workspace members.

Projects:
First-class context boundaries.

Execution:
AgentRun is separate from Message.

Provider architecture:
Agent identity is independent of runtime/provider.

Infrastructure philosophy:
Start simple and introduce distributed infrastructure when justified.
```

---

# 42. Wayfinder Goal

Use Wayfinder to determine the safest and clearest route to the MVP.

Do not translate this entire document directly into implementation issues.

First determine:

1. what we know
2. what we do not know
3. which uncertainties can materially change the architecture
4. which questions require research
5. which questions require a prototype
6. which decisions can be made immediately
7. which decisions can safely be deferred

The Wayfinder map should progressively convert uncertainty into decisions.

---

# 43. Suggested Early Wayfinder Frontier

The first decision/prototype frontier should probably include questions similar to:

```text
1. Prove Codex connectivity and execution model.

2. Determine the durable AgentRun architecture.

3. Prove realtime agent-run updates in SvelteKit.

4. Establish the core Workspace / Member / Agent /
   Project / Channel / Message / AgentRun domain model.

5. Determine self-hosted authentication strategy.

6. Prove GitHub repository access from an engineering agent.

7. Establish agent tool-permission and approval boundaries.

8. Prototype the primary workspace/channel/agent UX
   using SvelteKit + daisyUI.

9. Determine the smallest deployment architecture
   capable of surviving/recovering long-running agent work.
```

Wayfinder should change this frontier if investigation reveals a better decomposition.

---

# 44. Desired Outcome of Wayfinding

Before large-scale implementation begins, we should have:

* a clear system boundary
* a validated Codex integration strategy
* a validated AgentRun lifecycle
* a credible execution/worker model
* a settled initial database/domain model
* a realtime strategy
* an authentication decision
* a GitHub integration decision
* an initial permission model
* a deployment model
* an MVP user journey
* prototypes for the riskiest assumptions
* a list of intentionally deferred concerns

At that point the project should be clear enough to produce a detailed specification and implementation tickets.

---

# 45. Product North Star

Throughout planning and implementation, use this question to resolve ambiguity:

> Does this make AI agents better collaborators and workers inside a human team, or does it merely add more AI chat?

Prefer the former.

The core product is not:

> Slack with AI bots.

It is:

> **A collaborative operating environment where humans and specialised AI agents can communicate, organise projects, delegate persistent work, use tools, create artifacts, and make progress together.**
