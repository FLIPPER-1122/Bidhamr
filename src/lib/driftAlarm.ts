import "server-only";

// Drift-alarmer: samlet mail til Filip, når noget går galt. Kaldes af
// /api/cron/drift-alarm (pg_cron hvert 5. minut, se migration
// 20261008010000_drift_alarmer.sql).
//
// Databasen (drift_alarm_vurder_blokke, migration
// 20261021030000_drift_alarm_blokke.sql) finder hændelserne, samler dem i
// blokke (samme kilde og kode) og afgør atomisk, hvilke blokke der sendes:
// nye fejl med det samme; gentagelser af samme fejl samles (røde højst hvert
// 15. minut, gule højst én gang i timen).
// Selve mailen bygges af src/lib/driftAlarmMail.ts.
//
// Er migrationen ikke kørt, bruges den gamle drift_alarm_vurder (én mail pr.
// slags pr. 30 min.), og punkterne samles til blokke her.
//
// Modtager: DRIFT_ALARM_MAIL (en eller flere adresser, kommasepareret). Er den
// ikke sat, sendes intet, og det logges. På testdatabasen sendes aldrig
// rigtige mails (getResend logger dem eller omdirigerer til
// MAIL_TEST_MODTAGER).
//
// Ingen persondata i mailen: kun kilde, kode, sti og fejltekst, som allerede
// er renset af src/lib/drift.ts - og renses igen her. Browser-fejl (kilde
// 'klient') vises kun som antal.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst, renSti } from "@/lib/drift";
import {
  bygAlarmMail,
  grupperGamleAlarmer,
  GENSEND_MIN,
  GENSEND_ROED_MIN,
  type AlarmBlok,
  type GammelAlarm,
} from "@/lib/driftAlarmMail";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { getResend } from "@/lib/resend";

export { renLinks } from "@/lib/driftAlarmMail";

export type AlarmSlags = "ny_fejl" | "mange_fejl" | "cron" | "webhook";

export const ALARM_SLAGS: Record<AlarmSlags, string> = {
  ny_fejl: "Ny slags fejl",
  mange_fejl: "Mange fejl på kort tid",
  cron: "Faste kørsler (cron)",
  webhook: "Beskeder udefra (webhooks)",
};

// Gentagelser af samme fejl: gule højst én gang pr. ALARM_INTERVAL_MIN
// minutter, røde højst hvert ALARM_INTERVAL_ROED_MIN.
export const ALARM_INTERVAL_MIN = GENSEND_MIN;
export const ALARM_INTERVAL_ROED_MIN = GENSEND_ROED_MIN;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

// Gyldige modtagere fra DRIFT_ALARM_MAIL (højst 5). Tom liste = ikke sat.
export function alarmModtagere(): string[] {
  const raa = process.env.DRIFT_ALARM_MAIL ?? "";
  return raa
    .split(",")
    .map((s) => s.trim())
    .filter((s) => EMAIL.test(s))
    .slice(0, 5);
}

type BlokSvar = {
  blokke?: AlarmBlok[];
  ingen_modtager?: { slags: string; noegle: string; antal: number }[];
  holdt?: { slags: string; noegle: string }[];
  tidspunkt: string;
};

type GammeltSvar = {
  send?: (GammelAlarm & { forrige_daekket_til?: string; forrige_sendt_kl?: string | null })[];
  undertrykt?: string[];
  tidspunkt: string;
};

// Renser blokkene igen, før de kommer i mailen.
function rensBlok(b: AlarmBlok): AlarmBlok {
  const klient = b.kilde === "klient";
  return {
    ...b,
    noegle: String(b.noegle ?? "").slice(0, 200),
    kilde: String(b.kilde ?? "").slice(0, 20),
    kode: klient ? "klient" : renFejltekst(String(b.kode ?? ""), 120),
    antal: Number.isFinite(Number(b.antal)) ? Math.max(0, Math.floor(Number(b.antal))) : 0,
    eksempler: (Array.isArray(b.eksempler) ? b.eksempler : []).slice(0, 5).map((e) =>
      klient
        ? {}
        : {
            kilde: e?.kilde ?? null,
            sti: e?.sti ? renSti(String(e.sti)) : null,
            besked: e?.besked ? renFejltekst(String(e.besked), 300) : null,
            antal: typeof e?.antal === "number" ? e.antal : null,
          },
    ),
  };
}

const unikke = (l: string[]) => [...new Set(l)];

