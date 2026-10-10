import test from "node:test";
import assert from "node:assert/strict";
import { projectSeo, renderSeoPage, renderSitemap } from "../server/seo.mjs";

test("public project metadata is escaped and replaces the generic page metadata", () => {
  const meta = projectSeo("https://folt.io", {
    id: "prj_test",
    name: 'Cats & <Clouds> "One"',
    owner: "Ava",
    updated_at: "2026-10-08T00:00:00Z",
    hasPoster: true,
  });
  const html = renderSeoPage("<head><!--seo:start--><title>Old</title><!--seo:end--></head>", meta);
  assert.match(html, /Cats &amp; &lt;Clouds&gt; &quot;One&quot; — Watch &amp; Remix on FOLTIO/);
  assert.match(html, /https:\/\/folt\.io\/api\/public\/projects\/prj_test\/poster/);
  assert.doesNotMatch(html, /<title>Old<\/title>/);
  assert.doesNotMatch(html, /<title>Cats & <Clouds>/);
});

test("sitemap contains only canonical static and supplied public project URLs", () => {
  const xml = renderSitemap("https://folt.io", [{ id: "prj_one", updated_at: "2026-10-07T12:00:00Z" }], "2026-10-08T00:00:00Z");
  assert.match(xml, /<loc>https:\/\/folt\.io\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/folt\.io\/terms<\/loc>/);
  assert.match(xml, /<loc>https:\/\/folt\.io\/privacy<\/loc>/);
  assert.match(xml, /<loc>https:\/\/folt\.io\/v\/prj_one<\/loc><lastmod>2026-10-07<\/lastmod>/);
  assert.doesNotMatch(xml, /\/p\//);
});
