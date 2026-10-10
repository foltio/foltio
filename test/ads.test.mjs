import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { config } from "../server/config.mjs";
import { redditSignUp } from "../server/ads.mjs";

test("Reddit SignUp uses the v3 standard event and deduplication id", async () => {
  const old = { ...config.reddit };
  const oldFetch = globalThis.fetch;
  let call;
  config.reddit.pixel = "a2_test";
  config.reddit.token = "token";
  globalThis.fetch = async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { message: "ok" } }), { status: 200 });
  };
  try {
    assert.equal(await redditSignUp({ account: { id: "User-1", email: "Al.ice+Ad@Example.com" }, conversionId: "signup:user-1", clickId: "click-1", ip: "203.0.113.1", userAgent: "test" }), true);
    assert.equal(call.url, "https://ads-api.reddit.com/api/v3/pixels/a2_test/conversion_events");
    const event = call.body.data.events[0];
    assert.equal(event.action_source, "WEBSITE");
    assert.equal(event.type.tracking_type, "SIGN_UP");
    assert.equal(event.metadata.conversion_id, "signup:user-1");
    assert.equal(event.click_id, "click-1");
    assert.equal(event.user.email, createHash("sha256").update("alice@example.com").digest("hex"));
    assert.equal(event.user.external_id, createHash("sha256").update("user-1").digest("hex"));
  } finally {
    Object.assign(config.reddit, old);
    globalThis.fetch = oldFetch;
  }
});
