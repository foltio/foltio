// Reddit conversion measurement. The browser Pixel and this server-side event share a conversion
// id so Reddit counts one SignUp even when both arrive. Match keys are normalized and hashed here.
import { createHash } from "node:crypto";
import { config } from "./config.mjs";

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const canonicalEmail = (value) => {
  const [local, domain = ""] = String(value).trim().toLowerCase().split("@");
  return `${local.split("+")[0].replaceAll(".", "")}@${domain}`;
};

export async function redditSignUp({ account, conversionId, clickId, ip, userAgent }) {
  const { pixel, token } = config.reddit;
  if (!pixel || !token) return false;
  const user = { email: sha(canonicalEmail(account.email)), external_id: sha(String(account.id).trim().toLowerCase()) };
  if (ip) user.ip_address = ip;
  if (userAgent) user.user_agent = String(userAgent).slice(0, 400);
  const source = new URL(config.publicOrigin);
  if (clickId) source.searchParams.set("rdt_cid", String(clickId).slice(0, 200));
  const event = {
    event_at: Date.now(),
    event_source_url: source.toString(),
    action_source: "WEBSITE",
    type: { tracking_type: "SIGN_UP" },
    metadata: { conversion_id: String(conversionId).slice(0, 128) },
    user,
    ...(clickId ? { click_id: String(clickId).slice(0, 200) } : {}),
  };
  try {
    const response = await fetch(`https://ads-api.reddit.com/api/v3/pixels/${pixel}/conversion_events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "foltio-studio/1.0 (+https://folt.io)" },
      body: JSON.stringify({ data: { events: [event] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.warn(`reddit conversion ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.ok;
  } catch (error) {
    console.warn(`reddit conversion failed: ${error.message}`);
    return false;
  }
}
