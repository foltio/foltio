# FOLTIO

An open-source studio for film. FOLTIO combines a browser-based nonlinear editor with an MCP server, so people and AI agents can work on the same project and timeline.

> Early release: the self-hosted edition is ready for local evaluation, not yet hardened for an untrusted public network.

## What is included

- Multi-track video, audio, image, title, caption, and effects editing
- Upload, ingest, proxy generation, frame previews, rendering, and quality checks
- Revisioned edits with undo-friendly operation batches
- Public-by-default projects with a one-click private setting
- An MCP interface for Claude Code, Codex, Cursor, and other compatible agents
- Optional image, video, voice, music, and sound generation through fal
- A local owner mode with no OAuth, analytics, billing, or hosted agent required

The hosted service at [folt.io](https://folt.io) adds managed infrastructure and product services that are not part of this repository.

## Run locally

Requirements: Docker Engine with Compose v2, 8 GB RAM recommended, and ports `3000`, `9000`, and `9001` available.

```bash
git clone https://github.com/foltio/foltio.git
cd foltio
cp .env.example .env
docker compose up --build
```

Open [localhost:3000](http://localhost:3000). MinIO's storage console is at [localhost:9001](http://localhost:9001).

Data lives in named Docker volumes. Stop the application with `docker compose down`; this preserves projects and media. `docker compose down -v` permanently removes local data.

### Connect an AI agent

Open **Settings** in FOLTIO and create an API key. The page gives you the exact MCP command for your installation. The endpoint is:

```text
http://localhost:3000/mcp
Authorization: Bearer sk_studio_…
```

The server also publishes its agent guide at `http://localhost:3000/skill.md`.

### Enable generation

Editing, uploading, and rendering work without an AI provider. For generation, set `FAL_KEY` in `.env`, then restart the API:

```bash
docker compose up -d --force-recreate api
```

Generation can incur provider charges. Use quotes and account limits before starting paid jobs.

## Development

```bash
npm install
cp .env.example .env.local  # edit the database and storage values for your setup
npm test
npm run web:build
```

See [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md), and [Self-hosting](docs/SELF_HOSTING.md) for the full setup and security model.

## Project status

The first public line is deliberately small: one repository for the editor, media pipeline, MCP server, and local deployment. The proprietary folt.io production configuration and hosted-agent runtime remain separate. Public releases will be tagged; hosted deployments consume those releases rather than maintaining a copied fork.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

FOLTIO is licensed under the [GNU Affero General Public License v3.0](LICENSE). The FOLTIO name and logo are trademarks; see [TRADEMARKS.md](TRADEMARKS.md).
