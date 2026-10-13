import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { CRON_ADVARSEL_MIN, hentAlarmStatus, hentCronRute } from "@/lib/driftData";
import { alarmModtagere } from "@/lib/driftAlarm";
import { erTestdatabase } from "@/lib/miljoe";
import { databasensStripeTilstand, noeglensTilstand } from "@/lib/stripe";
import { stripeTilstandLampe } from "@/lib/admin/stripeLampe";
import type { NoedstopTal } from "@/lib/admin/taellere";
import { hentEksternVagt } from "@/lib/admin/healthchecks";

// Systemlamper på forsiden (docs/ADMIN-REDESIGN.md 3.2), kun admin og chef.
// Trin 1-2: KUN de lamper, der kan beregnes ud fra data, vi har i dag
// (drift-data, miljøet, sikkerhedsnet A's nødstop og sikkerhedsnet B's
// daglige afstemning). Fakturering og MitID kommer senere - de vises slet ikke
// indtil da, så der aldrig står en grøn lampe, vi ikke kan stå inde for.
// Ingen nøgler, URL'er eller adresser sendes til siden - kun tone og tekst.

type Admin = ReturnType<typeof createAdminClient>;

export type LampeTone = "groen" | "gul" | "roed" | "blaa" | "graa";
// statusTekst: hvad statuslinjen skal sige, når lampen er gul eller rød.
export type Lampe = { navn: string; tone: LampeTone; tekst: string; href?: string; statusTekst?: string };

const MIN = 60_000;

// Daglig afstemning bliver RØD (docs/ADMIN-REDESIGN.md 3.2), når mindst én
// åben afvigelse er af en kritisk type (penge, vi ikke kan forklare), eller
// når der er flere end AFVIGELSER_ROED_OVER åbne. Ellers gul ved afvigelser.
export const AFVIGELSE_KRITISKE_TYPER = ["refusion_beloeb", "ukendt_betaling", "udbetaling_ukendt"] as const;
export const AFVIGELSER_ROED_OVER = 20;

// Et opslag fejlede: lampen er gul ("Kunne ikke hentes") - aldrig grøn og
// aldrig udeladt - så statuslinjen ikke kan sige "Alt kører".
export const IKKE_HENTET = "Kunne ikke hentes";
function ikkeHentet(navn: string, href = "/admin/drift"): Lampe {
  return { navn, tone: "gul", tekst: IKKE_HENTET, statusTekst: `${navn}: status kunne ikke hentes`, href };
}

function siden(iso: string, nu: number): string {
  const min = Math.max(0, Math.round((nu - new Date(iso).getTime()) / MIN));
  if (min < 1) return "lige nu";
  if (min < 60) return `${min} min. siden`;
  const t = Math.floor(min / 60);
  if (t < 48) return `${t} t. siden`;
  return `${Math.floor(t / 24)} dage siden`;
}

// Drift-lamperne ændrer sig langsomt; de caches 30 s i processen, så menuen
// (som også bruger dem) ikke spørger databasen ved hvert klik. Nødstoppet
// lægges på frisk hver gang.
const CACHE_MS = 30_000;
let cache: { kl: number; v: Lampe[] } | null = null;

export async function hentLamper(admin: Admin, opts: { noedstop: NoedstopTal }): Promise<Lampe[]> {
  if (!cache || Date.now() - cache.kl > CACHE_MS) {
    try {
      cache = { kl: Date.now(), v: await byg(admin) };
    } catch (err) {
      console.error("Systemlamperne kunne ikke hentes:", err instanceof Error ? err.message : err);
      // Caches ikke - næste visning prøver igen.
      return [ikkeHentet("Systemer")];
    }
  }
  const noedstop: Lampe = opts.noedstop.stoppet
    ? { navn: "Nødstop", tone: "roed", tekst: `TIL · ${opts.noedstop.stoppet}` }
    : { navn: "Nødstop", tone: "groen", tekst: "fra" };
  // Nødstop som tredje lampe (efter cron og webhooks), som i showcasen.
  const v = [...cache.v];
  v.splice(Math.min(2, v.length), 0, noedstop);
  return v;
}

