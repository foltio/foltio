export function agentOpenApi(origin, tools) {
  const toolPaths = Object.fromEntries(tools.map((tool) => [`/api/agent/tools/${tool.name}`, {
    post: {
      operationId: tool.name,
      summary: tool.title || tool.name,
      description: tool.description,
      tags: ["Agent tools"],
      security: [{ bearerAuth: [] }],
      requestBody: { required: false, content: { "application/json": { schema: tool.inputSchema } } },
      responses: {
        200: { description: "Tool result", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        400: { $ref: "#/components/responses/Error" },
        401: { $ref: "#/components/responses/Error" },
      },
    },
  }]));
  return {
    openapi: "3.1.0",
    info: {
      title: "FOLTIO Agent API",
      version: "1.0.0",
      description: "The same project, media, generation, timeline, review and rendering operations exposed by the FOLTIO MCP server.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/agent/connections": {
        post: {
          operationId: "start_connection",
          summary: "Start browser-approved agent connection",
          tags: ["Connection"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { client_name: { type: "string", maxLength: 80 } }, required: ["client_name"], additionalProperties: false } } } },
          responses: { 201: { description: "Pending connection and browser approval URL" } },
        },
      },
      "/api/agent/connections/token": {
        post: {
          operationId: "poll_connection",
          summary: "Poll until the person approves",
          tags: ["Connection"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { device_code: { type: "string" } }, required: ["device_code"], additionalProperties: false } } } },
          responses: { 200: { description: "Connected or denied" }, 202: { description: "Still pending" } },
        },
      },
      "/api/agent/start": {
        get: { operationId: "agent_start", summary: "Connected account, recent projects and next steps", tags: ["Agent tools"], security: [{ bearerAuth: [] }], responses: { 200: { description: "Agent start context" }, 401: { $ref: "#/components/responses/Error" } } },
      },
      "/api/agent/tools": {
        get: { operationId: "list_tools", summary: "List every agent operation and its JSON Schema", tags: ["Agent tools"], responses: { 200: { description: "Tool catalogue" } } },
      },
      ...toolPaths,
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "FOLTIO API key" } },
      responses: { Error: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } }, required: ["error"] } } } } },
    },
  };
}

export function restToolResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  return { content: result?.content || [] };
}
