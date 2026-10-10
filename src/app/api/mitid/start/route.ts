import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { authorizeUrl, callbackUrl, mitIdKonfig, mitIdKonfigMangler, sha256Hex, sideOrigin, tilfaeldig } from "@/lib/mitid/oidc";
import {
  FLOW_LEVETID_SEK,
  MITID_COOKIE,
  MITID_COOKIE_STI,
  renRetur,
  tilApp,
  tilSide,
} from "@/lib/mitid/flow";

// Starter MitID-verificeringen (Idura Verify, OIDC authorization code + PKCE).
//
// Hjemmesiden:  GET /api/mitid/start?retur=/auktion/<id>
//   Kræver login (cookie). Brugeren sendes tilbage til `retur` med ?mitid=<resultat>.
// Appen:        GET /api/mitid/start?t=<engangs-token>
//   Tokenet fås fra POST /api/mitid/app (Bearer-session) og kan bruges én gang
//   inden for 2 minutter. Bagefter sendes appen til sit deep link
//   (bidhamr://mitid?status=<resultat>). Se docs/MITID.md.
//
// Proxyen lukker /api/mitid igennem uden gaten (src/lib/supabase/middleware.ts);
// adgangskontrollen sker her.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const appToken = sp.get("t");
  const retur = renRetur(sp.get("retur"));

  const k = mitIdKonfig();
  const cb = callbackUrl(req.nextUrl.origin);
  const origin = cb ? sideOrigin(cb) : req.nextUrl.origin;
  const fejl = (r: Parameters<typeof tilSide>[2]) => (appToken ? tilApp(r) : tilSide(origin, retur, r));
  if (!k || !cb) {
    const aarsag = [...mitIdKonfigMangler(), ...(cb ? [] : [`ukendt origin ${req.nextUrl.origin}`])];
    console.error(`MitID ikke tilgængelig: ${aarsag.join("; ")}`);
    return fejl("ikkeTilgaengelig");
  }

  const ip = await klientIp();
  const admin = createAdminClient();
  const nu = new Date();
  const state = tilfaeldig(32);
  const nonce = tilfaeldig(32);
  const codeVerifier = tilfaeldig(48);
  const udloeber = new Date(nu.getTime() + FLOW_LEVETID_SEK * 1000).toISOString();

  try {
    if (appToken) {
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(appToken)) return tilApp("udloebet");
      if (!(await tjekGraenser([["mitid_start_ip", ip]]))) return tilApp("forMange");
      // Indløs tokenet atomisk (kun én gang, kun inden for levetiden).
      const { data, error } = await admin
        .from("mitid_flow")
        .update({
          starttoken_hash: null,
          startet_kl: nu.toISOString(),
          state_hash: sha256Hex(state),
          nonce,
          code_verifier: codeVerifier,
          udloeber_kl: udloeber,
        })
        .eq("starttoken_hash", sha256Hex(appToken))
        .eq("app", true)
        .is("startet_kl", null)
        .gt("udloeber_kl", nu.toISOString())
        .select("bruger_id")
        .maybeSingle<{ bruger_id: string }>();
      if (error) throw error;
      if (!data) return tilApp("udloebet");
    } else {
      const supabase = await createClient();
      const { data: auth } = await supabase.auth.getUser();
      const bruger = auth.user;
      if (!bruger) {
        const login = new URL("/login", origin);
        login.searchParams.set("redirect", `/api/mitid/start?retur=${encodeURIComponent(retur)}`);
        return NextResponse.redirect(login, 303);
      }
      if (!(await tjekGraenser([["mitid_start_bruger", bruger.id], ["mitid_start_ip", ip]]))) {
        return tilSide(origin, retur, "forMange");
      }
      const { data: u } = await supabase
        .from("users")
        .select("konto_type, mitid_verificeret_kl")
        .eq("id", bruger.id)
        .maybeSingle<{ konto_type: string | null; mitid_verificeret_kl: string | null }>();
      if (u?.konto_type === "erhverv") return tilSide(origin, retur, "erhverv");
      if (u?.mitid_verificeret_kl) return tilSide(origin, retur, "allerede");

      const { error } = await admin.from("mitid_flow").insert({
        bruger_id: bruger.id,
        state_hash: sha256Hex(state),
        nonce,
        code_verifier: codeVerifier,
        retur,
        app: false,
        udloeber_kl: udloeber,
        startet_kl: nu.toISOString(),
      });
      if (error) throw error;
    }

    // Gamle forløb ryddes op (ikke handelsdata). Fejl her stopper ikke login.
    void admin.rpc("mitid_flow_oprydning").then(({ error }) => {
      if (error) console.error("mitid_flow_oprydning fejlede:", error.message);
    });

    const url = await authorizeUrl(k, { redirectUri: cb, state, nonce, codeVerifier });
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(MITID_COOKIE, state, {
      httpOnly: true,
      secure: cb.startsWith("https:"),
      // Lax: cookien sendes med, når Idura sender brugeren tilbage (GET).
      sameSite: "lax",
      path: MITID_COOKIE_STI,
      maxAge: FLOW_LEVETID_SEK,
    });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/mitid/start", fejl: err });
    return fejl("fejl");
  }
}
