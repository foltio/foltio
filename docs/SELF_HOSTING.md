# Self-hosting

## Supported starting point

Docker Compose is the reference deployment. It runs PostgreSQL, MinIO, the API/worker, and nginx on one machine. The browser and storage ports bind to `127.0.0.1` by default.

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
curl --fail http://localhost:3000/health
```

## Data and backups

Back up all three stateful volumes together:

- `foltio_postgres-data` — accounts, projects, timeline documents, and job state
- `foltio_minio-data` — uploaded and generated media, proxies, and renders
- `foltio_work-data` — resumable worker files; useful but reconstructable

A database-only backup is incomplete because project records reference object-storage keys.

## Configuration

The reference `.env.example` contains every value normally needed locally. Important server variables include:

- `STUDIO_DATABASE_URL` — PostgreSQL connection string
- `STUDIO_S3_ENDPOINT` — server-facing S3 endpoint
- `STUDIO_S3_PUBLIC_ENDPOINT` — browser-reachable endpoint used in signed URLs
- `STUDIO_PUBLIC_ORIGIN` — browser origin used for links and MCP metadata
- `FAL_KEY` — optional generation provider key

S3-compatible services must support presigned PUT and GET requests. Set path-style addressing for MinIO.

## Network security

Local mode trusts every request as the owner. Do not bind it to a public interface, place it behind a public tunnel, or share it on an untrusted LAN. For remote access, add TLS and a real authentication boundary before changing the port bindings.

Projects are public by default at the application level. In a local installation, “public” means visible through a share route to anyone who can already reach that installation. Change a project's visibility in the editor.

## Updating

Back up the volumes, then:

```bash
git pull --ff-only
docker compose build
docker compose up -d
```

The one-shot `migrate` service applies new migrations before the API starts. Migrations are forward-only; test upgrades against a restored backup before production use.
