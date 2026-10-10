import { useCallback, useEffect, useRef, useState } from "react";
import { config, supabase } from "../api";
import { storedModel, storeModel, type ModelOption } from "./models";
import { refreshBilling, updateLiveCreditBalance } from "../billing";
import { track } from "../analytics";

// One socket to this person's built-in agent (agent/service.mjs). It says hello with the sign-in
// token, pings every 25 s, reconnects with backoff (1 s doubling to 15 s), and follows one
// conversation at a time. The editor listens to every item so it can follow what the agent does.

export type Focus = {
  jobList?: { title: string; status: string; progress?: number; assets: string[]; error?: string }[];
  story?: { beats: { id: string; part?: string; title?: string; text?: string; status?: string; changed?: boolean }[] };
  project?: string;
  revision?: number;
  items?: { added?: string[]; changed?: string[]; removed?: string[]; restored?: boolean };
  assets?: string[];
  jobs?: string[];
  quote?: { id: string; cost_usd: number; policy: string; model: string; title?: string; for?: Record<string, string>; approve_url?: string };
  render?: { asset_id?: string; job_id?: string; quality?: string; download_url?: string };
  board?: boolean;
  plan?: PlanInfo;
  made?: string[];
  preview?: { seconds: number; revision?: number };
};
export type PlanInfo = {
  title?: string;
  logline?: string;
  total_usd?: number;
  retake_usd?: number;
  minutes?: number;
  cast?: string[];
  places?: string[];
  music?: string[];
  scenes?: { id: string; title?: string }[];
  storyboards?: { id: string; scene?: string; title?: string; seconds?: number; panels?: number; model?: string; est_usd?: number }[];
  shots?: { id: string; scene?: string; title?: string; seconds?: number; panels?: number; model?: string; est_usd?: number }[];
};
export type Question = { id: string; questions: { id: string; header: string; question: string; options: { label: string; description: string }[]; other: boolean }[] };
export type Picture = { label: string; url: string; kind?: "image" | "video" | "audio" };
// An answer to one of the agent's questions, as it shows in the chat
export type Answer = { header: string; question: string; answer: string; options?: { label: string; description?: string }[] };
export type ChatItem =
  | { id: string; type: "user"; text: string; context?: string[]; images?: string[]; pending?: boolean; answers?: Answer[] }
  | { id: string; type: "agent"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "plan"; text: string }
  | { id: string; type: "tool"; tool: string; title: string; status: "running" | "done" | "failed"; detail?: string | null; links: { label: string; url: string }[]; images: Picture[]; error?: string | null; focus?: Focus | null; warnings?: string[] }
  | { id: string; type: "command"; command: string; status: string; exit_code: number | null; output: string }
  | { id: string; type: "files"; changes: { path: string; kind: string }[]; status: string }
  | { id: string; type: "notice"; text: string }
  | { id: string; type: "turn"; turn?: string; project: string; from_revision: number; to_revision: number; seconds?: number; model_usd?: number; gen_usd?: number };
export type Thread = { id: string; title: string; project: string | null; updated: string; running: boolean; model?: string };
// A conversation can switch models in place; new ones start on the last model picked.
export type { ModelOption };
export type Allowance = { spent_usd: number; total_usd: number; credit_usd?: number | null };

