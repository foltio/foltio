# FOLTIO Agent API

The REST API and MCP server expose the same agent operations. REST is useful for coding agents, scripts, backend services and clients that do not need an MCP installation.

## Discovery

- Agent start: `GET https://folt.io/api/agent/start`
- Tool catalogue and JSON Schemas: `GET https://folt.io/api/agent/tools`
- OpenAPI 3.1: `GET https://folt.io/api/openapi.json`
- Native MCP: `POST https://folt.io/mcp`
- Documentation index: `GET https://folt.io/llms.txt`

Authenticated requests use:

```http
Authorization: Bearer sk_foltio_…
```

Obtain a credential through the browser-approved flow in [agent-start.md](https://folt.io/docs/agent-start.md), or create a personal key on FOLTIO's Connect page.

## Calling tools

Every MCP operation is also an HTTP operation:

```text
POST /api/agent/tools/<tool_name>
Content-Type: application/json
Authorization: Bearer <credential>
```

The request body is the tool input. Example:

```sh
curl -fsS https://folt.io/api/agent/tools/project_list \
  -H "Authorization: Bearer $FOLTIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Create a project:

```sh
curl -fsS https://folt.io/api/agent/tools/project_create \
  -H "Authorization: Bearer $FOLTIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Launch film","aspect":"16:9","fps":30}'
```

Responses place the short human-readable outcome in `summary` and return structured ids, links and next steps beside it. Visual operations such as `timeline_view` return MCP-compatible image content.

## Uploads

`media_add` with `upload` returns short-lived presigned PUT URLs and a ready-to-run upload script. Upload bytes directly to storage, then call `media_add` with `finalize`. This keeps large media out of the API process and works identically through REST or MCP.

## Concurrency and retries

- Timeline writes require `base_revision`. A stale revision fails instead of overwriting another person's work.
- Related timeline operations are atomic: one failed operation applies nothing.
- Generation and render operations accept or derive idempotency keys; do not invent new keys while retrying the same paid action.
- `job_wait` may report that work is still running. Call it again rather than starting a duplicate job.

## Error shape

```json
{"error":"Human-readable explanation","code":"stable_machine_code"}
```

Use the HTTP status and `code`. Errors are written to tell an agent the corrective action and valid values.
