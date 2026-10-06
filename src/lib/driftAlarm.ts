import "server-only";

// Drift-alarmer: samlet mail til Filip, når noget går galt. Kaldes af
// /api/cron/drift-alarm (pg_cron hvert 5. minut, se migration
// 20261008010000_drift_alarmer.sql). Selve vurderingen og "højst én mail pr.
// slags pr. 30 min" sker atomisk i databasen (drift_alarm_vurder).
//
// Modtager: DRIFT_ALARM_MAIL (en eller flere adresser, kommasepareret). Er den
// ikke sat, sendes intet, og det logges. På testdatabasen sendes aldrig
// rigtige mails (getResend logger dem eller omdirigerer til
// MAIL_TEST_MODTAGER).
//
// Ingen persondata i mailen: kun kilde, sti og fejltekst, som allerede er
// renset af src/lib/drift.ts - og renses igen her.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, renFejltekst, renSti } from "@/lib/drift";
import { bygMail, escapeHtml, sideUrl } from "@/lib/mails/layout";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { getResend } from "@/lib/resend";

export type AlarmSlags = "ny_fejl" | "mange_fejl" | "cron" | "webhook";

export const ALARM_SLAGS: Record<AlarmSlags, string> = {
  ny_fejl: "Ny slags fejl",
  mange_fejl: "Mange fejl på kort tid",
  cron: "Cron fejler",
  webhook: "Webhook-fejl",
};

export const ALARM_INTERVAL_MIN = 30;

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

type Punkt = {
  type?: string;
  kilde?: string;
  sti?: string | null;
  besked?: string | null;
  antal?: number;
  oprettet_kl?: string;
  senest_kl?: string;
  startet_kl?: string;
};

type AlarmData = {
  slags: AlarmSlags;
  antal: number;
  punkter?: Punkt[];
  forrige_daekket_til?: string;
  forrige_sendt_kl?: string | null;
};

type Vurdering = {
  send: AlarmData[];
  undertrykt: AlarmSlags[];
  tidspunkt: string;
};

const KILDE: Record<string, string> = {
  klient: "Browser",
  server: "Server",
  action: "Handling",
  cron: "Cron",
  webhook: "Webhook",
  notifikation: "Notifikation",
};

const tid = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleString("da-DK", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Copenhagen",
      })
    : "";

function punktLinje(p: Punkt): string {
  const hvad = p.type ?? (p.kilde ? (KILDE[p.kilde] ?? p.kilde) : "Fejl");
  const sti = p.sti ? (renSti(p.sti) ?? "") : "";
  const besked = p.besked ? renFejltekst(p.besked, 200) : "";
  const antal = typeof p.antal === "number" && p.antal > 1 ? ` (×${p.antal})` : "";
  const kl = tid(p.senest_kl ?? p.oprettet_kl ?? p.startet_kl);
  return [kl, hvad, sti, besked].filter(Boolean).join(" · ") + antal;
}

export function bygAlarmMail(alarmer: AlarmData[]) {
  const emne = `BidHamr-alarm: ${alarmer.map((a) => ALARM_SLAGS[a.slags]).join(", ")}`;
  const afsnitHtml: string[] = [];
  for (const a of alarmer) {
    const punkter = (a.punkter ?? []).slice(0, 10);
    const linjer = punkter.map((p) => `• ${escapeHtml(punktLinje(p))}`);
    const flere = a.antal > punkter.length ? `<br>… og ${a.antal - punkter.length} mere` : "";
    const overskrift =
      a.slags === "mange_fejl"
        ? `${a.antal} fejl de seneste 15 minutter`
        : `${a.antal} ${a.antal === 1 ? "hændelse" : "hændelser"}`;
    afsnitHtml.push(
      `<strong>${escapeHtml(ALARM_SLAGS[a.slags])}</strong> – ${escapeHtml(overskrift)}` +
        (linjer.length ? `<br>${linjer.join("<br>")}${flere}` : ""),
    );
  }
  const mail = bygMail({
    preheader: emne,
    overskriftHtml: "Der er noget galt på BidHamr",
    afsnitHtml,
    knap: { tekst: "Åbn drift-siden", url: sideUrl("/admin/drift") },
    aarsag: `Du får denne mail, fordi din adresse står i DRIFT_ALARM_MAIL. Højst én mail pr. slags pr. ${ALARM_INTERVAL_MIN} minutter.`,
  });
  return { subject: emne, ...mail };
}

export type AlarmResultat =
  | { status: "ingen" }
  | { status: "undertrykt"; slags: AlarmSlags[] }
  | { status: "ingen_modtager"; slags: AlarmSlags[] }
  | { status: "sendt"; slags: AlarmSlags[] }
  | { status: "fejl"; fejl: string };

export async function koerDriftAlarm(): Promise<AlarmResultat> {
  const admin = createAdminClient();
  const modtagere = alarmModtagere();
  const kanSende = modtagere.length > 0 && getResend() !== null;

  const { data, error } = await admin.rpc("drift_alarm_vurder", { p_kan_sende: kanSende });
  if (error) {
    const fejl = renFejltekst(error.message);
    console.error("Drift-alarm: vurdering fejlede:", fejl);
    await logDriftFejl({ kilde: "cron", sti: "drift-alarm", hvor: "Drift-alarm", fejl: error.message });
    return { status: "fejl", fejl };
  }

  const v = data as Vurdering;
  const send = Array.isArray(v?.send) ? v.send : [];
  if (send.length === 0) {
    return v?.undertrykt?.length ? { status: "undertrykt", slags: v.undertrykt } : { status: "ingen" };
  }
  const slags = send.map((a) => a.slags);

  if (!kanSende) {
    console.warn(
      `Drift-alarm: ${slags.join(", ")} udløst, men ${
        modtagere.length === 0 ? "DRIFT_ALARM_MAIL er ikke sat" : "RESEND_API_KEY mangler"
      } – ingen mail sendt.`,
    );
    return { status: "ingen_modtager", slags };
  }

  const mail = bygAlarmMail(send);
  const fejl: string[] = [];
  let mindstEn = false;
  for (const til of modtagere) {
    const r = await sendHandelMailDetaljer(til, mail);
    if (r.ok) mindstEn = true;
    else fejl.push(renFejltekst(r.fejl, 200));
  }

  if (!mindstEn) {
    const besked = fejl.join("; ") || "Ukendt fejl";
    console.error("Drift-alarm: mail kunne ikke sendes:", besked);
    // Logges IKKE i drift_fejl (ville selv udløse en ny alarm). Markeringen
    // rulles tilbage, så alarmen prøves igen ved næste kørsel.
    const { error: e2 } = await admin.rpc("drift_alarm_mail_fejlet", {
      p_tidspunkt: v.tidspunkt,
      p_alarmer: send.map((a) => ({
        slags: a.slags,
        forrige_daekket_til: a.forrige_daekket_til ?? null,
        forrige_sendt_kl: a.forrige_sendt_kl ?? null,
      })),
      p_fejl: besked,
    });
    if (e2) console.error("Drift-alarm: tilbagerulning fejlede:", e2.message);
    return { status: "fejl", fejl: besked };
  }
  return { status: "sendt", slags };
}
