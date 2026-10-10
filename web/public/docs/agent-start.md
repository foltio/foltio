# Connect an agent to FOLTIO

API origin: https://folt.io
Documentation index: https://folt.io/llms.txt
OpenAPI: https://folt.io/api/openapi.json
Native MCP: https://folt.io/mcp

FOLTIO is an AI film studio with a real multitrack editor. Agents and people work on the same projects and versioned timelines. An agent can use ordinary HTTPS or native MCP; both expose the same operations and accept the same credential.

## Do this first

Resume a saved credential for `https://folt.io` by calling `GET /api/agent/start`. If it works, show the person the connected account and recent projects. Otherwise start a browser-approved connection immediately and give the person its link before reading the rest of this guide.

Never ask for a password, browser cookie, OAuth callback, email verification code or Supabase token.

### 1. Start a connection

```http
POST https://folt.io/api/agent/connections
Content-Type: application/json

{"client_name":"My coding assistant"}
```

The response contains a private `device_code`, a short `verification_uri`, `expires_in`, `interval`, and the API origin. Keep `device_code` secret. Save it only in a private credential store outside the project.

### 2. Give the person the link immediately

Say:

> [Open FOLTIO to connect](<verification_uri>). Sign in if needed, then choose **Connect agent**. I will continue automatically.

Also print the bare URL so terminals make it clickable. Do not operate the person's browser or ask them to copy a token back to you.

### 3. Poll until connected

No more often than the returned `interval`:

```http
POST https://folt.io/api/agent/connections/token
Content-Type: application/json

{"device_code":"<private device_code>"}
```

- `202 pending`: keep waiting.
- `200 connected`: save `access_token` with user-only permissions. It works for REST and MCP for 90 days.
- `200 denied`: stop; make a new request only if the person asks.
- `410 expired`: start a new connection and show the new link.
- `401` later: the credential expired or was revoked; reconnect.

Never print polling responses containing credentials into chat or logs. Send the token only to the exact `api_url` returned by FOLTIO.

### 4. Start working

```http
GET https://folt.io/api/agent/start
Authorization: Bearer <access_token>
```

This returns the connected account, credit guardrails, recent projects, documentation links and the recommended workflow. Always call it before claiming which account or projects are connected.

Create a project through the shared tool API:

```http
POST https://folt.io/api/agent/tools/project_create
Authorization: Bearer <access_token>
Content-Type: application/json

{"name":"My film","aspect":"16:9","fps":30}
```

Share the returned editor URL immediately. The person can watch, scrub, approve generations and edit while you work.

## REST or MCP

Use whichever transport is natural for the client:

- REST: `POST /api/agent/tools/<tool_name>` with the tool's input as JSON.
- MCP: connect Streamable HTTP to `https://folt.io/mcp` with the same bearer token.
- Discover operations: `GET /api/agent/tools` or the OpenAPI document.
- Load filmmaking guidance: call `studio_guide`, or read `/skill.md`.

There are no MCP-only features. Tool names, descriptions, JSON Schemas, results and permissions come from one source.

## The shortest successful film workflow

1. `studio_status`, then `studio_guide {"topic":"workflow"}`.
2. `project_create`; share its editor link immediately.
3. `media_add` to upload/import footage, then `job_wait`.
4. `media_inspect` before cutting; use transcripts and frame sheets.
5. `timeline_edit` in preview mode, then apply with `base_revision`.
6. `timeline_view` and `timeline_check`; fix what you see.
7. `render`, `job_wait`, final `timeline_check`, then `share`.

Generation is optional. It always begins with `gen_quote`; FOLTIO validates the request and price before any spend. Requests above the person's auto-approval threshold wait for their approval. Failed generations are refunded.

See https://folt.io/docs/agent-workflows.md for complete workflows and https://folt.io/docs/agent-api.md for HTTP examples.

## Recovery

- `stale_revision`: the person or another agent edited the project. Read it again, check your plan against the new state and reapply.
- `asset_not_ready`: use `job_wait` before editing that media.
- `needs_approval`: share the returned approval URL and wait.
- `401`: reconnect; never ask for account cookies or passwords.
- `403`: the account cannot perform that action; do not keep retrying.
- Anything else: submit precise feedback from the FOLTIO feedback button, including project/job ids and what you expected.
