import test from "node:test";
import assert from "node:assert/strict";
import { agentOpenApi, restToolResult } from "../server/agent-api.mjs";
import { TOOLS } from "../server/mcp/tools.mjs";

test("the REST API is generated from every MCP tool", () => {
  const document = agentOpenApi("https://folt.io", TOOLS);
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.servers, [{ url: "https://folt.io" }]);
  for (const tool of TOOLS) {
    const operation = document.paths[`/api/agent/tools/${tool.name}`]?.post;
    assert.ok(operation, `${tool.name} has a REST operation`);
    assert.equal(operation.operationId, tool.name);
    assert.deepEqual(operation.requestBody.content["application/json"].schema, tool.inputSchema);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
});

test("REST keeps structured tool results and visual MCP content", () => {
  assert.deepEqual(restToolResult({ structuredContent: { summary: "Created", project_id: "prj_1" } }), { summary: "Created", project_id: "prj_1" });
  assert.deepEqual(restToolResult({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] }), {
    content: [{ type: "image", data: "abc", mimeType: "image/png" }],
  });
});
