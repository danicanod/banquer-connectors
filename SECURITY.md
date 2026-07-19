# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in `@danicanod/banquer-connectors`,
please report it **privately** by emailing **danicanod@icloud.com**. Do not open a
public GitHub issue for security problems.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version(s).

You can expect an initial acknowledgement, and we'll coordinate a fix and
disclosure timeline with you.

## Handling credentials

This library authenticates against live bank accounts. When using it:

- **Never commit** `.env` files or credentials. Store secrets in environment
  variables or a secrets manager.
- All bank connections use HTTPS.
- Debug logs (`debug-<bank>-*.log`) may contain sensitive request data — they are
  git-ignored; do not share them publicly.
- Treat session cookies extracted after login as secrets.

## Supported versions

Security fixes are applied to the latest published major version.
