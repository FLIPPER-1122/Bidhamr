import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { CRON_ADVARSEL_MIN, hentAlarmStatus, hentCronRute } from "@/lib/driftData";
import { alarmModtagere } from "@/lib/driftAlarm";
import { erTestdatabase } from "@/lib/miljoe";
import { noeglensTilstand } from "@/lib/stripe";
import type { NoedstopTal } from "@/lib/admin/taellere";

// Systemlamper på forsiden (docs/ADMIN-REDESIGN.md 3.2), kun admin og chef.
// Trin 1-2: KUN de lamper, der kan beregnes ud fra data, vi har i dag
// (drift-data, miljøet og sikkerhedsnet A's nødstop). Daglig afstemning
// (sikkerhedsnet B), fakturering og MitID kommer i trin 3 - de vises slet ikke
// indtil da, så der aldrig står en grøn lampe, vi ikke kan stå inde for.
// Ingen nøgler, URL'er eller adresser sendes til siden - kun tone og tekst.

type Admin = ReturnType<typeof createAdminClient>;

export type LampeTone = "groen" | "gul" | "roed" | "blaa" | "graa";
// statusTekst: hvad statuslinjen skal sige, når lampen er gul eller rød.
export type Lampe = { navn: string; tone: LampeTone; tekst: string; href?: string; statusTekst?: string };

const MIN = 60_000;

function siden(iso: string, nu: number): string {
  const min = Math.max(0, Math.round((nu - new Date(iso).getTime()) / MIN));
  if (min < 1) return "lige nu";
  if (min < 60) return `${min} min. siden`;
  const t = Math.floor(min / 60);
  if (t < 48) return `${t} t. siden`;
  return `${Math.floor(t / 24)} dage siden`;
}

export async function hentLamper(admin: Admin, opts: { fragtTilHandling: number; noedstop: NoedstopTal }): Promise<Lampe[]> {
  const nu = Date.now();
  const test = erTestdatabase();
  const fra24 = new Date(nu - 24 * 60 * MIN).toISOString();

  const [rute, alarm, webhook] = await Promise.all([
    hentCronRute(admin, nu),
    hentAlarmStatus(admin),
    admin
      .from("drift_fejl")
      .select("id", { count: "exact", head: true })
      .eq("kilde", "webhook")
      .gte("senest_kl", fra24),
  ]);

  const lamper: Lampe[] = [];

  // Betalings-cron
  if (rute.tilstand === "ok") {
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
  if (!webhook.error) {
    const antal = webhook.count ?? 0;
    lamper.push({
      navn: "Stripe-webhooks",
      tone: antal > 0 ? "gul" : "groen",
      tekst: antal > 0 ? `${antal} ${antal === 1 ? "fejl" : "fejl"} i 24 t` : "ingen fejl i 24 t",
      href: "/admin/drift",
    });
  }

  // Nødstop (sikkerhedsnet A, hentNoedstop). Rød lampe = noget er stoppet.
  // Statuslinjen viser nødstoppet for sig selv (lampen springes over dér).
  lamper.push(
    opts.noedstop.stoppet
      ? { navn: "Nødstop", tone: "roed", tekst: `TIL · ${opts.noedstop.stoppet}` }
      : { navn: "Nødstop", tone: "groen", tekst: "fra" },
  );

  // Test eller live: Stripe-nøglen og databasen skal passe sammen.
  const noegle = noeglensTilstand();
  if (noegle) {
    if (noegle === "test" && test) {
      lamper.push({ navn: "Testmiljø", tone: "blaa", tekst: "testnøgle + testdatabase" });
    } else if (noegle === "live" && !test) {
      lamper.push({ navn: "Live", tone: "groen", tekst: "live-nøgle + produktionsdatabase" });
    } else {
      lamper.push({ navn: "Test eller live", tone: "roed", tekst: "Stripe-nøglen passer ikke til databasen" });
    }
  }

  // Fragt: forsendelser, der kræver handling (samme tal som "Kræver handling").
  lamper.push({
    navn: "Fragt",
    tone: opts.fragtTilHandling > 0 ? "gul" : "groen",
    tekst:
      opts.fragtTilHandling > 0
        ? `${opts.fragtTilHandling} ${opts.fragtTilHandling === 1 ? "forsendelse kræver" : "forsendelser kræver"} handling`
        : "ingen forsendelser venter",
    href: "/admin/handler?vis=fragt",
  });

  // Alarmer: er der en modtager, og kører alarmtjekket?
  if (alarm.tilstand === "ok") {
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

  return lamper;
}
