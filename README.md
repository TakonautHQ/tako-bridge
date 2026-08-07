# Tako Bridge

Tako Bridge is Takonaut's open-source developer workflow extension for the [Pi agent harness](https://github.com/earendil-works/pi). It brings assigned Takonaut work, governed Project Context, repository verification, durable recovery, tests, and human-reviewed completion evidence into a local Pi session.

Tako Bridge is interactive and bound to one signed-in Takonaut user. The unattended, organization-owned execution service is the separate [Tako Runner](https://github.com/TakonautHQ/tako-runner) project.

## Requirements

- macOS or Linux
- [Pi 0.84](https://github.com/earendil-works/pi) or a compatible newer release
- Git
- [GitHub CLI](https://cli.github.com/) authenticated with access to the connected repository
- Repository-local or effective `git config user.name` and `git config user.email`
- A Takonaut organization with **Developer Agents** enabled
- An assigned work item whose Project Agent Setup contains authorized GitHub Code Workspaces

Tako Bridge refuses to start work when repository identity, GitHub access, Git identity, branch policy, worktree state, or the server-signed execution manifest cannot be verified.

## Install

Install a pinned Git tag so updates are deliberate:

```bash
pi install git:github.com/TakonautHQ/tako-bridge@v0.1.0
```

Start Pi, then run:

```text
/tako-setup
/tako-login https://takonaut.app
/tako-status
```

`/tako-setup` reviews the installed Pi packages, asks before changing user-level Pi settings, and installs missing pinned companion packages:

- `pi-subagents`
- `pi-lens`
- `@juicesharp/rpiv-ask-user-question`

Pi packages and extensions execute with the permissions of your operating-system account. Review these packages before approving installation.

For local development:

```bash
git clone git@github.com:TakonautHQ/tako-bridge.git
cd tako-bridge
bun install --frozen-lockfile
pi -e "$PWD/src/index.ts"
```

## Typical workflow

```text
/tako-tasks
/tako-start PAY-142
```

Tako Bridge verifies the server-selected repositories and revisions, provisions managed worktrees, records durable local state, and injects the approved Context into Pi. It does not silently merge or deploy code.

During the run, use the commands requested by the active Playbook. A common completion flow is:

```text
/tako-context IMPLEMENT
/tako-confirm-context SNAPSHOT_ID OBSERVATION_HASH
/tako-plan SNAPSHOT_ID Implement the approved change and regression tests
/tako-agentic-test api backend/scripts/test.sh tests/path/test_file.py
/tako-complete SNAPSHOT_ID
/tako-finalize REVIEW_REQUEST_ID
/tako-cleanup
```

Human decisions remain in Takonaut's Review queue. Approval completes the governed work; it does not merge or deploy the Pull Request.

## Commands

### Connection and discovery

| Command | Effect |
| --- | --- |
| `/tako-setup` | Review and install missing pinned Pi companion packages, then reload resources. |
| `/tako-login [api-base-url]` | Connect through device authorization. HTTPS is required except for explicit loopback development. |
| `/tako-status` | Reconcile this Pi session with the durable Agentic Delivery run. |
| `/tako-reconnect` | Explicitly authorize a replacement personal Pi key for retained state. |
| `/tako-tasks` | List assigned Takonaut work that can be started. |

### Agentic Delivery

| Command | Effect |
| --- | --- |
| `/tako-start TASK-KEY [--base-ref WORKSPACE=REF --reason WHY]` | Reserve a run, verify its signed manifest, and provision governed worktrees. |
| `/tako-context NODE` | Collect and record bounded local Context for the current Playbook node. |
| `/tako-confirm-context SNAPSHOT HASH` | Confirm the exact Context Snapshot and observation hash. |
| `/tako-plan SNAPSHOT MARKDOWN` | Submit a snapshot-bound implementation plan. |
| `/tako-step STEP ATTEMPT running\|failed\|completed [summary]` | Record one Step transition. |
| `/tako-answer STEP ATTEMPT ANSWER` | Answer a bounded Playbook prompt. |
| `/tako-retry STEP ATTEMPT` | Retry the current failed Step. |
| `/tako-route JSON` | Resolve a graph route from bounded evidence. |
| `/tako-resolve-gate STEP EDGE RATIONALE` | Resolve a configured human gate explicitly. |
| `/tako-agentic-test WORKSPACE COMMAND` | Run and record a head-bound test for one Code Workspace. |
| `/tako-complete SNAPSHOT` | Propose exact completion evidence for review. |
| `/tako-resume-review REQUEST` | Resume after a Review queue decision. |
| `/tako-finalize REQUEST` | Reverify approved evidence and finalize completion. |
| `/tako-cancel-ack` | Acknowledge an observed cancellation request. |
| `/tako-diagnostics WORKSPACE PATH` | Explicitly redact and upload one bounded diagnostic file. |
| `/tako-cleanup` | Safely remove retained terminal managed worktrees while keeping branches. |

### Legacy Bridge compatibility

| Command | Effect |
| --- | --- |
| `/tako-test COMMAND [ARGS]` | Run and record Proposal test evidence after sensitive-value and local-policy checks. |
| `/tako-submit [summary]` | Verify the open GitHub PR at the current commit and submit it to the Review queue. |
| `/tako-current` | Reconcile durable local and server run state. |
| `/tako-resume` | Resume retained Agentic Context confirmation or a legacy Bridge run. |
| `/tako-abandon [reason]` | Release an unfinished legacy run without deleting local changes. |

## Security boundary

Tako Bridge provides guardrails, provenance, and review gates; it is **not an operating-system sandbox**.

It verifies repository identity, signed manifests, branches, worktrees, protected paths, Pull Request evidence, and selected dangerous command patterns. Sensitive command values are rejected before test execution and bounded summaries are redacted. Unknown Pi extensions, opaque subagents, models, and commands may still execute with your local user permissions.

Run Pi only on a trusted machine and review tool permissions before starting governed work. Never place production secrets in prompts, command arguments, repositories, or diagnostic files. See [SECURITY.md](SECURITY.md) for vulnerability reporting and the complete trust boundary.

## Credentials and local state

Bearer credentials are stored separately from non-secret repository mappings:

```text
~/.takonaut/credentials.json  # owner-only 0600
~/.takonaut/bridge.json       # non-secret mappings and branch settings
```

Agentic Delivery state is scoped by organization and Pi session:

```text
~/.takonaut/agentic-delivery/<organization-id>/<pi-session-id>.json
```

Legacy Bridge runs remain under:

```text
~/.takonaut/runs/<organization-id>.json
```

Writes are atomic. Bridge rejects malformed files, symlinks, wrong ownership, permissive credential modes, partial environment credentials, non-HTTPS remote endpoints, and device responses that move credentials to another origin.

## Operational telemetry

While an Agentic Delivery run is active, Tako Bridge sends an operational snapshot approximately every five seconds. It contains:

- run and Pi session identifiers
- the work-item key used in the executor label
- executor phase/status
- start, last-activity, and observation timestamps

It does **not** include repository source, prompts, raw transcripts, tool output, diffs, credentials, or local absolute paths. Reporting stops when the run is terminal, the feature is disabled, or the extension session ends. Lifecycle observation is part of an active governed run and has no independent opt-out; do not start a run when organizational policy does not permit this metadata.

Diagnostic uploads are separate, user-invoked actions. `/tako-diagnostics` reads only one bounded regular file inside a managed Code Workspace, rejects symlinks and high-risk material, redacts secrets and local paths, previews the action, and requires confirmation.

## Development

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run pack:check
bun audit
```

The package uses Pi's host-provided extension API as a peer dependency and does not bundle Tako Runner or a second Pi runtime.

## License

Apache-2.0. See [LICENSE](LICENSE).
