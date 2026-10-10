// Public projects: the Community shelf on the library, the "Made with FOLTIO"
// strip on the signed-out front page, and the read-only /v/:id page with "Clone this project".
import { useEffect, useMemo, useState } from "react";
import { api, navigate, supabase } from "./api";
import { signIn } from "./Public";
import { FoltioBrand } from "./Brand";
import { Copy, Film, Loader2, Play } from "lucide-react";
import "./agent/agent.css";
import "./community.css";
import { applySeo } from "./seo";

export type PublicCard = { id: string; name: string; width?: number; height?: number; clones: number; owner: string; updated_at: string; poster: string | null };

export function usePublicProjects(sort: "clones" | "recent" = "clones") {
  const [list, setList] = useState<PublicCard[] | null>(null);
  useEffect(() => {
    fetch(`/api/public/projects?sort=${sort}`)
      .then((r) => r.json())
      .then((d) => setList(d.projects || []))
      .catch(() => setList([]));
  }, [sort]);
  return list;
}

const CLONE_KEY = "studio.clone";

// Clone into your own account and open it; signed out, sign in first and come back to finish.
export async function cloneAndOpen(projectId: string) {
  const s = await supabase();
  const { data } = await s.auth.getSession();
  if (!data.session) {
    try {
      localStorage.setItem(CLONE_KEY, projectId);
    } catch {
      /* private mode */
    }
    return signIn("google", `/v/${projectId}`);
  }
  const r = await api<{ id: string }>(`/api/projects/${projectId}/clone`, {});
  navigate(`/p/${r.id}`);
}
// After signing in from a Clone button: finish the clone.
export function pendingClone() {
  try {
    const id = localStorage.getItem(CLONE_KEY);
    if (id) localStorage.removeItem(CLONE_KEY);
    return id;
  } catch {
    return null;
  }
}

const clonesLabel = (n: number) => `${n} clone${n === 1 ? "" : "s"}`;

function Card({ p }: { p: PublicCard }) {
  const [busy, setBusy] = useState(false);
  const tall = (p.height || 16) > (p.width || 9);
  return (
    <article className="cm-card">
      <a className={`cm-frame ${tall ? "tall" : "wide"}`} href={`/v/${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/v/${p.id}`))}>
        {p.poster ? <img src={p.poster} alt="" loading="lazy" /> : <Film size={20} strokeWidth={1.5} />}
        <span className="cm-play">
          <Play size={13} fill="currentColor" /> Watch
        </span>
      </a>
      <div className="cm-meta">
        <a className="cm-name" href={`/v/${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/v/${p.id}`))} title={p.name}>
          {p.name}
        </a>
        <span className="cm-sub">
          by {p.owner} · <span className="num">{clonesLabel(p.clones)}</span>
        </span>
      </div>
      <button className="btn small cm-clone" disabled={busy} onClick={() => (setBusy(true), cloneAndOpen(p.id).catch(() => setBusy(false)))}>
        {busy ? <Loader2 size={12} className="spin" /> : <Copy size={12} />} Clone
      </button>
    </article>
  );
}

