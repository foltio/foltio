const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const DEFAULT_IMAGE = "https://folt.io/og/foltio-studio.jpg";

export function seoMarkup({ title, description, canonical, type = "website", image = DEFAULT_IMAGE, imageAlt = "FOLTIO agentic AI video editor", noindex = false, structuredData }) {
  return `<!--seo:start-->
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:site_name" content="FOLTIO" />
    <meta property="og:type" content="${esc(type)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${esc(image)}" />
    <meta property="og:image:alt" content="${esc(imageAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${esc(image)}" />
    ${structuredData ? `<script type="application/ld+json" data-page-seo>${json(structuredData)}</script>` : ""}
    <!--seo:end-->`;
}

export function renderSeoPage(html, meta) {
  const block = seoMarkup(meta);
  const marker = /<!--seo:start-->[\s\S]*?<!--seo:end-->/;
  return marker.test(html) ? html.replace(marker, block) : html.replace("</head>", `${block}\n  </head>`);
}

export function projectSeo(origin, project) {
  const canonical = `${origin}/v/${project.id}`;
  const description = `Watch ${project.name}, a film by ${project.owner} made with FOLTIO. Explore its clips and production board, then clone the project to make your own version.`;
  const image = project.hasPoster ? `${origin}/api/public/projects/${project.id}/poster` : `${origin}/og/foltio-studio.jpg`;
  return {
    title: `${project.name} — Watch & Remix on FOLTIO`,
    description,
    canonical,
    type: "video.other",
    image,
    imageAlt: `${project.name}, made with FOLTIO`,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: project.name,
      description,
      url: canonical,
      image,
      creator: { "@type": "Person", name: project.owner },
      dateModified: new Date(project.updated_at).toISOString(),
      isPartOf: { "@type": "WebSite", name: "FOLTIO", url: `${origin}/` },
    },
  };
}

export function legalSeo(origin, page) {
  const terms = page === "terms";
  return {
    title: `${terms ? "Terms of Service" : "Privacy"} — FOLTIO`,
    description: terms
      ? "The terms for using FOLTIO, including accounts, credits, payments, content, public projects and AI-generated output."
      : "How FOLTIO stores and processes account, project, media, payment and usage data, plus the choices available to you.",
    canonical: `${origin}/${page}`,
    type: "article",
  };
}

const xml = (value) => esc(value);
export function renderSitemap(origin, projects, updated = new Date()) {
  const day = new Date(updated).toISOString().slice(0, 10);
  const rows = [
    { path: "/", lastmod: day, priority: "1.0" },
    { path: "/terms", lastmod: day, priority: "0.3" },
    { path: "/privacy", lastmod: day, priority: "0.3" },
    ...projects.map((project) => ({ path: `/v/${project.id}`, lastmod: new Date(project.updated_at).toISOString().slice(0, 10), priority: "0.6" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows
    .map((row) => `  <url><loc>${xml(origin + row.path)}</loc><lastmod>${row.lastmod}</lastmod><changefreq>${row.path === "/" ? "weekly" : "monthly"}</changefreq><priority>${row.priority}</priority></url>`)
    .join("\n")}\n</urlset>\n`;
}
