"use server";

// Server actions til den nye betalingsmodel. Frontend bruger disse - beløb
// sendes ALDRIG fra klienten; de beregnes i databasen og læses herfra.
//
// Alle funktioner returnerer enten { ok: true, ... } eller { fejl: string }.

import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { fjernGemtKortForBruger } from "@/lib/betaling/kort";
import {
  hentBetalingsstatusFor,
  type Betalingsstatus,
  type KoeberBetalingsstatus,
  type SaelgerBetalingsstatus,
} from "@/lib/betaling/betalingsstatus";
import { erOnboardingRetur } from "@/lib/betaling/stripeBetaling";
import {
  bekraeftGemtKortFor,
  hentBetalingsindstillingerFor,
  opdaterSaelgerStatusFor,
  startBetalingFor,
  startGemKortFor,
  startOnboardingFor,
  stripeOversigtFor,
  type Betalingsindstillinger,
} from "@/lib/betaling/betalingHandlinger";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

async function indloggetBruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user;
}

// ------------------------------------------------------------------ status

// Logikken deles med appen (src/lib/betaling/betalingsstatus.ts).
export type { KoeberBetalingsstatus, SaelgerBetalingsstatus, Betalingsstatus };

export async function hentBetalingsstatus(
  handelId: string,
): Promise<({ ok: true } & KoeberBetalingsstatus) | ({ ok: true } & SaelgerBetalingsstatus) | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  return hentBetalingsstatusFor(await createClient(), user.id, handelId);
}

// ------------------------------------------------------------------ betal

// Starter (eller genoptager) betalingen for en vundet auktion og returnerer
// client_secret til Stripes Payment Element. Logikken deles med appen
// (startBetalingFor i src/lib/betaling/betalingHandlinger.ts). Har køberen et
// gemt kort, følger customerSessionClientSecret med (forudfylder kun - kortet
// trækkes først, når køberen trykker Betal).
export async function startBetaling(
  handelId: string,
): Promise<
  | { ok: true; clientSecret: string; totalOere: number; customerSessionClientSecret: string | null }
  | (Fejl & { betalt?: true; kode?: "vaelg_levering" })
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await startBetalingFor(user.id, handelId, "web");
  if ("fejl" in r) {
    if (r.kode === "betalt") return { fejl: r.fejl, betalt: true };
    if (r.kode === "vaelg_levering") return { fejl: r.fejl, kode: "vaelg_levering" };
    return { fejl: r.fejl };
  }
  return {
    ok: true,
    clientSecret: r.clientSecret,
    totalOere: r.totalOere,
    customerSessionClientSecret: r.customerSessionClientSecret,
  };
}

// ------------------------------------------------------------------ gemt kort

export type { Betalingsindstillinger };

export async function hentBetalingsindstillinger(): Promise<
  ({ ok: true } & Betalingsindstillinger) | Fejl
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    return { ok: true, ...(await hentBetalingsindstillingerFor(user.id)) };
  } catch (err) {
    console.error("hentBetalingsindstillinger fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Starter "gem kort": returnerer client_secret til en SetupIntent, som
// frontend bekræfter med Payment Element (stripe.confirmSetup).
export async function startGemKort(): Promise<{ ok: true; clientSecret: string } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await startGemKortFor(user.id, "web");
  if ("fejl" in r) return { fejl: r.fejl };
  return { ok: true, clientSecret: r.clientSecret };
}

// Kaldes, når brugeren vender tilbage fra confirmSetup (setup_intent i URL'en),
// så kortet vises med det samme. Webhooken gør det samme bagefter.
export async function bekraeftGemtKort(
  setupIntentId: string,
): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await bekraeftGemtKortFor(user.id, setupIntentId);
  if ("fejl" in r) {
    if (r.kode === "afvist") revalidatePath("/konto");
    return { fejl: r.fejl };
  }
  revalidatePath("/konto");
  return { ok: true };
}

export async function fjernGemtKort(): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    await fjernGemtKortForBruger(user.id);
    revalidatePath("/konto");
    return { ok: true };
  } catch (err) {
    console.error("fjernGemtKort fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "fjernGemtKort", fejl: err, brugerId: user.id });
    return { fejl: GENERISK };
  }
}