// On the library page: what everyone's making, most cloned first.
export function CommunitySection() {
  const list = usePublicProjects("clones");
  if (!list || !list.length) return null;
  return (
    <section className="pl-body cm-section">
      <header className="pl-head">
        <h2>
          Community <span className="num muted">{list.length}</span>
        </h2>
        <span className="muted small">Projects shared by filmmakers. Clone one to make it your own.</span>
      </header>
      <div className="cm-grid">
        {list.map((p) => (
          <Card key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}

// On the signed-out front page: a strip of what's been made.
export function MadeWithStudio() {
  const list = usePublicProjects("clones");
  if (!list || !list.length) return null;
  return (
    <section className="cm-strip">
      <span className="micro">Made with FOLTIO</span>
      <div className="cm-strip-row">
        {list.slice(0, 8).map((p) => (
          <a key={p.id} className="cm-strip-item" href={`/v/${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/v/${p.id}`))} title={`${p.name} — by ${p.owner}`}>
            {p.poster ? <img src={p.poster} alt="" loading="lazy" /> : <Film size={16} />}
            <span className="ellipsis">{p.name}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

type PublicView = {
  project: { id: string; name: string; doc: any; updated_at: string };
  owner: string;
  clones: number;
  render: { url: string; poster: string | null } | null;
  assets: { id: string; kind: string; name: string; status: string; roles?: string[]; poster: string | null; proxy: string | null; duration_s: number | null }[];
  board: any;
};

// /v/:id — watch a public project, see how it was made, clone it.
export function ViewPage({ projectId, signedIn }: { projectId: string; signedIn: boolean }) {
  const [v, setV] = useState<PublicView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<{ url: string; label: string } | null>(null);
  useEffect(() => {
    fetch(`/api/public/projects/${projectId}`)
      .then(async (r) => (r.ok ? setV(await r.json()) : setErr(r.status === 404 ? "This project isn't public." : "Couldn't load this project.")))
      .catch(() => setErr("Couldn't load this project."));
  }, [projectId]);
  useEffect(() => {
    if (!v) return;
    const description = `Watch ${v.project.name}, a film by ${v.owner} made with FOLTIO. Explore its clips and production board, then clone the project to make your own version.`;
    const image = v.render?.poster || v.assets.find((asset) => asset.poster)?.poster || undefined;
    applySeo({
      title: `${v.project.name} — Watch & Remix on FOLTIO`,
      description,
      canonical: `https://folt.io/v/${v.project.id}`,
      image,
      type: "video.other",
      structuredData: {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        name: v.project.name,
        description,
        url: `https://folt.io/v/${v.project.id}`,
        creator: { "@type": "Person", name: v.owner },
        dateModified: v.project.updated_at,
        ...(image ? { image } : {}),
        isPartOf: { "@type": "WebSite", name: "FOLTIO", url: "https://folt.io/" },
      },
    });
  }, [v]);
  // came back from signing in to clone this
  useEffect(() => {
    if (signedIn && pendingClone() === projectId) (setBusy(true), cloneAndOpen(projectId).catch(() => setBusy(false)));
  }, [signedIn, projectId]);
  const byId = useMemo(() => Object.fromEntries((v?.assets || []).map((a) => [a.id, a])), [v]);
  if (err) return <div className="center muted">{err}</div>;
  if (!v) return <div className="center muted">Loading…</div>;
  const b = v.board || {};
  const clips: any[] = b.storyboards || [];
  const media = v.assets.filter((a) => !(a.roles || []).includes("render") && (a.poster || a.proxy));
  const main = v.render?.url || (() => {
    const placed = clips.map((s) => s.pick || (s.takes || []).slice(-1)[0]).find((t) => byId[t]?.proxy && byId[t]?.kind === "video");
    return placed ? byId[placed].proxy : null;
  })();
  const s = v.project.doc?.settings || {};
  const tall = (s.height || 16) > (s.width || 9);
  return (
    <div className="vw">
      <header className="vw-top">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
          <FoltioBrand />
        </a>
        <div className="grow" />
        {!signedIn && (
          <button className="btn ghost small" onClick={() => signIn("google", `/v/${projectId}`)}>
            Sign in
          </button>
        )}
      </header>
      <main className="vw-main">
        <section className={`vw-player ${tall ? "tall" : "wide"}`}>
          {main ? <video src={main} poster={v.render?.poster || undefined} controls playsInline /> : <div className="vw-empty"><Film size={22} /> No video yet</div>}
        </section>
        <aside className="vw-side">
          <h1>{v.project.name}</h1>
          <p className="muted">
            made by <b>{v.owner}</b> · <span className="num">{clonesLabel(v.clones)}</span>
          </p>
          <button className="btn primary large vw-clone" disabled={busy} onClick={() => (setBusy(true), cloneAndOpen(projectId).catch(() => setBusy(false)))}>
            {busy ? <Loader2 size={15} className="spin" /> : <Copy size={15} />} Clone this project
          </button>
          <p className="muted small">You get your own copy — the timeline, the board and every file — to change however you like.</p>
          {(b.brief?.intent || b.brief?.about) && (
            <div className="vw-block">
              <span className="micro">The idea</span>
              {b.brief.intent && <p>{b.brief.intent}</p>}
              {b.brief.about && <p className="muted">{b.brief.about}</p>}
            </div>
          )}
          {(b.beats || []).length > 0 && (
            <div className="vw-block">
              <span className="micro">The story</span>
              <ol className="ag-story-beats">
                {b.beats.map((x: any) => (
                  <li key={x.id}>
                    <span className="ag-story-part">{x.part || "Beat"}</span>
                    <span className="ag-story-body">
                      <b>{x.title}</b>
                      {x.text && <span>{x.text}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </main>
      {clips.length > 0 && (
        <section className="vw-section">
          <span className="micro">Clips · {clips.length}</span>
          <div className="vw-clips">
            {clips.map((c, i) => {
              const take = c.pick || (c.takes || []).slice(-1)[0];
              const t = take && byId[take];
              const pic = t?.poster || (c.sheet && byId[c.sheet]?.poster) || null;
              return (
                <button key={c.id} className="vw-clip" onClick={() => t?.proxy && setPlaying({ url: t.proxy, label: `Clip ${i + 1} · ${c.title || ""}` })} title={t?.proxy ? "Play this clip" : c.title}>
                  <span className={`vw-clip-pic ${tall ? "tall" : "wide"}`}>
                    {pic ? <img src={pic} alt="" loading="lazy" /> : <Film size={16} />}
                    {t?.proxy && (
                      <span className="vw-clip-play">
                        <Play size={12} fill="currentColor" />
                      </span>
                    )}
                  </span>
                  <b className="ellipsis">
                    {i + 1} · {c.title || "Untitled"}
                  </b>
                  {c.beat && <span className="muted small vw-clip-beat">{c.beat}</span>}
                </button>
              );
            })}
          </div>
        </section>
      )}
      {media.length > 0 && (
        <section className="vw-section">
          <span className="micro">
            Media · {media.length}
          </span>
          <div className="vw-media">
            {media.slice(0, 40).map((a) => (
              <button key={a.id} className="vw-media-item" onClick={() => (a.kind === "video" && a.proxy ? setPlaying({ url: a.proxy, label: a.name }) : a.poster && setPlaying({ url: a.proxy || a.poster, label: a.name }))} title={a.name}>
                {a.poster ? <img src={a.poster} alt="" loading="lazy" /> : <Film size={14} />}
              </button>
            ))}
          </div>
        </section>
      )}
      {playing && (
        <div className="ag-lightbox" onClick={() => setPlaying(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            {/\.(png|jpe?g|webp)(\?|$)/i.test(playing.url) ? <img src={playing.url} alt="" /> : <video src={playing.url} controls autoPlay playsInline />}
            <figcaption>{playing.label}</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
