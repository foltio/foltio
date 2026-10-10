// Provenance of baked media: what a script made is kept on the asset, capped and cleaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { provenanceOf } from "../server/projects.mjs";

test("a bake keeps its script, params, inputs and lineage", () => {
  const p = provenanceOf({ script: "print(1)", script_path: "/data/workspace/x/make.py", params: { color: "blue" }, inputs: ["ast_abc123def", "nope"], parent: "ast_parent0001", recipe: "lower-thirds", note: "a title" });
  assert.equal(p.kind, "baked");
  assert.equal(p.script, "print(1)");
  assert.deepEqual(p.params, { color: "blue" });
  assert.deepEqual(p.inputs, ["ast_abc123def"]); // only real asset ids
  assert.equal(p.parent, "ast_parent0001");
  assert.equal(p.recipe, "lower-thirds");
  assert.ok(p.at);
});

test("provenance is capped and optional", () => {
  assert.equal(provenanceOf(null), null);
  assert.equal(provenanceOf("x"), null);
  const big = provenanceOf({ script: "x".repeat(50000), params: { blob: "y".repeat(9000) } });
  assert.equal(big.script.length, 20000);
  assert.deepEqual(big.params, { note: "parameters too large to keep" });
  assert.deepEqual(provenanceOf({}).inputs, []);
});
