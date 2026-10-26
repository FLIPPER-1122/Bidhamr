// Drift-alarmmailen: hændelser samlet i blokke med danske titler, så en
// ikke-teknisk chef kan forstå den på 10 sekunder. Røde blokke ("Skal ses på
// nu") står først, gule ("Hold øje") bagefter.
//
// Ingen server-only-import: ren logik, som enhedstestene og forhåndsvisningen
// bruger. Afsendelsen ligger i src/lib/driftAlarm.ts.
//
// Mailen må ikke kunne styres udefra:
// - Browser-fejl (kilde 'klient') er indsendt af brugere. Databasen sender
//   aldrig deres tekst eller sti med, og mailen viser kun antal.
// - Fejltekster og koder vises kun i lille grå tekst, og links i dem
//   neutraliseres (renLinks).
// - Alt escapes.
import { bygMail, escapeHtml } from "@/lib/mails/layout";
import { adminAbsolutUrl } from "@/lib/adminVaert";
import { ALARM_TYPER, alarmKode, alarmType, idIEksempel, type AlarmType } from "@/lib/driftAlarmTyper";

// Gentagelser af samme fejl: gule blokke højst én gang pr. time (medmindre
// antallet er steget markant), røde højst hvert 15. minut. En ny fejltekst
// eller en fejl, der kommer igen efter en pause, sendes med det samme.
// Håndhæves i databasen (drift_alarm_vurder_blokke).
export const GENSEND_MIN = 60;
export const GENSEND_ROED_MIN = 15;

export type AlarmEksempel = {
  kilde?: string | null;
  sti?: string | null;
  besked?: string | null;
  antal?: number | null;
};

export type AlarmBlok = {
  noegle: string;
  slags: string;
  kilde: string;
  kode: string;
  antal: number;
  fra: string | null;
  til: string | null;
  eksempler: AlarmEksempel[];
  // Sendt inden for timen, men antallet er steget markant.
  gentaget?: boolean;
  forrige_antal?: number | null;
  forrige_sendt_kl?: string | null;
};

// ------------------------------------------------------------ links

const EGET_DOMAENE = /^(?:[a-z0-9-]+\.)*bidhamr\.dk$/i;