// ------------------------------------------------------------------ sælger

// Opretter (én gang) sælgerens Stripe Connect Express-konto og returnerer et
// onboarding-link. Linket må kun vises for den indloggede bruger (ikke mailes).
export async function startSaelgerOnboarding(
  retur: unknown = "konto",
): Promise<{ ok: true; url: string } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await startOnboardingFor(user.id, erOnboardingRetur(retur) ? retur : "konto", "web");
  return "fejl" in r ? { fejl: r.fejl } : r;
}

// Henter sælgerkontoens status direkte fra Stripe (fx på return_url).
export async function opdaterSaelgerStatus(): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await opdaterSaelgerStatusFor(user.id);
  if ("fejl" in r) return { fejl: r.fejl };
  revalidatePath("/konto");
  revalidatePath("/opret-auktion");
  return { ok: true };
}

// ------------------------------------------------------------------ udbetalinger

// Engangs-link til sælgerens egen oversigt hos Stripe (Express Dashboard:
// udbetalinger til banken, bankkonto, saldo). Linket returneres til
// klienten, som sender brugeren videre med det samme (det må ikke gemmes
// eller mailes).
export async function aabnStripeOversigt(): Promise<{ ok: true; url: string } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await stripeOversigtFor(user.id);
  return "fejl" in r ? { fejl: r.fejl } : r;
}


// ------------------------------------------------------------------ udbetaling (destination)

// Sælgerens udbetaling til banken (betalingsmodel destination, trin 3).
// Samme databasefunktioner som appen (handel_udbetalingsstatus og
// mine_bankudbetalinger, 20261011030000) - kun egne data (auth.uid()).
export type Udbetalingsvisning = {
  status: "venter" | "stoppet" | "kraever_handling" | "paa_vej" | "udbetalt" | "venter_paa_bank";
  // Tidligst, hvornår udbetalingen sendes (venter).
  tidligstKl: string | null;
  sendtKl: string | null;
  beloebOere: number;
  // 20261019010000: 'fortrydelsesfrist' (erhverv, venter) eller 'kontrol'
  // (stoppet hos BidHamr - grunden vises ikke for sælgeren).
  aarsag: "fortrydelsesfrist" | "kontrol" | null;
};

export type Bankudbetaling = {
  id: string;
  oprettetKl: string;
  beloebOere: number;
  status: "paa_vej" | "udbetalt" | "fejlet" | "annulleret";
  antalHandler: number;
};

// null = ikke relevant (gammel model, ikke frigivet, eller ikke din handel).
export async function hentMinUdbetalingsstatus(
  handelId: string,
): Promise<{ ok: true; visning: Udbetalingsvisning | null } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("handel_udbetalingsstatus", { p_trade: handelId });
  if (error) {
    console.error("handel_udbetalingsstatus fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const v = data as {
    status: Udbetalingsvisning["status"];
    tidligst_kl: string | null;
    sendt_kl: string | null;
    beloeb_oere: number;
    aarsag?: string | null;
  } | null;
  const aarsag = v?.aarsag === "fortrydelsesfrist" || v?.aarsag === "kontrol" ? v.aarsag : null;
  return {
    ok: true,
    visning: v
      ? { status: v.status, tidligstKl: v.tidligst_kl, sendtKl: v.sendt_kl, beloebOere: Number(v.beloeb_oere), aarsag }
      : null,
  };
}

export async function hentMineBankudbetalinger(): Promise<
  { ok: true; udbetalinger: Bankudbetaling[] } | Fejl
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mine_bankudbetalinger");
  if (error) {
    // Før migrationen 20261011030000: ingen udbetalinger at vise.
    if (error.code === "PGRST202" || error.code === "42883") return { ok: true, udbetalinger: [] };
    console.error("mine_bankudbetalinger fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const liste = (Array.isArray(data) ? data : []) as {
    id: string;
    kl: string;
    beloeb_oere: number;
    status: Bankudbetaling["status"];
    antal_handler: number;
  }[];
  return {
    ok: true,
    udbetalinger: liste.map((u) => ({
      id: u.id,
      oprettetKl: u.kl,
      beloebOere: Number(u.beloeb_oere),
      status: u.status,
      antalHandler: Number(u.antal_handler),
    })),
  };
}
