// Sign-in, and the terms and privacy pages (the signed-out front page is Guest.tsx).
import { supabase, navigate } from "./api";
import { FoltioBrand } from "./Brand";

export async function signIn(provider: "google" | "discord", returnTo = location.pathname) {
  const s = await supabase();
  await s.auth.signInWithOAuth({
    provider,
    options: { redirectTo: location.origin + (returnTo.startsWith("/terms") || returnTo.startsWith("/privacy") ? "/" : returnTo), ...(provider === "google" ? { queryParams: { prompt: "select_account" } } : {}) },
  });
}

const Brand = () => (
  <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
    <FoltioBrand />
  </a>
);

function Footer() {
  return (
    <footer className="pub-foot muted small">
      <a href="/terms" onClick={(e) => (e.preventDefault(), navigate("/terms"))}>Terms</a>
      <a href="/privacy" onClick={(e) => (e.preventDefault(), navigate("/privacy"))}>Privacy</a>
      <a href="mailto:hello@folt.io">hello@folt.io</a>
    </footer>
  );
}

export function Legal({ page }: { page: "terms" | "privacy" }) {
  return (
    <div className="pub">
      <header className="pub-top">
        <Brand />
        <a className="btn small" href="/" onClick={(e) => (e.preventDefault(), navigate("/"))}>
          Open FOLTIO
        </a>
      </header>
      <div className="pub-doc prose">{page === "terms" ? <Terms /> : <Privacy />}</div>
      <Footer />
    </div>
  );
}

function Terms() {
  return (
    <article>
      <h1>Terms of service</h1>
      <p className="muted small">Last updated October 5, 2026</p>
      <p>Studio at folt.io is an AI video editor. By using it you agree to these terms.</p>
      <h2>Accounts</h2>
      <p>You need to be at least 18, and you sign in with Google or Discord. One person, one account; keep your API keys private, since anything done with them is done by your account.</p>
      <h2>Credit and payments</h2>
      <p>
        AI generation and the built-in agent are paid for with credits. You see the credit price of each generation before it runs. The base price is 100 credits per $1; plans and larger top-ups can include bonus credits. Purchased top-up credits never expire; each monthly-plan refill rolls over for three months. Monthly plans renew until canceled and can be managed from Billing. Credits can't be exchanged for cash. The welcome credit is
        one per person and has no cash value. If a generation fails, its cost goes back to your balance. If something went wrong with a purchase, write to hello@folt.io within 14 days and we'll make it right; unused credit from a purchase can be
        refunded on request.
      </p>
      <h2>Your content</h2>
      <p>
        You own what you upload and what you make here, as far as the law allows for AI-generated material. You give us only the permission we need to store, process and show it to you, and to run the models you ask for. You're responsible
        for having the rights to what you upload.
      </p>
      <h2>Public projects</h2>
      <p>
        Projects start public: anyone with the public link can watch them, see how they were made (the board and media), and clone them into their own account. You can make any project private from its editor at any time.
      </p>
      <h2>What you can't make</h2>
      <p>
        No sexual content, and nothing sexual involving minors, ever. No content that depicts a real person without their consent in a way that deceives or harms them, no harassment, threats or hate, no content that infringes someone
        else's rights, and nothing illegal. Our generation providers apply their own safety filters. We may remove content and close accounts that break these rules, and report what the law requires us to.
      </p>
      <h2>AI output</h2>
      <p>Generated media can be wrong, odd or similar to existing work. Check it before you publish it, and label it as AI-generated where the law or a platform requires.</p>
      <h2>The service</h2>
      <p>We work to keep Studio running and your work safe, but it's provided as is. To the extent the law allows, our liability is limited to what you paid us in the last 12 months. We may change these terms; we'll say so on this page.</p>
      <h2>Contact</h2>
      <p>hello@folt.io. To report content, write to the same address with a link; we act on valid takedown requests within 48 hours.</p>
    </article>
  );
}

function Privacy() {
  return (
    <article>
      <h1>Privacy</h1>
      <p className="muted small">Last updated October 8, 2026</p>
      <h2>What we keep</h2>
      <p>
        Your email address and name from Google or Discord; your projects, uploads, generations and chats with the built-in agent; what you spend and buy; and basic logs (IP address, browser) to keep the service secure. We don't sell your
        data. We use limited visit and conversion data to measure our own advertising.
      </p>
      <h2>Who processes it</h2>
      <p>
        Supabase (sign-in and database), Cloudflare R2 (media storage), fal (AI generation: your prompts and reference images go to the model you choose), OpenRouter (the built-in agent), Stripe (payments; we never see your card), Resend
        (email), and Reddit when you arrive through or interact with a Reddit advertisement. Reddit receives page visits and sign-up conversion data so we
        can measure campaigns; identifiers sent with a server-side conversion are hashed. They process data only to provide their part of the service or measurement.
      </p>
      <h2>Your choices</h2>
      <p>You can delete projects and media anytime. To delete your account and everything in it, or to get a copy of your data, write to hello@folt.io and we'll do it within 30 days.</p>
      <h2>Cookies</h2>
      <p>We use local storage and cookies to keep you signed in, remember product preferences, and attribute visits and sign-ups from our Reddit advertisements. You can block advertising measurement in your browser; the studio still works.</p>
      <h2>Contact</h2>
      <p>hello@folt.io</p>
    </article>
  );
}
