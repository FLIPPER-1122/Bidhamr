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
