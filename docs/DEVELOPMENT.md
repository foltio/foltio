# Development

## Prerequisites

- Node.js 22.6 or newer
- PostgreSQL 16 or newer
- S3-compatible object storage
- ffmpeg and ffprobe; melt is used for final compositions

Install dependencies with `npm install`. The API reads `.env.local` at startup. Docker Compose is the easiest way to inspect the complete set of working environment values.

Run the API and Vite in separate terminals:

```bash
npm run migrate
npm run dev
npm run web:dev
```

The development web server listens on `127.0.0.1:5199` and proxies API/MCP requests to `127.0.0.1:8810`.

## Checks

```bash
npm run check
```

This runs the Node tests and a production TypeScript/Vite build. CI also scans committed content for secrets and builds both Docker targets.

## Database changes

Never modify a migration that has shipped. Add the next numbered SQL file under `migrations/`. Migrations run in lexical order and each file is applied in one transaction.

## Design constraints

- Keep media bytes out of PostgreSQL.
- Preserve optimistic revision checks on timeline mutations.
- Keep MCP results useful without requiring a particular client UI.
- Make paid generation quote-first and failure-refundable.
- Never add production credentials, customer data, deployment IPs, or local key paths.
