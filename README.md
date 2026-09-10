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

Install a pinned Git tag from the project you are working in. Project-local installation is recommended so Tako Bridge commands and policy hooks load only in that project:

```bash
cd /path/to/your/project
pi install git:github.com/TakonautHQ/tako-bridge@v0.4.17 -l
```

Pi records the package in `.pi/settings.json` and installs it after the project is trusted. To intentionally load Tako Bridge in every Pi project, omit `-l`. If an older release is already installed globally, use `pi list`, remove the exact global source shown there with `pi remove SOURCE`, and then install it locally.

Start Pi in that project, then run:

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
| `/tako-login [api-base-url]` | Connect through device authorization, verify the caller-filtered MCP catalog, and replace an exact legacy project-local Takonaut MCP entry. HTTPS is required except for explicit loopback development. |
| `/tako-logout` | Disconnect, disable every Bridge-managed MCP tool, and remove only the active organization's stored credential while preserving other organization profiles. |
| `/tako-status` | Reconcile this Pi session with the durable Agentic Delivery run. |
| `/tako-reconnect` | Explicitly authorize a replacement personal Pi key for retained state. |
| `/tako-tasks` | Search current assigned work by key, title, Project, Sprint, or Stage, then open the selected item in Takonaut. Sprint Projects show the active Sprint; Kanban Projects show pulled, unarchived board work. |
| `/tako-panel` | Configure the persistent Tako Bridge panel above Pi's prompt editor. |
| `/tako-standup` | Draft a Standup from the current Pi session and bounded Git activity, then open the reviewed draft in Takonaut. |

### Authorized Takonaut MCP tools

After authentication, Bridge discovers Takonaut's caller-filtered MCP catalog and registers each reviewed public tool in Pi as `tako_mcp_<server_tool_name>`, for example `tako_mcp_list_tasks` or `tako_mcp_create_task`. The active set follows the selected organization, live membership, feature flags, current RBAC grants, and the personal key's permission ceiling. Those checks run again on every call; discovery is never treated as authorization. Re-authentication replaces the active Takonaut tool set, disables stale tools, and preserves tools owned by Pi or other integrations.

Direct `tako_mcp_*` mutations execute immediately after server authorization, without an additional Bridge confirmation prompt. Use the stable governed gateway when you want preview-and-confirm behavior:

- `tako_search_capabilities` returns at most five authorized self-service capabilities.
- `tako_read` runs one bounded read.
- `tako_action` prepares a supported mutation, shows a redacted preview and argument digest, and executes only after local confirmation.

Public MCP tools are deny-by-default. Platform/operator functions, organization administration, approvals, Standup submission, unreviewed legacy handlers, outbound web search, and internal Bridge protocol tools are not registered for the model. Project- and record-scoped tools repeat target-resource and ownership checks in the handler. Generic arguments and returned previews are bounded to 8 KB.

On successful `/tako-login`, Bridge also removes `mcpServers.takonaut` from the current project's `.mcp.json` only when it is an exact HTTPS Takonaut personal-key entry. It never copies the new Bridge credential into that file, never removes unrelated MCP servers, and refuses unsafe or nonmatching files. Other saved Takonaut organization profiles remain available for organization switching.

Creating a Task through the governed `tako_action` path still requires `tasks.create` on the selected Project and an active Sprint; Kanban Projects and Projects without an active Sprint are refused. Personal MCP-created Tasks default to the authenticated member as owner and retain the selected Stage's Track so later Stage moves resolve against the configured Delivery flow. Prepared actions expire after five minutes, are bound to the exact user, organization, device key, capability, and arguments, and are replay-safe across server workers.

### Pi status panel and Standup draft

In interactive Pi sessions, Tako Bridge shows a compact panel above the prompt editor with connection state, the active run, ready/blocked totals, configured Stage-name counts, current task rows, and the selected Project's Standup status. Use `/tako-panel` to show or hide sections, set the task-row limit to 1, 3, 5, or 10, change the refresh interval, select the Standup Project, or enable the optional Debug block. Debug shows safe panel-refresh, telemetry, and reconciliation timing/status details without credentials or payload contents. Preferences are stored in the non-secret `~/.takonaut/bridge.json` file.

`/tako-standup` asks before sending the current Pi conversation and bounded Git log/status summaries to the developer's configured Pi model. The generated sections open in an editor for review. Only after a second confirmation does Bridge upload the reviewed draft to Takonaut for 15 minutes and open the authenticated Standup form in the system browser. It never submits the Standup automatically.

### Agentic Delivery

| Command | Effect |
| --- | --- |
| `/tako-start TASK-KEY [--base-ref WORKSPACE=REF --reason WHY]` | Reserve a run, verify its signed manifest, and provision governed worktrees. |
| `/tako-context NODE` | Collect and record bounded local Context for the current Playbook node. |
| `/tako-resume [SNAPSHOT HASH NODE]` | Resume Agentic Context after exact local revalidation. |
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

## Security boundary

Tako Bridge provides guardrails, provenance, and review gates; it is **not an operating-system sandbox**.

It verifies repository identity, signed manifests, branches, worktrees, protected paths, Pull Request evidence, and selected dangerous command patterns. Sensitive command values are rejected before test execution and bounded summaries are redacted. Unknown Pi extensions, opaque subagents, models, and commands may still execute with your local user permissions.

Run Pi only on a trusted machine and review tool permissions before starting governed work. Never place production secrets in prompts, command arguments, repositories, or diagnostic files. See [SECURITY.md](SECURITY.md) for vulnerability reporting and the complete trust boundary.

## Credentials and local state

Bearer credentials are stored separately from non-secret repository mappings:

```text
~/.takonaut/credentials.json  # owner-only 0600
~/.takonaut/bridge.json       # non-secret mappings, panel settings, and branch settings
```

Agentic Delivery state is scoped by organization and Pi session:

```text
~/.takonaut/agentic-delivery/<organization-id>/<pi-session-id>.json
```

Writes are atomic. Bridge rejects malformed files, symlinks, wrong ownership, permissive credential modes, partial environment credentials, non-HTTPS remote endpoints, and device responses that move credentials to another origin.

## Operational telemetry

While an Agentic Delivery run is active, Tako Bridge sends an operational snapshot approximately every five seconds. It contains:

- run and Pi session identifiers
- the work-item key used in the executor label
- executor phase/status
- start, last-activity, and observation timestamps

It does **not** include repository source, prompts, raw transcripts, tool output, diffs, credentials, or local absolute paths. Reporting stops when the run is terminal, the feature is disabled, or the extension session ends. Lifecycle observation is part of an active governed run and has no independent opt-out; do not start a run when organizational policy does not permit this metadata.

Standup drafting is separate from operational telemetry. `/tako-standup` explicitly asks before sending the current conversation and bounded Git summaries to the configured Pi model. Only the draft the developer reviews and confirms is uploaded to Takonaut; the underlying conversation and Git output are not uploaded by Bridge.

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
