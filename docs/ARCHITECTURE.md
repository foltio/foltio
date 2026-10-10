# Architecture

FOLTIO is a single Node.js service plus a React web client. PostgreSQL is the source of truth; S3-compatible object storage holds original media, proxies, frames, and renders.

```text
browser / MCP client
         │
       nginx
      ┌──┴───────────────┐
 React static app     Node API + MCP
                            │
                 ┌──────────┴──────────┐
              PostgreSQL        S3 / MinIO
                                    │
                             ffmpeg + melt worker
```

## Repository map

- `web/` — React/Vite editor and project library
- `server/` — HTTP API, MCP tools, project operations, jobs, and media pipeline
- `server/gen/` — model catalogue and generation adapters
- `migrations/` — ordered, append-only PostgreSQL migrations
- `skills/` — agent-facing editing guidance
- `test/` — Node test suite for timeline, media, generation, billing, and public views
- `docker/` — local reverse proxy and object-storage configuration

## Project model

A project stores one versioned JSON document containing its canvas, tracks, and timeline items. Every applied operation creates a commit with the resulting document. Media assets and asynchronous jobs are relational records linked to the project. Large bytes never enter PostgreSQL.

The API uses optimistic concurrency: edits include a base revision and fail rather than silently overwriting a newer human or agent change.

## Deployment modes

`FOLTIO_LOCAL_MODE=1` creates one trusted local owner and bypasses browser OAuth. Docker Compose uses this mode. It must not be exposed to an untrusted network.

The hosted mode supports Supabase sessions, personal MCP keys, credit controls, and managed services. Production credentials and deployment definitions intentionally live outside this repository.

## Release flow

`main` is the releasable open-source core. Releases are tagged using semantic versions. The hosted deployment pins a release and carries only environment-specific adapters, making upstream fixes flow forward without copying source between repositories.