// Domæner uden http(s):// foran (fx "evil.com/login"): ethvert topdomæne på
// 2-24 bogstaver. Undtaget er endelser, der ikke er topdomæner, men som står
// i fejltekster: filnavne ("drift.ts") og Stripe-hændelser
// ("charge.dispute.created").
const IKKE_TLD = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "sql", "css", "map", "txt", "log", "yml", "yaml",
  "created", "updated", "deleted", "succeeded", "failed", "paid", "canceled", "cancelled", "refunded",
  "closed", "completed", "expired", "processing", "reversed", "attached", "detached", "pending",
  "available", "reinstated", "finalized", "voided", "dispute", "session", "subscription", "invoice",
  "schedule", "payment", "refund", "payout", "charge", "account", "customer", "person", "capability",
]);
const URL_MED_SKEMA = /\b(https?):\/\/([^\s/?#:]+)(?::\d+)?(\S*)/gi;
const BART_DOMAENE =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))\b((?::\d+)?[/?#]\S*)?/gi;

// Sti uden query og hash (kan indeholde tokens).
const udenQuery = (rest: string) => rest.split(/[?#]/)[0];

// Neutraliserer links i en fejltekst, så den ikke kan bruges til phishing i
// alarm-mailen: bidhamr.dk-links bliver til "hxxps://bidhamr.dk/sti" (ikke
// klikbare, uden query), alle andre domæner fjernes helt.
export function renLinks(tekst: string): { tekst: string; renset: boolean } {
  let renset = false;
  let t = tekst.replace(URL_MED_SKEMA, (_m, skema: string, vaert: string, rest: string) => {
    renset = true;
    if (EGET_DOMAENE.test(vaert)) {
      return `${skema.toLowerCase().replace("http", "hxxp")}://${vaert.toLowerCase()}${udenQuery(rest)}`;
    }
    return "[link fjernet]";
  });
  t = t.replace(BART_DOMAENE, (m: string, vaert: string, tld: string, rest: string | undefined) => {
    if (IKKE_TLD.has(tld.toLowerCase())) return m;
    if (EGET_DOMAENE.test(vaert)) {
      if (!rest || !/[?#]/.test(rest)) return m;
      renset = true;
      return `${vaert}${udenQuery(rest)}`;
    }
    renset = true;
    return "[domæne fjernet]";
  });
  return { tekst: t, renset };
}

const ren = (t: string, maks = 160) => {
  const r = renLinks(t.replace(/\s+/g, " ").trim().slice(0, maks));
  return r.renset ? `${r.tekst} [renset]` : r.tekst;
};

// ------------------------------------------------------------ tid

const TZ = "Europe/Copenhagen";

const dagNoegle = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: TZ });
const klokke = (d: Date) => d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dato = (d: Date) => d.toLocaleDateString("da-DK", { day: "numeric", month: "short", timeZone: TZ });

function gyldig(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "14.20" i dag, ellers "12. okt. kl. 14.20".
function tidspunkt(d: Date, nu: Date, medKl: boolean): string {
  if (dagNoegle(d) === dagNoegle(nu)) return `${medKl ? "kl. " : ""}${klokke(d)}`;
  return `${dato(d)} kl. ${klokke(d)}`;
}

export function varighed(fra: Date, nu: Date): string {
  const min = Math.max(0, Math.floor((nu.getTime() - fra.getTime()) / 60_000));
  if (min < 60) return `${min} ${min === 1 ? "minut" : "minutter"}`;
  const timer = Math.floor(min / 60);
  if (timer < 48) return `${timer} ${timer === 1 ? "time" : "timer"}`;
  const dage = Math.floor(timer / 24);
  return `${dage} dage`;
}

// "12 gange mellem 14.20 og 14.21" / "1 gang kl. 14.20".
export function tidsrum(b: Pick<AlarmBlok, "kode" | "antal" | "fra" | "til">, nu: Date): string {
  const fra = gyldig(b.fra);
  const til = gyldig(b.til) ?? fra;
  if (b.kode === "mange-fejl") return `${b.antal} fejl de seneste 15 minutter`;
  if (b.kode === "cron/holdt-op") {
    return fra
      ? `Sidste vellykkede kørsel ${tidspunkt(fra, nu, true)} – for ${varighed(fra, nu)} siden`
      : "Ingen vellykket kørsel i over 20 minutter";
  }
  const gange = `${b.antal} ${b.antal === 1 ? "gang" : "gange"}`;
  if (!fra || !til) return gange;
  const sammeMinut = klokke(fra) === klokke(til) && dagNoegle(fra) === dagNoegle(til);
  if (b.antal === 1 || sammeMinut) return `${gange} ${tidspunkt(til, nu, true)}`;
  return `${gange} mellem ${tidspunkt(fra, nu, false)} og ${tidspunkt(til, nu, false)}`;
}

// ------------------------------------------------------------ blokke

export type VistBlok = AlarmBlok & { type: AlarmType; kendt: boolean };

// Røde først, så flest hændelser, så nyeste.
export function sorterBlokke(blokke: AlarmBlok[]): VistBlok[] {
  return blokke
    .map((b) => ({ ...b, type: alarmType(b.kilde, b.kode), kendt: b.kode in ALARM_TYPER }))
    .sort((a, b) => {
      if (a.type.alvor !== b.type.alvor) return a.type.alvor === "roed" ? -1 : 1;
      if (a.antal !== b.antal) return b.antal - a.antal;
      return (b.til ?? "").localeCompare(a.til ?? "");
    });
}

// Id'er til den grå linje (højst 3). Cron-blokke viser jobnavnet.
export function eksempelIder(b: AlarmBlok): string[] {
  const ud: string[] = [];
  for (const e of b.eksempler ?? []) {
    const id = b.kode.startsWith("cron/") ? (e.sti ?? null) : idIEksempel(e.besked);
    if (id) {
      const r = ren(id, 80);
      if (!ud.includes(r)) ud.push(r);
    }
    if (ud.length >= 3) break;
  }
  return ud;
}

// "Mange fejl": de hyppigste typer med danske titler.
function hyppigst(b: AlarmBlok): string | null {
  const sum = new Map<string, number>();
  for (const e of b.eksempler ?? []) {
    const kilde = e.kilde ?? "server";
    const titel = alarmType(kilde, alarmKode(kilde, e.besked)).titel;
    sum.set(titel, (sum.get(titel) ?? 0) + (typeof e.antal === "number" && e.antal > 0 ? e.antal : 1));
  }
  const top = [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length ? `Hyppigst: ${top.map(([t, n]) => `${t} (${n})`).join(", ")}.` : null;
}

// Seneste fejltekst - kun for typer uden egen forklaring, og aldrig fra browseren.
function senesteTekst(b: VistBlok): string | null {
  if (b.kendt || b.kilde === "klient" || b.kode === "mange-fejl") return null;
  const t = (b.eksempler ?? []).find((e) => e.besked)?.besked;
  return t ? ren(t) : null;
}

function tekniskLinje(b: AlarmBlok): string {
  const dele = [b.kilde === "*" ? null : b.kilde, ren(b.kode, 80)].filter(Boolean);
  return dele.join(" · ");
}

function emneFor(b: VistBlok, nu: Date): string {
  if (b.kode === "cron/holdt-op") {
    const fra = gyldig(b.fra);
    if (fra) return `Betalings-cron har ikke kørt i ${varighed(fra, nu)}`;
  }
  return b.type.emne(b.antal);
}

export function statusLinje(roede: number, gule: number): string {
  if (roede > 0 && gule > 0) {
    return `Der er ${roede} ting, du skal se på nu, og ${gule} ting, der kun er til orientering.`;
  }
  if (roede > 0) return `Der er ${roede} ting, du skal se på nu.`;
  return `Der er ikke noget, der haster. ${gule} ting er til orientering.`;
}

// ------------------------------------------------------------ html

const SANS =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const FARVE = {
  roed: { bg: "#FDECEC", kant: "#F3C4C4", tekst: "#A32020" },
  gul: { bg: "#FEF3E2", kant: "#F5D9B0", tekst: "#8A4210" },
  tekst: "#1A1A1A",
  svag: "#666666",
  groen: "#1E5E4A",
} as const;

function lilleKnap(tekst: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 0;">
                <tr>
                  <td bgcolor="${FARVE.groen}" style="background-color:${FARVE.groen};border-radius:0;">
                    <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:10px 16px;font-family:${SANS};font-size:14px;font-weight:600;line-height:18px;color:#ffffff;text-decoration:none;border-radius:0;">${escapeHtml(tekst)}</a>
                  </td>
                </tr>
              </table>`;
}

function blokHtml(b: VistBlok, nu: Date): string {
  const f = FARVE[b.type.alvor];
  const meta = tidsrum(b, nu) + (b.gentaget ? " · sendt igen, fordi antallet er steget" : "");
  const ekstra = b.kode === "mange-fejl" ? hyppigst(b) : null;
  const ider = eksempelIder(b);
  const seneste = senesteTekst(b);
  const graa = [
    ider.length ? `Eksempler: ${ider.join(", ")}` : null,
    seneste ? `Seneste fejltekst: ${seneste}` : null,
    `Teknisk: ${tekniskLinje(b)}`,
  ].filter((t): t is string => !!t);
  const p = (indhold: string, stil = "") =>
    `<p class="bh-blok-tekst" style="margin:0 0 6px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${FARVE.tekst};${stil}">${indhold}</p>`;
  // table-layout:fixed + break-all: lange id'er må ikke gøre mailen bredere end mobilen.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;table-layout:fixed;">
            <tr>
              <td class="bh-blok-${b.type.alvor}" style="background-color:${f.bg};border:1px solid ${f.kant};border-left:4px solid ${f.tekst};border-radius:0;padding:16px 18px;">
              <p class="bh-blok-titel" style="margin:0 0 2px 0;font-family:${SANS};font-size:17px;font-weight:700;line-height:1.35;color:${FARVE.tekst};">${escapeHtml(b.type.titel)}</p>
              <p class="bh-blok-meta-${b.type.alvor}" style="margin:0 0 10px 0;font-family:${SANS};font-size:14px;font-weight:600;line-height:1.4;color:${f.tekst};">${escapeHtml(meta)}</p>
              ${p(`<strong>Det betyder:</strong> ${escapeHtml(b.type.betyder)}`)}
              ${ekstra ? p(escapeHtml(ekstra)) : ""}
              ${p(`<strong>Det skal du gøre:</strong> ${escapeHtml(b.type.goer)}`, "margin:0;")}
              ${lilleKnap(b.type.side.tekst, adminAbsolutUrl(b.type.side.sti))}
              <p class="bh-graa" style="margin:12px 0 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${FARVE.svag};word-break:break-all;overflow-wrap:anywhere;">${graa.map(escapeHtml).join("<br>")}</p>
              </td>
            </tr>
          </table>`;
}

function sektionHtml(alvor: "roed" | "gul", tekst: string): string {
  return `<p class="bh-sektion-${alvor}" style="margin:24px 0 10px 0;font-family:${SANS};font-size:13px;font-weight:700;line-height:1.4;letter-spacing:0.6px;text-transform:uppercase;color:${FARVE[alvor].tekst};">${escapeHtml(tekst)}</p>`;
}

function blokTekst(b: VistBlok, nu: Date): string {
  const ider = eksempelIder(b);
  const seneste = senesteTekst(b);
  const ekstra = b.kode === "mange-fejl" ? hyppigst(b) : null;
  return [
    b.type.titel,
    tidsrum(b, nu) + (b.gentaget ? " (sendt igen, fordi antallet er steget)" : ""),
    `Det betyder: ${b.type.betyder}`,
    ekstra,
    `Det skal du gøre: ${b.type.goer}`,
    `${b.type.side.tekst}: ${adminAbsolutUrl(b.type.side.sti)}`,
    ider.length ? `Eksempler: ${ider.join(", ")}` : null,
    seneste ? `Seneste fejltekst: ${seneste}` : null,
    `Teknisk: ${tekniskLinje(b)}`,
  ]
    .filter((t): t is string => !!t)
    .join("\n");
}

const SEKTION = { roed: "Skal ses på nu", gul: "Hold øje" } as const;

export function bygAlarmMail(blokke: AlarmBlok[], nu: Date = new Date()) {
  const vist = sorterBlokke(blokke);
  const roede = vist.filter((b) => b.type.alvor === "roed");
  const gule = vist.filter((b) => b.type.alvor === "gul");
  const status = statusLinje(roede.length, gule.length);

  const hoved = vist[0];
  const resten = vist.length - 1;
  const emne =
    `BidHamr: ${hoved ? emneFor(hoved, nu) : "Drift-alarm"}` +
    (resten > 0 ? ` (og ${resten} ${resten === 1 ? "anden ting" : "andre ting"})` : "");

  const html: string[] = [];
  const tekst: string[] = [];
  for (const [alvor, liste] of [["roed", roede], ["gul", gule]] as const) {
    if (liste.length === 0) continue;
    html.push(sektionHtml(alvor, SEKTION[alvor]));
    tekst.push(`${SEKTION[alvor].toUpperCase()}\n`);
    for (const b of liste) {
      html.push(blokHtml(b, nu));
      tekst.push(`${blokTekst(b, nu)}\n`);
    }
  }

  const mail = bygMail({
    preheader: status,
    overskriftHtml: roede.length > 0 ? "Der er noget, du skal se på" : "Til orientering",
    afsnitHtml: [escapeHtml(status)],
    blokkeHtml: html.join("\n          "),
    blokkeTekst: tekst.join("\n"),
    knap: { tekst: "Åbn drift-siden", url: adminAbsolutUrl("/admin/drift") },
    aarsag: `Du får denne mail, fordi din adresse står i DRIFT_ALARM_MAIL. Nye fejl sendes med det samme. Gentagelser af samme fejl samles: røde højst hvert ${GENSEND_ROED_MIN}. minut, gule højst én gang i timen. Fejl fra brugernes browser vises kun på drift-siden, og links i fejltekster er fjernet.`,
  });
  return { subject: emne, ...mail };
}

// ------------------------------------------------------------ gammelt format

// Hvis migrationen 20261021030000 ikke er kørt, svarer databasen i det gamle
// format (drift_alarm_vurder: punkter pr. slags). De samles her til blokke.
export type GammeltPunkt = {
  type?: string;
  kilde?: string;
  sti?: string | null;
  besked?: string | null;
  antal?: number;
  oprettet_kl?: string;
  senest_kl?: string;
  startet_kl?: string;
};

export type GammelAlarm = { slags: string; antal: number; punkter?: GammeltPunkt[] };

const GAMMEL_TYPE: Record<string, string> = {
  "Cron-kørsel fejlede": "cron/koersel-fejlede",
  "Cron-kørsel blev ikke færdig": "cron/koersel-haenger",
  "Cron er holdt op": "cron/holdt-op",
  "pg_cron-job fejlede": "cron/pg-cron-job",
  "Kald til cron-rute fejlede": "cron/http-kald",
};

export function grupperGamleAlarmer(alarmer: GammelAlarm[]): AlarmBlok[] {
  const ud: AlarmBlok[] = [];
  for (const a of alarmer) {
    const punkter = Array.isArray(a.punkter) ? a.punkter : [];
    if (a.slags === "mange_fejl") {
      ud.push({
        noegle: "*|mange-fejl",
        slags: a.slags,
        kilde: "*",
        kode: "mange-fejl",
        antal: a.antal,
        fra: null,
        til: null,
        eksempler: punkter.map((p) => ({ kilde: p.kilde, sti: p.sti, besked: p.besked, antal: p.antal })),
      });
      continue;
    }
    const grupper = new Map<string, AlarmBlok>();
    for (const p of punkter) {
      const kilde = p.kilde ?? (p.type ? "cron" : "server");
      const kode = (p.type && GAMMEL_TYPE[p.type]) || alarmKode(kilde, p.besked);
      const noegle = `${kilde}|${kode}`;
      const tid = p.senest_kl ?? p.oprettet_kl ?? p.startet_kl ?? null;
      let g = grupper.get(noegle);
      if (!g) {
        g = { noegle, slags: a.slags, kilde, kode, antal: 0, fra: tid, til: tid, eksempler: [] };
        grupper.set(noegle, g);
      }
      g.antal += 1;
      if (tid && (!g.fra || tid < g.fra)) g.fra = tid;
      if (tid && (!g.til || tid > g.til)) g.til = tid;
      if (g.eksempler.length < 3) {
        g.eksempler.push(kilde === "klient" ? {} : { sti: p.sti ?? null, besked: p.besked ?? null });
      }
    }
    // Databasen sendte højst 10 punkter. Er der kun én gruppe, er det samlede
    // antal dens.
    if (grupper.size === 1) for (const g of grupper.values()) g.antal = Math.max(g.antal, a.antal);
    ud.push(...grupper.values());
  }
  return ud;
}
