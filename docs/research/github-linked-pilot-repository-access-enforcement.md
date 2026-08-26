# GitHub access and enforcement for the linked pilot repository

## Decision

Use a **dedicated GitHub App**, installed on **only the one linked pilot
repository**, as the MVP engineering agent's GitHub identity. Relay holds the App
private key and mints short-lived installation tokens server-side per AgentRun; it
never gives a token, private key, or a human's personal access token to the browser
or to an unbounded agent shell.

Give the App only these repository permissions:

| Permission | Level | Why it is needed |
| --- | --- | --- |
| Metadata | read | Repository identification and normal API discovery; it is a standard GitHub App repository permission. |
| Contents | write | Clone/fetch/push the linked repository and create the agent's commits and topic branches. GitHub documents Contents as the permission required for HTTP Git access. |
| Pull requests | write | Open and update the review artifact. GitHub documents this as the permission for the create-pull-request endpoint. |

Do **not** request Administration, Actions/Workflows, Deployments, Environments,
Secrets, Variables, Webhooks, Issues, Releases, Packages, or organization/account
permissions. In particular, Contents write does not imply Administration: repository
creation/deletion, settings, teams, and collaborator management are an Administration
permission. GitHub Apps start with no permissions and GitHub recommends selecting the
minimum required permissions. [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

The App must be installed with **Only select repositories**, selecting exactly the
linked pilot repository. GitHub exposes that installation choice and its generated
installation token cannot exceed the installation's repository or permission scope.
Relay should nevertheless request that exact repository and only the above
permissions for every token; the token expires after one hour. [Installing an App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

This fits the settled MVP boundary: both Pilot members may invoke the shared MVP
engineering agent, while GitHub access is a workspace-owned provider connection and
the agent is allowed to create a branch, commits, and a pull request—but not merge,
administer, deploy, or take destructive action.

## Important limit: GitHub permission selection alone is not the whole boundary

GitHub's permission model deliberately groups several Git operations under Contents
write. That permission is required for HTTP Git access, and GitHub's REST
documentation includes creating and deleting Git references among the endpoints that
accept it. The pull-request merge endpoint also accepts a GitHub App installation
token with Contents write. Therefore it is not accurate to claim that an App with
these minimum permissions is cryptographically unable to delete a topic branch or
attempt a merge. [Git access with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access) [Git references API](https://docs.github.com/en/rest/git/refs) [Pull requests API](https://docs.github.com/en/rest/pulls/pulls)

The consequence is a two-layer enforcement design:

1. **GitHub is the remote repository guard.** Before connecting the repository,
   configure a ruleset (or equivalent protected-branch configuration) for the
   default/release branches: require a pull request, at least one required review,
   approval by someone other than the last pusher, dismissal of stale approvals,
   required status checks as appropriate, and block force pushes and deletions. Do
   not grant the Relay App a bypass. GitHub rulesets can require PRs and reviews;
   required reviews restrict pushes to changes approved through PRs, and the
   last-pusher option requires another authorised reviewer. Rulesets can grant bypass
   to specific GitHub Apps, hence the explicit requirement to omit Relay. [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) [Creating repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
2. **Relay is the agent-action guard.** Keep the private key and installation token
   inside a server-side GitHub broker. An unbounded agent shell never receives a Git
   credential; the broker performs GitHub operations after validating the worker's
   structured request. The broker
   allow-lists: read/clone/fetch, create a `relay/<agent-run-id>` branch, non-force
   updates to that branch, and creation/update of that branch's PR. It rejects delete
   ref, force push, writes to default/release branches, every merge API route,
   repository/settings/collaborator operation, deployment/release/workflow mutation,
   and any repository other than the stored linked repository. This is a Relay
   enforcement requirement inferred from the documented breadth of Contents write,
   rather than a capability GitHub itself offers at that granularity.

GitHub rules prevent a successful protected-branch update or merge even if the
worker is compromised; the broker prevents the agent from using its otherwise broad
write authority against unprotected topic branches. The local execution sandbox and
per-AgentRun workspace from the existing Recoverable AgentRun decision remain a
separate control: they protect the host and working copy, whereas this design
protects the GitHub remote.

## Credential and execution flow

1. An owner connects the App to the single linked pilot repository and Relay stores
   the App ID, installation ID, repository node/owner/name, permitted default branch,
   and encrypted private-key reference. It stores no human GitHub password or PAT.
2. When a claimed AgentRun reaches its Git step, the broker creates an installation
   token narrowed to that installation's one repository and the needed permissions.
   It retains and rotates the token before expiry; it must not assume a token has a
   fixed string format, as GitHub is rolling out a new installation-token format.
3. The broker maps the run to one generated `relay/<run-id>` branch and records the
   base SHA before the first push. It accepts only the allowed operations above, then
   returns commit SHA(s) and PR URL/number to the AgentRun event stream.
4. A human reviews and merges in GitHub. Relay does not offer a merge action and the
   App has no ruleset bypass. Disconnecting/replacing the provider connection disables
   new token minting and removes the broker's credential reference.

## Audit evidence

Relay must preserve an append-only, attributed audit record independently of GitHub:
the requesting Pilot member and source message, AgentRun and attempt ID, installation
and repository ID, ruleset verification, broker allow/deny decision, operation/method
and redacted path, branch, base and resulting SHA, PR number/URL, token expiry (never
the token), timestamps, and terminal provider result. This supplies the product's
durable explanation of *why* an App action happened, including denied destructive
attempts.

Use GitHub as corroborating evidence: the App identity on branch/commit/PR history,
the PR timeline and review/merge records, and signed `push` and `pull_request`
webhooks. Store every accepted webhook payload with its delivery GUID and correlate
its installation ID, repository ID, SHA, and PR number to the Relay record. Validate
the `X-Hub-Signature-256` HMAC before accepting a delivery; GitHub explicitly
recommends signature validation to establish that the payload came from GitHub and was
not altered. [Webhook delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) [Webhook delivery headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

If the pilot repository belongs to an organisation whose GitHub plan provides audit
logs, retain the relevant organisation audit-log events as additional evidence.
Treat this as supplementary rather than the MVP's sole audit system: audit-log
availability and retention are plan-dependent, while Relay needs durable AgentRun
history in every self-hosted pilot.

## Alternatives and acceptance checks

A fine-grained personal access token is a less suitable MVP credential: it is tied to
a human identity and lifecycle, weakening the required shared-agent attribution and
owner-controlled connection boundary. A GitHub App has its own identity and can be
installed on a selected repository without user authorisation to act as a human.
[About using GitHub Apps](https://docs.github.com/en/apps/using-github-apps/about-using-github-apps)

Before enabling the connection, verify with a disposable agent run that it can clone,
create `relay/<run-id>`, push commits, and open a PR, but that attempts to push or
force-push the default branch, delete a branch, merge the PR, edit repository
settings, change a workflow, or create a deployment are denied by the broker and/or
GitHub. Record those results as the initial connection audit evidence. If the linked
repository cannot enforce the required protected-branch/ruleset policy under its
GitHub plan, do not enable autonomous PR creation for that repository until an
equivalent enforced policy is in place.