const PING_MS = 25_000;
const SILENT_MS = 2 * PING_MS + 10_000;
const DENIED = new Set([1008, 4401, 4403]);
const socketUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/agent/ws`;
const clientId = () => "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export type SendOptions = { context?: string[]; images?: string[] };
export type AgentApi = ReturnType<typeof useAgent>;

export function useAgent({ projectId, active, onItem, onTurn }: { projectId: string; active: boolean; onItem?: (item: ChatItem, thread: string) => void; onTurn?: (turn: any) => void }) {
  const [socket, setSocket] = useState<"connecting" | "open" | "closed" | "denied">("connecting");
  const [agentState, setAgentState] = useState<string>("asleep");
  const [stateMessage, setStateMessage] = useState("");
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [pick, setPick] = useState(storedModel);
  const pickedRef = useRef("");
  const [thread, setThread] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  // text still arriving: a reply streams in, and the box waits until it pauses
  const [streaming, setStreaming] = useState(false);
  const streamTimer = useRef<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const threadRef = useRef<string | null>(null);
  const pendingSend = useRef<{ client: string; text: string; opts: SendOptions } | null>(null);
  const chosen = useRef(false); // the person picked a conversation (or New chat) themselves
  const listeners = useRef({ onItem, onTurn });
  listeners.current = { onItem, onTurn };
  threadRef.current = thread;

  const raw = (m: any) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(m));
      return true;
    }
    return false;
  };

  const upsert = useCallback((item: ChatItem) => {
    setItems((list) => {
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) {
        const next = list.slice();
        next[i] = item;
        return next;
      }
      // the server's copy of what was just sent replaces the optimistic one
      const base = item.type === "user" ? list.filter((x) => !(x.type === "user" && x.pending)) : list;
      return [...base, item];
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let retry: any;
    let ping: any;
    let seen = Date.now();
    let unsubscribe: (() => void) | undefined;
    let local = false;
    config().then((c) => {
      if (c.localMode) {
        local = true;
        setSocket("closed");
        setReady(false);
        return;
      }
      return supabase().then((s) => {
        unsubscribe = s.auth.onAuthStateChange((_e, sess) => sess?.access_token && raw({ op: "auth", token: sess.access_token })).data.subscription.unsubscribe;
        connect();
      });
    }).catch((e) => setError(e.message));

    const connect = async () => {
      if (stopped) return;
      setSocket("connecting");
      const s = new WebSocket(socketUrl());
      ws.current = s;
      s.onopen = async () => {
        const sb = await supabase();
        const { data } = await sb.auth.getSession();
        s.send(JSON.stringify({ op: "hello", token: data.session?.access_token || "" }));
        seen = Date.now();
        clearInterval(ping);
        ping = setInterval(() => {
          if (Date.now() - seen > SILENT_MS) return s.close();
          raw({ op: "ping" });
        }, PING_MS);
      };
      s.onmessage = (ev) => {
        seen = Date.now();
        let m: any;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (m.op) {
          case "ready":
            failures = 0;
            setSocket("open");
            setReady(true);
            if (Array.isArray(m.models)) setModels(m.models);
            if (m.model) setDefaultModel(m.model);
            setAgentState(m.agent);
            setAllowance(m.allowance);
            updateLiveCreditBalance(m.allowance?.credit_usd);
            setThreads(m.threads);
            setRunning(Object.fromEntries(m.threads.filter((t: Thread) => t.running).map((t: Thread) => [t.id, Date.now()])));
            if (threadRef.current) s.send(JSON.stringify({ op: "open", thread: threadRef.current }));
            break;
          case "status":
            setAgentState(m.agent);
            setStateMessage(m.message || "");
            break;
          case "threads":
            setThreads(m.threads);
            break;
          case "model":
            setThreads((ts) => ts.map((t) => t.id === m.thread ? { ...t, model: m.model, updated: new Date().toISOString() } : t));
            break;
          case "allowance":
            setAllowance({ spent_usd: m.spent_usd, total_usd: m.total_usd, credit_usd: m.credit_usd });
            updateLiveCreditBalance(m.credit_usd);
            break;
          case "thread_created":
            if (pendingSend.current?.client === m.client_id) {
              pendingSend.current = null;
              threadRef.current = m.thread.id;
              setThread(m.thread.id);
              setThreads((ts) => [m.thread, ...ts.filter((t) => t.id !== m.thread.id)]);
              setRunning((r) => ({ ...r, [m.thread.id]: Date.now() }));
              setPendingSince(null);
            }
            break;
          case "history":
            if (m.thread === threadRef.current) {
              setQuestions([]);
              setItems(m.items);
              setLoading(false);
              if (m.running) setRunning((r) => ({ ...r, [m.thread]: r[m.thread] || Date.now() }));
            }
            break;
          case "item":
            if (m.thread === threadRef.current) upsert(m.item);
            listeners.current.onItem?.(m.item, m.thread);
            if (m.item?.type === "tool" && m.item.status === "done" && m.item.focus?.jobs?.length) refreshBilling().catch(() => {});
            break;
          case "question":
            if (m.thread === threadRef.current) setQuestions((qs) => [...qs.filter((x) => x.id !== m.question.id), m.question]);
            break;
          case "answered":
            setQuestions((qs) => qs.filter((x) => x.id !== m.id));
            break;
          case "steered":
            setItems((list) => list.map((x) => (x.id === `local-${m.client_id}` && x.type === "user" ? { ...x, pending: false } : x)));
            break;
          case "delta":
            if (m.thread !== threadRef.current) break;
            if (m.field === "text") {
              setStreaming(true);
              clearTimeout(streamTimer.current);
              streamTimer.current = setTimeout(() => setStreaming(false), 900);
            }
            setItems((list) => list.map((x) => (x.id === m.item_id ? ({ ...x, [m.field]: ((x as any)[m.field] || "") + m.text } as ChatItem) : x)));
            break;
          case "turn":
            if (m.state === "started") setRunning((r) => ({ ...r, [m.thread]: r[m.thread] || Date.now() }));
            else {
              setRunning((r) => {
                const n = { ...r };
                delete n[m.thread];
                return n;
              });
              if (m.thread === threadRef.current) {
                setQuestions([]);
                // a limit isn't a failure: the panel shows it as a card with the way on
                if (m.error && /allowance|out of credit/i.test(m.error)) setError(String(m.error).replace(/^API Error: \d+\s*/, ""));
                else if (m.error && m.state !== "interrupted") upsert({ id: `err-${Date.now()}`, type: "notice", text: `The agent stopped: ${m.error}` });
                upsert({ id: `${m.turn || Date.now()}-turn`, type: "turn", turn: m.turn, project: m.project, from_revision: m.from_revision, to_revision: m.to_revision, seconds: m.seconds, model_usd: m.model_usd, gen_usd: m.gen_usd });
              }
              listeners.current.onTurn?.(m);
              refreshBilling().catch(() => {});
            }
            break;
          case "error":
            if (m.code === "unauthorized") setSocket("denied");
            if (!m.thread || m.thread === threadRef.current || pendingSend.current) {
              setError(m.message || "Something went wrong");
              setItems((list) => list.filter((x) => !(x.type === "user" && x.pending)));
              pendingSend.current = null;
              setPendingSince(null);
              setLoading(false);
            }
            break;
        }
      };
      s.onclose = (ev) => {
        clearInterval(ping);
        if (ws.current !== s) return;
        ws.current = null;
        setReady(false);
        if (stopped) return;
        if (DENIED.has(ev.code)) {
          // a token that expired: one quiet retry with a fresh one, then show it
          if (failures++ < 1) retry = setTimeout(connect, 1000);
          else setSocket("denied");
          return;
        }
        setSocket("closed");
        retry = setTimeout(connect, Math.min(1000 * 2 ** failures++, 15_000));
      };
    };
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      unsubscribe?.();
      if (!local) ws.current?.close();
    };
  }, [upsert]);

  // this project's conversations, newest first; open the latest one when the panel is shown
  const projectThreads = threads.filter((t) => t.project === projectId);
  useEffect(() => {
    if (!active || !ready || chosen.current || threadRef.current) return;
    const latest = projectThreads[0];
    if (latest) {
      threadRef.current = latest.id;
      setThread(latest.id);
      setLoading(true);
      raw({ op: "open", thread: latest.id });
    }
  }, [active, ready, projectThreads[0]?.id]);
  useEffect(() => {
    if (active && ready) raw({ op: "warm" });
  }, [active, ready]);

  const open = useCallback((id: string) => {
    chosen.current = true;
    threadRef.current = id;
    setThread(id);
    setItems([]);
    setError("");
    setLoading(true);
    raw({ op: "open", thread: id });
  }, []);
  const newChat = useCallback(() => {
    chosen.current = true;
    threadRef.current = null;
    setThread(null);
    setItems([]);
    setError("");
  }, []);
  const send = useCallback(
    (text: string, opts: SendOptions = {}) => {
      const client = clientId();
      setError("");
      // a new conversation starts on the picked model; existing conversations may switch in place
      const ok = raw({ op: "send", thread: threadRef.current, text, client_id: client, project: projectId, context: opts.context || [], images: opts.images || [], ...(threadRef.current ? {} : { model: pickedRef.current }) });
      if (!ok) {
        setError("Not connected yet — try again in a moment.");
        return false;
      }
      track("agent_message_sent", { model: pickedRef.current, action: threadRef.current ? "continue" : "new_chat", count: opts.images?.length || 0 });
      if (!threadRef.current) {
        pendingSend.current = { client, text, opts };
        setPendingSince(Date.now());
      }
      upsert({ id: `local-${client}`, type: "user", text, context: opts.context, images: opts.images, pending: true });
      // while a turn runs the message steers it; otherwise it starts one
      if (threadRef.current) setRunning((r) => (r[threadRef.current!] ? r : { ...r, [threadRef.current!]: Date.now() }));
      return true;
    },
    [projectId, upsert],
  );
  const stop = useCallback(() => { if (threadRef.current) { track("agent_stopped"); return raw({ op: "stop", thread: threadRef.current }); } return false; }, []);
  // shown: the answers as the chat shows them (the agent's copy replaces this one when it arrives)
  const answer = useCallback(
    (id: string, answers: Record<string, string[]>, shown: Answer[] = []) => {
      if (!raw({ op: "answer", id, answers })) {
        setError("Not connected yet — try again in a moment.");
        return false;
      }
      setQuestions((qs) => qs.filter((x) => x.id !== id));
      track("agent_question_answered", { count: Object.keys(answers).length });
      if (shown.length) upsert({ id: `local-ans-${id}`, type: "user", text: shown.map((a) => a.answer).join("\n"), answers: shown, pending: true });
      return true;
    },
    [upsert],
  );
  const archive = useCallback(
    (id: string) => {
      raw({ op: "archive", thread: id });
      if (id === threadRef.current) newChat();
    },
    [newChat],
  );

  // the model: this conversation's own, or the one a new conversation will start on
  const offered = (id?: string | null) => (id && models.some((x) => x.id === id) ? id : "");
  const picked = offered(pick) || offered(defaultModel) || models[0]?.id || "";
  pickedRef.current = picked;
  const threadModel = thread ? threads.find((t) => t.id === thread)?.model || null : null;
  const model = threadModel || picked;
  const pickModel = useCallback(
    (id: string) => {
      setPick(id);
      storeModel(id);
      track("agent_model_changed", { model: id, action: threadRef.current ? "existing_chat" : "new_chat" });
      if (threadRef.current) {
        if (!raw({ op: "model", thread: threadRef.current, model: id })) setError("Not connected yet — try again in a moment.");
        else setThreads((ts) => ts.map((t) => t.id === threadRef.current ? { ...t, model: id } : t));
      }
    },
    [],
  );

  const runningSince = (thread ? running[thread] : null) || pendingSince || null;
  return { socket, ready, agentState, stateMessage, allowance, threads: projectThreads, thread, items, questions, running: !!runningSince, runningSince, streaming, error, setError, loading, open, newChat, send, stop, archive, answer, models, model, pickModel };
}
