type PageSeo = {
  title: string;
  description: string;
  canonical?: string;
  image?: string;
  type?: "website" | "article" | "video.other";
  noindex?: boolean;
  structuredData?: Record<string, unknown>;
};

const ORIGIN = "https://folt.io";
const DEFAULT_IMAGE = `${ORIGIN}/og/foltio-studio.jpg`;

function meta(selector: string, attrs: Record<string, string>) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    document.head.appendChild(el);
  }
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
}

export function applySeo(page: PageSeo) {
  const canonical = page.canonical || `${ORIGIN}${location.pathname}`;
  const image = page.image || DEFAULT_IMAGE;
  document.title = page.title;
  meta('meta[name="description"]', { name: "description", content: page.description });
  meta('meta[name="robots"]', { name: "robots", content: page.noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" });
  meta('meta[property="og:site_name"]', { property: "og:site_name", content: "FOLTIO" });
  meta('meta[property="og:type"]', { property: "og:type", content: page.type || "website" });
  meta('meta[property="og:title"]', { property: "og:title", content: page.title });
  meta('meta[property="og:description"]', { property: "og:description", content: page.description });
  meta('meta[property="og:url"]', { property: "og:url", content: canonical });
  meta('meta[property="og:image"]', { property: "og:image", content: image });
  meta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary_large_image" });
  meta('meta[name="twitter:title"]', { name: "twitter:title", content: page.title });
  meta('meta[name="twitter:description"]', { name: "twitter:description", content: page.description });
  meta('meta[name="twitter:image"]', { name: "twitter:image", content: image });
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = canonical;
  if (page.structuredData) {
    let script = document.head.querySelector<HTMLScriptElement>('script[data-page-seo]');
    if (!script) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.dataset.pageSeo = "";
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(page.structuredData).replace(/</g, "\\u003c");
  }
}

export function routeSeo(path: string, signedIn: boolean | undefined): PageSeo {
  if (path === "/terms") return {
    title: "Terms of Service — FOLTIO",
    description: "The terms for using FOLTIO, including accounts, credits, payments, content, public projects and AI-generated output.",
    canonical: `${ORIGIN}/terms`,
  };
  if (path === "/privacy") return {
    title: "Privacy — FOLTIO",
    description: "How FOLTIO stores and processes account, project, media, payment and usage data, plus the choices available to you.",
    canonical: `${ORIGIN}/privacy`,
  };
  if (/^\/v\/prj_\w+/.test(path)) return {
    title: "Watch a film made with FOLTIO",
    description: "Watch this public film, explore its clips and production board, then clone the project to make your own version in FOLTIO.",
    canonical: `${ORIGIN}${path}`,
    type: "video.other",
  };
  if (path === "/" && !signedIn) return {
    title: "FOLTIO — Agentic AI Video Editor",
    description: "Edit footage or create a video from an idea with a filmmaking agent, generative media and a real multitrack timeline in one browser workspace.",
    canonical: `${ORIGIN}/`,
  };
  return {
    title: "FOLTIO Studio",
    description: "Your private FOLTIO filmmaking workspace.",
    canonical: `${ORIGIN}${path}`,
    noindex: true,
  };
}
