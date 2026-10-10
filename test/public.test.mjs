import test from "node:test";
import assert from "node:assert/strict";
import { ownerName, rewrite } from "../server/public.mjs";

test("public owner names never expose an email", () => {
  assert.equal(ownerName("Shehryar Saroya", "s@x.com"), "Shehryar");
  assert.equal(ownerName("", "gibreshad@gmail.com"), "gibreshad");
  assert.equal(ownerName(null, null), "someone");
  assert.ok(!ownerName("", "a.b@c.com").includes("@"));
});

test("cloning rewrites every id and storage prefix consistently", () => {
  const map = [
    ["a/acc1/prj_src/", "a/acc2/prj_new/"],
    ["ast_aaaaaaaaaaaa", "ast_bbbbbbbbbbbb"],
    ["prj_src", "prj_new"],
  ];
  const doc = { sequence: { items: { i1: { asset: "ast_aaaaaaaaaaaa" } } } };
  const board = { storyboards: [{ id: "1", takes: ["ast_aaaaaaaaaaaa"], sheet: "ast_aaaaaaaaaaaa" }] };
  const asset = { id: "ast_aaaaaaaaaaaa", storage_key: "a/acc1/prj_src/ast_aaaaaaaaaaaa/original.mp4", derived: { poster: "a/acc1/prj_src/ast_aaaaaaaaaaaa/poster.jpg" } };
  assert.equal(rewrite(doc, map).sequence.items.i1.asset, "ast_bbbbbbbbbbbb");
  assert.deepEqual(rewrite(board, map).storyboards[0].takes, ["ast_bbbbbbbbbbbb"]);
  const a = rewrite(asset, map);
  assert.equal(a.storage_key, "a/acc2/prj_new/ast_bbbbbbbbbbbb/original.mp4");
  assert.equal(a.derived.poster, "a/acc2/prj_new/ast_bbbbbbbbbbbb/poster.jpg");
  assert.ok(!JSON.stringify(a).includes("acc1"));
});
