import { useState } from "react";
import { api } from "./api";
import type { Doc, Job } from "./api";
import type { FullAsset } from "./useProject";
import { fpsOf, seqEnd } from "./edits";
import { Download, X, Loader2, Sparkles, Zap } from "lucide-react";

export function ExportDialog({ projectId, doc, revision, assets, jobs, onClose, reload }: { projectId: string; doc: Doc; revision: number; assets: FullAsset[]; jobs: Job[]; onClose: () => void; reload: () => void }) {
  const [quality, setQuality] = useState<"final" | "draft">("final");
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const fps = fpsOf(doc);
  const dur = seqEnd(doc) / fps;
  const renders = assets.filter((a) => a.roles?.includes("render")).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const done = job?.status === "done" || job?.status === "succeeded" || job?.status === "completed";
  const result = job?.output?.render_id ? assets.find((a) => a.id === job.output.render_id) : undefined;
  const start = async () => {
    setErr("");
    try {
      const r = await api<{ job_id: string }>(`/api/projects/${projectId}/render`, { quality });
      setJobId(r.job_id);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const download = async (id: string) => {
    const r = await api<{ url: string }>(`/api/assets/${id}/url?kind=download`).catch((e) => (setErr(e.message), null));
    if (r) window.location.href = r.url;
  };
  const small = Math.min(doc.settings.width, doc.settings.height);
  const draftDims = `${Math.round((doc.settings.width * Math.min(1, 540 / small)) / 2) * 2}×${Math.round((doc.settings.height * Math.min(1, 540 / small)) / 2) * 2}`;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export">
        <div className="modal-head">
          <strong>Export video</strong>
          <button className="icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="q-options">
          <button className={`q-opt ${quality === "final" ? "on" : ""}`} onClick={() => setQuality("final")}>
            <Sparkles size={16} />
            <strong>Final</strong>
            <span>
              {doc.settings.width}×{doc.settings.height} · {+fps.toFixed(3)} fps · H.264
            </span>
          </button>
          <button className={`q-opt ${quality === "draft" ? "on" : ""}`} onClick={() => setQuality("draft")}>
            <Zap size={16} />
            <strong>Quick draft</strong>
            <span>{draftDims} · fast, for checking</span>
          </button>
        </div>
        <div className="export-meta">
          <span className="pill">{dur.toFixed(1)} s</span>
          <span className="pill">r{revision}</span>
          <span className="pill">{doc.settings.loudness?.integratedLufs ?? -14} LUFS</span>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Exports run in the cloud, so you can keep editing.
        </p>
        {!job && (
          <button className="btn primary wide" onClick={start} disabled={dur <= 0}>
            <Download size={15} /> Export {quality === "final" ? "final" : "draft"}
          </button>
        )}
        {job && !done && job.status !== "failed" && (
          <div className="export-progress">
            <div className="export-progress-row">
              <Loader2 size={14} className="spin" /> {job.status === "queued" ? "Waiting for a render slot…" : "Rendering"}
              {job.status !== "queued" && <span className="num">{Math.round((job.progress || 0) * 100)}%</span>}
            </div>
            <div className="meter">
              <div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {job?.status === "failed" && <p className="error small">Render failed: {job.error?.message || "unknown error"}</p>}
        {done && result && (
          <div className="export-done">
            {result.proxy && <video src={result.proxy} controls playsInline />}
            <button className="btn primary wide" onClick={() => download(result.id)}>
              <Download size={15} /> Download MP4
            </button>
          </div>
        )}
        {err && <p className="error small">{err}</p>}
        {renders.length > 0 && (
          <>
            <div className="sub-head">Previous exports</div>
            <div className="exports">
              {renders.slice(0, 8).map((r) => (
                <div key={r.id} className="export-row">
                  <span>
                    {r.origin?.quality === "final" ? "Final" : "Draft"} · r{r.origin?.revision}
                    {r.origin?.revision === revision ? "" : " (older)"}
                  </span>
                  <span className="muted">{r.created_at ? new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""}</span>
                  <button className="btn small" onClick={() => download(r.id)}>
                    <Download size={12} /> MP4
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