// PostgREST kender ikke funktionen (migrationen er ikke kørt).
function manglerFunktion(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

export type AlarmResultat =
  | { status: "ingen" }
  | { status: "undertrykt"; slags: string[] }
  | { status: "ingen_modtager"; slags: string[] }
  | { status: "sendt"; slags: string[] }
  | { status: "fejl"; fejl: string };

export async function koerDriftAlarm(): Promise<AlarmResultat> {
  const admin = createAdminClient();
  const modtagere = alarmModtagere();
  const kanSende = modtagere.length > 0 && getResend() !== null;

  let blokke: AlarmBlok[];
  let ingenModtager: string[];
  let holdt: string[];
  let rulTilbage: (fejl: string) => Promise<{ message: string } | null>;

  const nyt = await admin.rpc("drift_alarm_vurder_blokke", { p_kan_sende: kanSende });
  if (!nyt.error) {
    const v = nyt.data as BlokSvar;
    blokke = (Array.isArray(v?.blokke) ? v.blokke : []).map(rensBlok);
    ingenModtager = unikke((v?.ingen_modtager ?? []).map((b) => b.slags));
    holdt = unikke((Array.isArray(v?.holdt) ? v.holdt : []).map((b) => b.slags));
    rulTilbage = async (fejl) => {
      const { error } = await admin.rpc("drift_alarm_blokke_fejlet", {
        p_tidspunkt: v.tidspunkt,
        p_blokke: blokke.map((b) => ({
          noegle: b.noegle,
          antal: b.antal,
          fra: b.fra,
          til: b.til,
          eksempler: b.eksempler,
          forrige_antal: b.forrige_antal ?? 0,
          forrige_sendt_kl: b.forrige_sendt_kl ?? null,
        })),
        p_fejl: fejl,
      });
      return error;
    };
  } else if (manglerFunktion(nyt.error)) {
    // Migrationen 20261021030000 er ikke kørt: det gamle format.
    const gammel = await admin.rpc("drift_alarm_vurder", { p_kan_sende: kanSende });
    if (gammel.error) return vurderingFejlede(gammel.error.message);
    const v = gammel.data as GammeltSvar;
    const send = Array.isArray(v?.send) ? v.send : [];
    blokke = kanSende ? grupperGamleAlarmer(send).map(rensBlok) : [];
    ingenModtager = kanSende ? [] : send.map((a) => a.slags);
    holdt = v?.undertrykt ?? [];
    rulTilbage = async (fejl) => {
      const { error } = await admin.rpc("drift_alarm_mail_fejlet", {
        p_tidspunkt: v.tidspunkt,
        p_alarmer: send.map((a) => ({
          slags: a.slags,
          forrige_daekket_til: a.forrige_daekket_til ?? null,
          forrige_sendt_kl: a.forrige_sendt_kl ?? null,
        })),
        p_fejl: fejl,
      });
      return error;
    };
  } else {
    return vurderingFejlede(nyt.error.message);
  }

  if (!kanSende) {
    if (ingenModtager.length === 0) return { status: "ingen" };
    console.warn(
      `Drift-alarm: ${ingenModtager.join(", ")} udløst, men ${
        modtagere.length === 0 ? "DRIFT_ALARM_MAIL er ikke sat" : "RESEND_API_KEY mangler"
      } – ingen mail sendt.`,
    );
    return { status: "ingen_modtager", slags: ingenModtager };
  }

  if (blokke.length === 0) {
    return holdt.length > 0 ? { status: "undertrykt", slags: holdt } : { status: "ingen" };
  }
  const slags = unikke(blokke.map((b) => b.slags));

  const fejl: string[] = [];
  let mindstEn = false;
  try {
    const mail = bygAlarmMail(blokke);
    for (const til of modtagere) {
      const r = await sendHandelMailDetaljer(til, mail);
      if (r.ok) mindstEn = true;
      else fejl.push(renFejltekst(r.fejl, 200));
    }
  } catch (err) {
    // Fx en fejl i opbygningen: blokkene er markeret som sendt og skal
    // rulles tilbage som ved en fejlet afsendelse.
    fejl.push(renFejltekst(err, 200));
  }

  if (!mindstEn) {
    const besked = fejl.join("; ") || "Ukendt fejl";
    console.error("Drift-alarm: mail kunne ikke sendes:", besked);
    // Logges IKKE i drift_fejl (ville selv udløse en ny alarm). Markeringen
    // rulles tilbage, så alarmen prøves igen ved næste kørsel.
    const e2 = await rulTilbage(besked);
    if (e2) {
      const e2tekst = renFejltekst(e2.message, 200);
      console.error("Drift-alarm: tilbagerulning fejlede:", e2tekst);
      // Noteres på /admin/drift (drift_alarm_tilstand), ikke i drift_fejl.
      const { error: e3 } = await admin
        .from("drift_alarm_tilstand")
        .update({
          sidste_resultat: "mail_fejlet",
          sidste_fejl: `Mail: ${besked}; tilbagerulning fejlede: ${e2tekst}`.slice(0, 500),
        })
        .eq("id", true);
      if (e3) console.error("Drift-alarm: kunne heller ikke notere fejlen:", e3.message);
    }
    return { status: "fejl", fejl: besked };
  }
  return { status: "sendt", slags };
}

async function vurderingFejlede(message: string): Promise<AlarmResultat> {
  const fejl = renFejltekst(message);
  console.error("Drift-alarm: vurdering fejlede:", fejl);
  await logDriftFejl({ kilde: "cron", sti: "drift-alarm", hvor: "Drift-alarm", fejl: message });
  return { status: "fejl", fejl };
}
