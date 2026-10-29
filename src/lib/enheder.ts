import "server-only";

// Kendte enheder og mail ved login fra en ny enhed.
//
// Hver browser får en tilfældig langtidscookie (bh_enhed). Kun SHA-256 af
// værdien gemmes i kendte_enheder sammen med en kort beskrivelse fra
// user-agent ("Chrome på Windows") og tidspunkter – aldrig IP-adressen.
// Første login nogensinde (fx lige efter oprettelse) giver ingen mail.
//
// Kaldes kun fra server actions og route handlers (cookies kan kun sættes dér).
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { userAgentFromString } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { nytLoginMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";
import { indenForGraense } from "@/lib/rateLimit";

export const ENHED_COOKIE = "bh_enhed";
// Browsere gemmer højst cookies i 400 dage.
const ENHED_MAKS_ALDER = 400 * 24 * 60 * 60;

export function hashEnhed(vaerdi: string): string {
  return createHash("sha256").update(vaerdi).digest("hex");
}

function gyldigVaerdi(v: string | undefined): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}

// Hash af den nuværende enheds cookie, eller null. Må bruges i server components.
export async function nuvaerendeEnhedHash(): Promise<string | null> {
  const v = (await cookies()).get(ENHED_COOKIE)?.value;
  return gyldigVaerdi(v) ? hashEnhed(v) : null;
}

// Loftet pr. e-mail på admin-login (src/lib/adgang.ts, graensePrEmail)
// gælder ikke, hvis
//   - denne browser er en kendt enhed for netop den medarbejder: cookien
//     bh_enhed er registreret, OG to-trins-loginet (koden fra app'en) er
//     gennemført på admin-hosten fra den inden for 90 dage
//     (kendte_enheder.admin_mfa_kl, markerAdminMfa). Et login med
//     adgangskoden alene gør IKKE enheden kendt. Markeringen ryddes, når
//     adgangskoden skiftes, når to-trins-loginet nulstilles eller gendannes
//     (triggere, 20261102430000), og ved "Log ud andre steder"
//     (rydAdminMfa). Svaret har enhedens hash, så adgang.ts kan tælle et
//     loft pr. enhed i stedet.
//   - chefen har nulstillet loftet for medarbejderen ("Nulstil login-loft"
//     under Medarbejdere: 30 minutter, eller til to-trins-loginet er
//     gennemført).
// null = loftet gælder (også ved fejl, ingen cookie, eller hvis migrationen
// 20261102430000 ikke er kørt). Cookien er 32 tilfældige bytes - den kan
// ikke gættes. Den er host-only, så admin-hosten har sin egen.
export type LoftUndtagelse = { kode: "enhed"; hash: string } | { kode: "fritaget" };

export async function loftUndtagelse(brugerId: string): Promise<LoftUndtagelse | null> {
  try {
    const hash = await nuvaerendeEnhedHash();
    const { data, error } = await createAdminClient().rpc("admin_login_loft_undtaget", {
      p_bruger: brugerId,
      p_hash: hash,
    });
    if (error) {
      console.error("loftUndtagelse: opslag fejlede:", error.message);
      return null;
    }
    if (data === "enhed" && hash) return { kode: "enhed", hash };
    if (data === "fritaget") return { kode: "fritaget" };
    return null;
  } catch (err) {
    console.error("loftUndtagelse kastede:", err);
    return null;
  }
}

// To-trins-loginet er netop gennemført på admin-hosten fra denne browser:
// enheden bliver kendt for loftet pr. e-mail (se loftUndtagelse), og en
// fritagelse fra chefen slutter. Kaster aldrig - koden er godkendt, og
// loginet må ikke fejle her.
export async function markerAdminMfa(brugerId: string): Promise<void> {
  try {
    const hash = await nuvaerendeEnhedHash();
    if (!hash) return;
    const { error } = await createAdminClient().rpc("kendt_enhed_admin_mfa", { p_bruger: brugerId, p_hash: hash });
    if (error && error.code !== "PGRST202") {
      await logDriftFejl({ kilde: "action", hvor: "markerAdminMfa", fejl: error, brugerId });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "markerAdminMfa", fejl: err, brugerId });
  }
}