async function byg(admin: Admin): Promise<Lampe[]> {
  const nu = Date.now();
  const test = erTestdatabase();
  const fra24 = new Date(nu - 24 * 60 * MIN).toISOString();

  const [rute, alarm, webhook, fragt, vagt, afstemning, afvigelser, kritiske, stripeDb] = await Promise.all([
    hentCronRute(admin, nu),
    hentAlarmStatus(admin),
    admin
      .from("drift_fejl")
      .select("id", { count: "exact", head: true })
      .eq("kilde", "webhook")
      .gte("senest_kl", fra24),
    // Samme tal som "Fragt kræver handling" (forsendelser.kraever_opmaerksomhed).
    admin.from("forsendelser").select("id", { count: "exact", head: true }).eq("kraever_opmaerksomhed", true),
    hentEksternVagt(),
    // Daglig afstemning (sikkerhedsnet B): seneste kørsel og åbne afvigelser.
    // Kun status og antal - ingen beløb (lampen ses også af admin).
    admin
      .from("penge_afstemning_koersler")
      .select("startet_kl, afsluttet_kl, ok, ufuldstaendig, antal_afvigelser")
      .order("startet_kl", { ascending: false })
      .limit(1)
      .maybeSingle<{ startet_kl: string; afsluttet_kl: string | null; ok: boolean | null; ufuldstaendig: boolean; antal_afvigelser: number }>(),
    admin.from("penge_afstemning_afvigelser").select("id", { count: "exact", head: true }).is("loest_kl", null),
    admin
      .from("penge_afstemning_afvigelser")
      .select("id", { count: "exact", head: true })
      .is("loest_kl", null)
      .in("type", [...AFVIGELSE_KRITISKE_TYPER]),
    // Databasens stripe_tilstand (samme opslag og cache som Stripe-vagten;
    // null, hvis den ikke kan læses).
    databasensStripeTilstand(),
  ]);
  const fragtTilHandling = fragt.count ?? 0;

  const lamper: Lampe[] = [];

  // Betalings-cron
  if (rute.tilstand !== "ok") {
    lamper.push(ikkeHentet("Betalings-cron"));
  } else {
    const ok = rute.data.sidsteOk;
    if (!ok && test && rute.data.seneste.length === 0) {
      // Testdatabasen kalder bevidst ikke cron-ruten (som Drift-siden).
      lamper.push({ navn: "Betalings-cron", tone: "graa", tekst: "kaldes ikke på testdatabasen", href: "/admin/drift" });
    } else if (!ok) {
      lamper.push({ navn: "Betalings-cron", tone: "roed", tekst: "har aldrig kørt", href: "/admin/drift" });
    } else {
      const min = (nu - new Date(ok).getTime()) / MIN;
      const sidsteFejlede = rute.data.seneste[0]?.ok === false;
      const raaTone: LampeTone =
        min > CRON_ADVARSEL_MIN * 2 || sidsteFejlede ? "roed" : min > CRON_ADVARSEL_MIN ? "gul" : "groen";
      // Testdatabasen kalder kun cron-ruten, når nogen tester den - så er en
      // gammel kørsel ikke en fejl (som Drift-siden).
      const tone: LampeTone = test && raaTone !== "groen" ? "graa" : raaTone;
      lamper.push({
        navn: "Betalings-cron",
        tone,
        tekst: sidsteFejlede ? `sidste kørsel fejlede · ok ${siden(ok, nu)}` : `ok · ${siden(ok, nu)}`,
        statusTekst: sidsteFejlede ? "Betalings-cron: sidste kørsel fejlede" : `Betalings-cron har ikke kørt i ${siden(ok, nu).replace(" siden", "")}`,
        href: "/admin/drift",
      });
    }
  }

  // Stripe-webhooks: fejl logget fra webhooken de sidste 24 timer.
  if (webhook.error) {
    lamper.push(ikkeHentet("Stripe-webhooks"));
  } else {
    const antal = webhook.count ?? 0;
    lamper.push({
      navn: "Stripe-webhooks",
      tone: antal > 0 ? "gul" : "groen",
      tekst: antal > 0 ? `${antal} ${antal === 1 ? "fejl" : "fejl"} i 24 t` : "ingen fejl i 24 t",
      href: "/admin/drift",
    });
  }

  // Test eller live: nøglens tilstand mod databasens stripe_tilstand - samme
  // regel som Stripe-vagten (kraevSammeStripeTilstand). Produktionen kører
  // bevidst med testnøgle og stripe_tilstand 'test' indtil fase 6.
  const stripeLampe = stripeTilstandLampe(noeglensTilstand(), stripeDb, test);
  if (stripeLampe) lamper.push(stripeLampe);

  // Fragt: forsendelser, der kræver handling (samme tal som "Kræver handling").
  if (fragt.error) lamper.push(ikkeHentet("Fragt", "/admin/handler?vis=fragt"));
  else lamper.push({
    navn: "Fragt",
    tone: fragtTilHandling > 0 ? "gul" : "groen",
    tekst:
      fragtTilHandling > 0
        ? `${fragtTilHandling} ${fragtTilHandling === 1 ? "forsendelse kræver" : "forsendelser kræver"} handling`
        : "ingen forsendelser venter",
    href: "/admin/handler?vis=fragt",
  });

  // Alarmer: er der en modtager, og kører alarmtjekket?
  if (alarm.tilstand !== "ok") {
    lamper.push(ikkeHentet("Alarmer"));
  } else {
    const modtager = alarmModtagere().length > 0;
    const tjek = alarm.data.sidstTjekket;
    if (!modtager) {
      lamper.push({ navn: "Alarmer", tone: test ? "graa" : "roed", tekst: "ingen modtager sat", href: "/admin/drift" });
    } else if (!tjek) {
      lamper.push({ navn: "Alarmer", tone: test ? "graa" : "gul", tekst: "aldrig tjekket", href: "/admin/drift" });
    } else {
      const gammel = nu - new Date(tjek).getTime() > 15 * MIN;
      lamper.push({
        navn: "Alarmer",
        tone: gammel ? (test ? "graa" : "gul") : "groen",
        tekst: `tjekket ${siden(tjek, nu)}`,
        href: "/admin/drift",
      });
    }
  }

  // Daglig afstemning. Mangler tabellerne (migrationen er ikke kørt), vises
  // lampen ikke; andre fejl giver en gul lampe.
  const mangler = (e: { code?: string } | null) => !!e && ["42P01", "PGRST205", "42703", "PGRST204"].includes(e.code ?? "");
  if (afstemning.error || afvigelser.error) {
    if (!mangler(afstemning.error) && !mangler(afvigelser.error)) lamper.push(ikkeHentet("Daglig afstemning"));
  } else {
    const k = afstemning.data;
    const aabne = afvigelser.count ?? 0;
    const hvorLaenge = k ? (nu - new Date(k.startet_kl).getTime()) / MIN : Infinity;
    const lampe: Lampe = !k
      ? { navn: "Daglig afstemning", tone: test ? "graa" : "roed", tekst: "har aldrig kørt", statusTekst: "Den daglige afstemning har aldrig kørt" }
      : k.ok === false
        ? { navn: "Daglig afstemning", tone: "roed", tekst: `fejlede ${siden(k.startet_kl, nu)}`, statusTekst: "Den daglige afstemning fejlede" }
        : k.ok === null && !k.afsluttet_kl
          ? { navn: "Daglig afstemning", tone: "graa", tekst: `kører · startet ${siden(k.startet_kl, nu)}` }
          : aabne > 0
            ? {
                navn: "Daglig afstemning",
                tone: (kritiske.count ?? 0) > 0 || aabne > AFVIGELSER_ROED_OVER ? "roed" : "gul",
                tekst: `${aabne} ${aabne === 1 ? "åben afvigelse" : "åbne afvigelser"}`,
                statusTekst: `Afstemningen har ${aabne} ${aabne === 1 ? "åben afvigelse" : "åbne afvigelser"}`,
              }
            : k.ufuldstaendig
              ? { navn: "Daglig afstemning", tone: "gul", tekst: `ufuldstændig · ${siden(k.startet_kl, nu)}`, statusTekst: "Den daglige afstemning blev ufuldstændig" }
              : hvorLaenge > 26 * 60
                ? { navn: "Daglig afstemning", tone: test ? "graa" : "gul", tekst: `ikke kørt i ${siden(k.startet_kl, nu).replace(" siden", "")}`, statusTekst: "Den daglige afstemning har ikke kørt i over 26 timer" }
                : { navn: "Daglig afstemning", tone: "groen", tekst: `stemmer · kørt ${siden(k.startet_kl, nu)}` };
    // Kun chefen kan åbne Penge; admin ser lampen uden link.
    lamper.push(lampe);
  }

  // Ekstern vagt (Healthchecks.io).
  for (const x of vagt) lamper.push({ navn: x.navn, tone: x.tone, tekst: x.tekst, href: "/admin/drift" });

  return lamper;
}
