import { useEffect, useState } from "react";
import { api } from "./api";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";

type Me = { email: string; budget: { monthlyCapCredits: number; spentThisMonthCredits: number; remainingCredits: number; autoApproveBelowCredits: number }; keys: { id: string; name: string; prefix: string; kind?: string; created_at: string; last_used_at: string | null }[]; mcpUrl: string; quick_auto?: boolean };

// A block of code or config with a copy button that confirms.
export function Code({ label, text }: { label?: string; text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1400)));
  return (
    <div className="code">
      {label && <span className="code-label">{label}</span>}
      <pre>{text}</pre>
      <button className={`code-copy ${done ? "done" : ""}`} onClick={copy} title="Copy">
        {done ? <Check size={13} /> : <Copy size={13} />} {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Section({ title, text, children }: { title: string; text?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="pg-sec">
      <div className="pg-sec-l">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
      <div className="pg-sec-r">{children}</div>
    </section>
  );
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function Settings() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState("");
  const [newKey, setNewKey] = useState<{ key: string; command: string } | null>(null);
  const [making, setMaking] = useState(false);
  const [cap, setCap] = useState("");
  const [auto, setAuto] = useState("");
  const [saved, setSaved] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const load = () =>
    api<Me>("/api/me")
      .then((m) => (setMe(m), setErr(""), setCap(String(m.budget.monthlyCapCredits)), setAuto(String(m.budget.autoApproveBelowCredits))))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!me)
    return (
      <div className="pg">
        {err ? (
          <p className="error">
            Couldn't load settings: {err}{" "}
            <button className="btn small" onClick={load}>
              Retry
            </button>
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  const make = async () => {
    setMaking(true);
    try {
      setNewKey(await api("/api/keys", { name: "Claude Code" }));
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setMaking(false);
    }
  };
  const skillCmd = (agent: "claude" | "codex") => `mkdir -p ~/.${agent}/skills/studio && curl -fsS ${location.origin}/skill.md -o ~/.${agent}/skills/studio/SKILL.md`;
  const codex = (key: string) => `[mcp_servers.studio]\nurl = "${me.mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${key}" }`;
  const json = (key: string) => JSON.stringify({ mcpServers: { studio: { url: me.mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const used = Math.min(100, (100 * me.budget.spentThisMonthCredits) / Math.max(1, me.budget.monthlyCapCredits));
  const dirty = cap !== String(me.budget.monthlyCapCredits) || auto !== String(me.budget.autoApproveBelowCredits);
  return (
    <div className="pg">
      <header className="pg-head">
        <h1>Connect</h1>
        <p>Use Studio from your own agent. Claude Code, Codex and Cursor get every Studio tool over MCP: projects, uploads, generation, timeline edits, frame views and renders.</p>
      </header>
      {err && <p className="error">{err}</p>}

      <Section title="MCP server" text="Create a key, then paste the command for your agent. The key is shown once.">
        <Code text={me.mcpUrl} />
        {!newKey ? (
          <button className="btn primary" onClick={make} disabled={making}>
            {making ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Create API key
          </button>
        ) : (
          <div className="reveal">
            <p className="reveal-note">
              <KeyRound size={13} /> Your new key. Copy it now; it won't be shown again.
            </p>
            <Code label="Claude Code" text={newKey.command} />
            <Code label="Codex · ~/.codex/config.toml" text={codex(newKey.key)} />
            <Code label="Cursor and others · mcp.json" text={json(newKey.key)} />
          </div>
        )}
      </Section>

      {me.keys.length > 0 && (
        <Section title="API keys" text="Revoking a key disconnects whatever uses it straight away.">
          <table className="tbl">
            <tbody>
              {me.keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <span className="tbl-main">{k.kind === "hosted" ? "Built-in agent" : k.name}</span>
                    <span className="tbl-sub">{k.kind === "hosted" ? "Renews on its own" : `Created ${when(k.created_at)}`}</span>
                  </td>
                  <td>
                    <code className="muted">{k.prefix}…</code>
                  </td>
                  <td className="muted small">{k.last_used_at ? `Used ${when(k.last_used_at)}` : "Never used"}</td>
                  <td className="tbl-act">
                    <button
                      className={`btn small ghost ${revoking === k.id ? "danger" : ""}`}
                      onBlur={() => setRevoking(null)}
                      onClick={async () => (revoking === k.id ? (await api(`/api/keys/${k.id}/revoke`, {}), setRevoking(null), load()) : setRevoking(k.id))}
                    >
                      {revoking === k.id ? "Confirm revoke" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Studio skill" text="Optional. Loads the same editing and generation playbooks into your agent up front.">
        <Code label="Claude Code" text={skillCmd("claude")} />
        <Code label="Codex" text={skillCmd("codex")} />
      </Section>

      <Section title="Spending limits" text="Safety limits on top of your credit. Every generation is priced first; above the auto-approve limit your agent sends you a link to approve.">
        <div className="usage">
          <div className="usage-row">
            <span>This month</span>
            <span className="num">
              {me.budget.spentThisMonthCredits.toLocaleString()} <span className="muted">/ {me.budget.monthlyCapCredits.toLocaleString()} credits</span>
            </span>
          </div>
          <div className="meter">
            <div style={{ width: `${used}%` }} />
          </div>
        </div>
        <div className="pg-fields">
          <label className="field">
            <span>Monthly cap</span>
            <span className="money">
              <i>cr</i>
              <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span>Auto-approve each run below</span>
            <span className="money">
              <i>cr</i>
              <input inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} />
            </span>
          </label>
          <button
            className="btn"
            disabled={!dirty && !saved}
            onClick={async () => {
              await api("/api/settings", { monthly_cap_credits: Number(cap), per_op_auto_credits: Number(auto) });
              setSaved(true);
              setTimeout(() => setSaved(false), 1400);
              load();
            }}
          >
            {saved ? <Check size={14} /> : null} {saved ? "Saved" : "Save"}
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={!!me.quick_auto} onChange={async (e) => (await api("/api/settings", { quick_auto: e.target.checked }), load())} />
          <span>
            Let the built-in agent run quick generations on its own
            <small>Look frames, sheets and voice samples, under about 20 credits each and up to 400 credits a project. Off: every generation waits for you in the box under the chat. Video always waits.</small>
          </span>
        </label>
      </Section>
    </div>
  );
}
