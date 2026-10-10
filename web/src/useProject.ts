import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Asset, type Doc, type Job } from "./api";
import { applyOps } from "./engine";

export type FullAsset = Asset & {
  filmstrip?: string | null;
  filmstripStep?: number | null;
  transcript?: string | null;
  probe?: any;
  silences?: [number, number][] | null;
  fx?: Record<string, string> | null; // baked previews of custom filters, by fx key
};
type Payload = { project: { id: string; name: string; revision: number; doc: Doc; updated_at: string; public?: boolean; clones?: number }; assets: FullAsset[]; jobs: Job[] };

const seed = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

// Project state with optimistic edits: an edit is applied locally with the shared engine at once,
// then committed to the server in order. Each edit carries a seed so the ids the server creates
// match the ones the browser already shows.
export function useProject(projectId: string, opts: { quietExternal?: () => boolean } = {}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [payload, setPayload] = useState<Payload | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(0);
  const [transcripts, setTranscripts] = useState<Record<string, any>>({});
  const [quotes, setQuotes] = useState<any[]>([]);
  const revRef = useRef(0);
  const docRef = useRef<Doc | null>(null);
  const inflight = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const redoStack = useRef<number[]>([]);
  const urlCache = useRef<Record<string, string>>({});
  const fetchedTranscripts = useRef<Set<string>>(new Set());
  const previewBase = useRef<Doc | null>(null);
  const [, bump] = useState(0);

  const assetsMap = useMemo(() => Object.fromEntries((payload?.assets || []).map((a) => [a.id, a])), [payload]);
  const assetsRef = useRef(assetsMap);
  assetsRef.current = assetsMap;

  const adopt = useCallback((d: Doc, rev: number) => {
    revRef.current = rev;
    setRevision(rev);
    if (inflight.current === 0 && !previewBase.current) {
      docRef.current = d;
      setDoc(d);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const p = await api<Payload>(`/api/projects/${projectId}`);
      for (const a of p.assets) {
        for (const k of ["poster", "proxy", "waveform", "filmstrip", "transcript"] as const) {
          const ck = `${a.id}:${k}`;
          if ((a as any)[k]) urlCache.current[ck] ||= (a as any)[k];
          if (urlCache.current[ck]) (a as any)[k] = urlCache.current[ck];
        }
      }
      setPayload(p);
      // somebody else (your agent) changed the project: show it, unless you are mid-edit
      // revisions only grow on the server, so an older answer (a poll that raced an edit) is ignored
      if (!docRef.current || (inflight.current === 0 && !previewBase.current && p.project.revision > revRef.current)) {
        const external = !!docRef.current && p.project.revision > revRef.current;
        adopt(p.project.doc, p.project.revision);
        if (external && !optsRef.current.quietExternal?.()) setNotice(`Timeline updated to r${p.project.revision} (your agent or another tab).`);
      }
      setError((e) => (e.startsWith("Failed to fetch") || e.startsWith("HTTP 5") ? "" : e));
    } catch (e: any) {
      setError(e.message);
    }
  }, [projectId, adopt]);

  const loadQuotes = useCallback(async () => {
    const r = await api<{ quotes: any[] }>(`/api/projects/${projectId}/quotes`).catch(() => null);
    if (r) setQuotes(r.quotes);
  }, [projectId]);

  useEffect(() => {
    load();
    loadQuotes();
    const t = setInterval(load, 2500);
    const q = setInterval(loadQuotes, 6000);
    return () => {
      clearInterval(t);
      clearInterval(q);
    };
  }, [load, loadQuotes]);

  // transcripts drive the live captions and the transcript panel
  useEffect(() => {
    for (const a of payload?.assets || []) {
      if (!a.transcript || fetchedTranscripts.current.has(a.id)) continue;
      fetchedTranscripts.current.add(a.id);
      fetch(a.transcript)
        .then((r) => r.json())
        .then((t) => setTranscripts((m) => ({ ...m, [a.id]: t })))
        .catch(() => fetchedTranscripts.current.delete(a.id));
    }
  }, [payload]);

  // Live preview while dragging a slider or a clip: ops are applied locally on top of the doc as it
  // was when the gesture began, nothing is sent until edit() commits.
  const beginPreview = useCallback(() => {
    previewBase.current = docRef.current;
  }, []);
  const preview = useCallback((ops: any[]) => {
    const base = previewBase.current || docRef.current;
    if (!base) return false;
    try {
      setDoc(applyOps(base, ops, assetsRef.current).doc);
      return true;
    } catch {
      return false;
    }
  }, []);
  const endPreview = useCallback(() => {
    if (!previewBase.current) return;
    previewBase.current = null;
    setDoc(docRef.current);
  }, []);

  const edit = useCallback(
    (ops: any[], label = "edit") => {
      const base = docRef.current;
      if (!base || !ops.length) return Promise.resolve(false);
      const s = seed();
      let local;
      try {
        local = applyOps(base, ops, assetsRef.current, { seed: s });
      } catch (e: any) {
        previewBase.current = null;
        setDoc(docRef.current);
        setError(e.message.replace(/^ops\[\d+\] \(\w+\): /, ""));
        return Promise.resolve(false);
      }
      previewBase.current = null;
      docRef.current = local.doc;
      setDoc(local.doc);
      redoStack.current = [];
      inflight.current++;
      setSaving((n) => n + 1);
      const run = async () => {
        try {
          const r = await api<any>(`/api/projects/${projectId}/edit`, { ops, mode: "apply", base_revision: revRef.current, label, seed: s });
          revRef.current = r.revision;
          setRevision(r.revision);
          if (inflight.current === 1 && !previewBase.current) {
            docRef.current = r.doc;
            setDoc(r.doc);
          }
          return true;
        } catch (e: any) {
          if (e instanceof ApiError && e.code === "stale_revision") setNotice("The project changed elsewhere (your agent?), so the latest version was loaded. Redo your last change if it is missing.");
          else setError(e.message.replace(/^ops\[\d+\] \(\w+\): /, ""));
          const p = await api<Payload>(`/api/projects/${projectId}`).catch(() => null);
          if (p) {
            revRef.current = p.project.revision;
            setRevision(p.project.revision);
            docRef.current = p.project.doc;
            setDoc(p.project.doc);
          }
          return false;
        } finally {
          inflight.current = Math.max(0, inflight.current - 1);
          setSaving((n) => Math.max(0, n - 1));
        }
      };
      const p = chain.current.then(run, run);
      chain.current = p;
      return p;
    },
    [projectId],
  );

  // undo/redo run in the same queue as edits, so an edit made right after never races them
  const history = useCallback(
    (body: any) => {
      const run = async () => {
        try {
          const r = await api<any>(`/api/projects/${projectId}/history`, body);
          revRef.current = r.revision;
          setRevision(r.revision);
          docRef.current = r.doc;
          setDoc(r.doc);
          return r;
        } catch (e: any) {
          setError(e.message);
          return null;
        }
      };
      const p = chain.current.then(run, run);
      chain.current = p;
      return p;
    },
    [projectId],
  );
  const undo = useCallback(async () => {
    await chain.current;
    const before = revRef.current;
    const r = await history({ action: "undo" });
    if (r) {
      redoStack.current.push(before);
      bump((n) => n + 1);
    }
  }, [history]);
  const redo = useCallback(async () => {
    const target = redoStack.current.pop();
    if (target === undefined) return;
    await history({ action: "restore", revision: target });
    bump((n) => n + 1);
  }, [history]);

  return {
    payload,
    doc,
    revision,
    assets: assetsMap,
    assetList: payload?.assets || [],
    jobs: payload?.jobs || [],
    quotes,
    loadQuotes,
    transcripts,
    error,
    setError,
    notice,
    setNotice,
    saving: saving > 0,
    load,
    edit,
    preview,
    beginPreview,
    endPreview,
    undo,
    redo,
    canRedo: redoStack.current.length > 0,
    docNow: () => docRef.current,
    url: (assetId: string, kind: string) => urlCache.current[`${assetId}:${kind}`],
  };
}
export type ProjectState = ReturnType<typeof useProject>;
