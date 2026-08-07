# Security Policy

## Supported versions

Only the latest released minor version receives security fixes. Takonaut may block obsolete Bridge versions when a protocol, credential, or provenance defect makes continued use unsafe.

## Reporting a vulnerability

Email **<security@takonaut.com>** with the affected version, reproduction steps, impact, and proposed remediation. Do not include production credentials, customer source code, raw transcripts, or unredacted diagnostics.

Please do not open a public issue until Takonaut confirms that coordinated disclosure is safe. We will acknowledge receipt, investigate, and provide status updates through the reporting channel.

## Trust boundary

Tako Bridge runs inside Pi with the permissions of the installing operating-system user. It is not a VM, container, or general-purpose sandbox. Pi extensions, companion packages, models, subagents, and approved commands may execute local code.

Bridge adds repository verification, signed-manifest checks, managed worktrees, protected-path and branch rules, selected command blocking, bounded evidence, redaction, durable state, and human review. These controls do not make arbitrary local code safe.

Use a trusted machine and a least-privilege GitHub account. Review all Pi packages before installation. Never place credentials in prompts or command arguments. Device login and MCP transport require HTTPS except for explicit loopback development, and returned credential endpoints must remain on the login origin.

If a Bridge key or workstation may be compromised, disconnect the device in Takonaut, remove the local credential profile, and reauthorize with `/tako-login`.
