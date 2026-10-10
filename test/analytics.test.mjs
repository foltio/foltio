import test from "node:test";
import assert from "node:assert/strict";
import { cleanAnalyticsEvent } from "../server/analytics.mjs";

test("analytics keeps useful dimensions and rejects creative or identifying content", () => {
  const event = cleanAnalyticsEvent({
    event_id: "evt_test-safe",
    name: "generation_opened",
    anonymous_id: "anon_test-safe",
    session_id: "ses_test-safe",
    path: "/p/prj_secret123?token=secret",
    project_id: "prj_secret123",
    occurred_at: "2026-10-08T08:00:00.000Z",
    properties: {
      model: "video/ref",
      duration_ms: 1234,
      success: true,
      prompt: "a private screenplay",
      filename: "private.mov",
      media_url: "https://example.com/private.mov",
      arbitrary: "not allowlisted",
    },
  }, "d3f9b181-f83c-4374-993f-7211830f99ef", Date.parse("2026-10-08T08:00:01.000Z"));
  assert.equal(event.path, "/p/prj_:id");
  assert.equal(event.project_id, "prj_secret123");
  assert.deepEqual(event.properties, { model: "video/ref", duration_ms: 1234, success: true });
  assert.equal(event.account_id, "d3f9b181-f83c-4374-993f-7211830f99ef");
});

test("analytics refuses malformed and implausibly dated events", () => {
  assert.equal(cleanAnalyticsEvent({ name: "Bad Event" }), null);
  assert.equal(cleanAnalyticsEvent({ name: "page_view", occurred_at: "2020-01-01" }, null, Date.parse("2026-10-08")), null);
});

test("guest conversion events keep funnel dimensions but never the submitted idea", () => {
  const event = cleanAnalyticsEvent({
    name: "guest_prompt_submitted",
    anonymous_id: "anon_guest-funnel",
    occurred_at: "2026-10-08T08:00:00.000Z",
    properties: {
      aspect: "9:16",
      mode: "prompt",
      provider: "google",
      prompt: "private anime idea",
    },
  }, null, Date.parse("2026-10-08T08:00:01.000Z"));
  assert.deepEqual(event.properties, { aspect: "9:16", mode: "prompt", provider: "google" });
});
