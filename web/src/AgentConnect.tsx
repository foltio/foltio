import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plug, ShieldCheck, XCircle } from "lucide-react";
import { api, navigate } from "./api";
import { FoltioBrand } from "./Brand";
import { signIn } from "./Public";

type Connection = {
  request_code: string;
  client_name: string;
  status: "pending" | "connected" | "denied" | "expired";
  expires_at: string;
  token_expires_at?: string | null;
};

export function AgentConnect({ code, signedIn }: { code: string; signedIn: boolean }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | "google" | "discord" | null>(null);

  useEffect(() => {
    fetch(`/api/agent/connections/${encodeURIComponent(code)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Connection not found.");
        setConnection(body);
      })
      .catch((cause) => setError(cause.message));
  }, [code]);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError("");
    try {
      const result = await api<Connection>(`/api/agent/connections/${code}/${decision}`, {});
      setConnection((current) => ({ ...(current as Connection), ...result }));
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(null);
    }
  };

  const login = async (provider: "google" | "discord") => {
    setBusy(provider);
    try {
      await signIn(provider, `/c/${code}`);
    } catch (cause: any) {
      setError(cause.message || "Sign-in did not start.");
      setBusy(null);
    }
  };

  const terminal = connection?.status === "connected" || connection?.status === "denied" || connection?.status === "expired";
  return (
    <div className="signin agent-connect-page">
      <div className="signin-card agent-connect-card">
        <button className="agent-connect-brand" onClick={() => navigate("/")}><FoltioBrand /></button>
        {!connection && !error && <div className="agent-connect-loading"><Loader2 className="spin" size={18} /> Checking connection…</div>}
        {error && !connection && <><XCircle className="agent-connect-bad" size={30} /><h1>Connection unavailable</h1><p className="muted">{error}</p></>}
        {connection && connection.status === "pending" && (
          <>
            <div className="agent-connect-icon"><Plug size={22} /></div>
            <div>
              <span className="micro">Agent connection</span>
              <h1>Connect {connection.client_name}</h1>
            </div>
            <p className="muted">This gives the agent access to your FOLTIO projects through the API and MCP. It can create projects, add media, edit timelines and render films.</p>
            <div className="agent-connect-safety">
              <ShieldCheck size={17} />
              <span>Generation still follows your credit balance, monthly cap and approval threshold. You can revoke this connection anytime.</span>
            </div>
            {!signedIn ? (
              <div className="agent-connect-actions stacked">
                <p>Sign in to choose whether to connect.</p>
                <button className="btn primary wide" disabled={!!busy} onClick={() => void login("google")}>{busy === "google" ? <Loader2 className="spin" size={14} /> : null} Continue with Google</button>
                <button className="btn wide" disabled={!!busy} onClick={() => void login("discord")}>{busy === "discord" ? <Loader2 className="spin" size={14} /> : null} Continue with Discord</button>
              </div>
            ) : (
              <div className="agent-connect-actions">
                <button className="btn primary" disabled={!!busy} onClick={() => void decide("approve")}>{busy === "approve" ? <Loader2 className="spin" size={14} /> : <Plug size={14} />} Connect agent</button>
                <button className="btn ghost" disabled={!!busy} onClick={() => void decide("deny")}>Deny</button>
              </div>
            )}
          </>
        )}
        {connection?.status === "connected" && (
          <>
            <CheckCircle2 className="agent-connect-good" size={34} />
            <h1>{connection.client_name} is connected</h1>
            <p className="muted">You can close this tab. The agent will continue automatically and should share the project link as soon as it starts.</p>
            <button className="btn" onClick={() => navigate("/settings")}>Manage connections</button>
          </>
        )}
        {connection?.status === "denied" && (
          <><XCircle className="agent-connect-bad" size={34} /><h1>Connection denied</h1><p className="muted">Nothing was connected. You can close this tab.</p></>
        )}
        {connection?.status === "expired" && (
          <><XCircle className="agent-connect-bad" size={34} /><h1>Connection link expired</h1><p className="muted">Ask the agent to create and show you a new link.</p></>
        )}
        {error && connection && !terminal && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