// "Log ud andre steder": ingen af brugerens enheder er længere kendt for
// loftet pr. e-mail. Kaster aldrig.
export async function rydAdminMfa(brugerId: string): Promise<void> {
  try {
    const { error } = await createAdminClient().rpc("kendte_enheder_ryd_admin_mfa", { p_bruger: brugerId });
    if (error && error.code !== "PGRST202") {
      await logDriftFejl({ kilde: "action", hvor: "rydAdminMfa", fejl: error, brugerId });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "rydAdminMfa", fejl: err, brugerId });
  }
}

// Henter (eller opretter) enhedens cookie og returnerer dens hash.
async function enhedHash(): Promise<string> {
  const jar = await cookies();
  let v = jar.get(ENHED_COOKIE)?.value;
  if (!gyldigVaerdi(v)) v = randomBytes(32).toString("base64url");
  // Fornyes ved hvert login, så en aktiv enhed ikke glemmes.
  jar.set(ENHED_COOKIE, v, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ENHED_MAKS_ALDER,
  });
  return hashEnhed(v);
}

const BROWSER_NAVN: Record<string, string> = {
  "Mobile Safari": "Safari",
  "Chrome WebView": "Chrome",
  "Mobile Chrome": "Chrome",
  "Mobile Firefox": "Firefox",
  "Samsung Browser": "Samsung Internet",
};

const OS_NAVN: Record<string, string> = {
  "Mac OS": "Mac",
  macOS: "Mac",
  iOS: "iPhone/iPad",
  "Chromium OS": "Chromebook",
};

// "Chrome på Windows", "Safari på iPhone" osv. Kort og uden versionsnumre.
export function beskrivEnhed(ua: string | null | undefined): string {
  const info = userAgentFromString(ua ?? "");
  const browser = info.browser.name ? (BROWSER_NAVN[info.browser.name] ?? info.browser.name) : null;
  let os = info.os.name ? (OS_NAVN[info.os.name] ?? info.os.name) : null;
  if (info.os.name === "iOS" && info.device.model) os = info.device.model;
  if (browser && os) return `${browser} på ${os}`.slice(0, 200);
  if (browser) return browser.slice(0, 200);
  if (os) return os.slice(0, 200);
  return "Ukendt enhed";
}

// Session-id fra et access token (JWT-claimet session_id). Tokenet er netop
// valideret af Supabase (login/verifyOtp/getUser), så det må dekodes her.
export function sessionIdFraToken(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  try {
    const del = accessToken.split(".")[1];
    const claims = JSON.parse(Buffer.from(del, "base64url").toString("utf8")) as {
      session_id?: unknown;
    };
    const id = claims.session_id;
    return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Registrerer et gennemført login. Sender "Nyt login"-mail, hvis enheden er
// ny og brugeren har logget ind før. Kaster aldrig - et login må ikke fejle,
// fordi registreringen gør.
export async function registrerLogin(input: {
  brugerId: string;
  email: string | null | undefined;
  accessToken: string | null | undefined;
}): Promise<void> {
  try {
    const hash = await enhedHash();
    const ua = (await headers()).get("user-agent");
    const beskrivelse = beskrivEnhed(ua);
    const { data, error } = await createAdminClient().rpc("registrer_login", {
      p_bruger: input.brugerId,
      p_hash: hash,
      p_beskrivelse: beskrivelse,
      p_session: sessionIdFraToken(input.accessToken),
    });
    if (error) {
      await logDriftFejl({ kilde: "action", hvor: "registrerLogin", fejl: error, brugerId: input.brugerId });
      return;
    }
    const svar = data as { ny?: boolean; send_mail?: boolean } | null;
    // Højst 5 "Nyt login"-mails pr. bruger i timen.
    if (svar?.send_mail && input.email && (await indenForGraense("nyt_login_mail", input.brugerId))) {
      const res = await sendHandelMailDetaljer(
        input.email,
        nytLoginMail({ tidspunkt: new Date(), enhed: beskrivelse }),
      );
      if (!res.ok) {
        await logDriftFejl({ kilde: "action", hvor: "nytLoginMail", fejl: res.fejl, brugerId: input.brugerId });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "registrerLogin", fejl: err, brugerId: input.brugerId });
  }
}
