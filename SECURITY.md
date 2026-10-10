# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email **hello@folt.io** with:

- the affected component and version or commit;
- steps to reproduce;
- the likely impact;
- any suggested mitigation.

We will acknowledge a report as soon as practical and coordinate disclosure after a fix is available. Please avoid accessing other people's data, disrupting services, or publishing details before that coordination.

## Supported versions

Until the first stable release, security fixes are made on `main` and included in the next tagged release. Self-hosters should follow release notes and keep their deployment current.

## Local-mode warning

The reference Docker deployment uses a trusted, single-owner mode with no browser authentication. Its ports bind to localhost intentionally. Do not expose local mode directly to the internet.
