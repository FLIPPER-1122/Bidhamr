"use server";

// Server actions til den nye betalingsmodel. Frontend bruger disse - beløb
// sendes ALDRIG fra klienten; de beregnes i databasen og læses herfra.
//
// Alle funktioner returnerer enten { ok: true, ... } eller { fejl: string }.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { beskyttelseOere } from "@/lib/betaling/beregn";
import {
  BetalingsFejl,
  hentBetalingForHandel,
  hentProfil,
  erOnboardingRetur,
  onboardingLink,
  registrerGemtKort,
  sikrPaymentIntent,
  sikrStripeKunde,
  spejlConnectKonto,
  spejlPaymentIntent,
  stripeOversigtLink,
  hentOverfoersler,
  type Overfoersel,
} from "@/lib/betaling/stripeBetaling";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

async function indloggetBruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

// ------------------------------------------------------------------ status

export type Betalingsstatus = {
  handelId: string;
  erKoeber: boolean;
  status: "afventer" | "behandles" | "betalt" | "annulleret" | "refunderet";
  betalSenest: string;
  fristOverskredet: boolean;
  budOere: number;
  koebergebyrOere: number;
  fragtOere: number;
  beskyttelse: boolean;
  beskyttelseOere: number;
  // Hvad BidHamr Beskyttelse koster på denne handel, hvis den tilvælges.
  beskyttelsePrisOere: number;
  totalOere: number;
  // Kun for sælgeren: det, der overføres ved frigivelse.
  saelgergebyrOere: number | null;
  udbetalingOere: number | null;
  betaltKl: string | null;
  frigivetKl: string | null;
  overfoertKl: string | null;
  sidsteFejl: string | null;
  autobetalingResultat: string | null;
};

// Henter betalingsstatus for en handel. Kun køber og sælger (RLS + eksplicit
// tjek). Står betalingen som ikke-betalt, men har en PaymentIntent, spørges
// Stripe direkte, så status er korrekt, når køberen vender tilbage fra
// betalingen, selv om webhooken ikke er nået frem endnu.
export async function hentBetalingsstatus(
  handelId: string,
): Promise<({ ok: true } & Betalingsstatus) | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };

  const supabase = await createClient();
  const { data: rls } = await supabase
    .from("betalinger")
    .select("id, buyer_id, seller_id")
    .eq("trade_id", handelId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<{ id: string; buyer_id: string; seller_id: string }>();
  if (!rls) return { fejl: "Betalingen findes ikke." };

  try {
    let b = await hentBetalingForHandel(handelId);
    if (!b) return { fejl: "Betalingen findes ikke." };

    if (
      (b.status === "afventer" || b.status === "behandles") &&
      b.stripe_payment_intent_id
    ) {
      const pi = await getStripe().paymentIntents.retrieve(b.stripe_payment_intent_id);
      await spejlPaymentIntent(pi);
      b = (await hentBetalingForHandel(handelId)) ?? b;
    }

    const erKoeber = b.buyer_id === user.id;
    return {
      ok: true,
      handelId,
      erKoeber,
      status: b.status,
      betalSenest: b.betal_senest,
      fristOverskredet: new Date(b.betal_senest).getTime() < Date.now(),
      budOere: Number(b.bud_oere),
      koebergebyrOere: Number(b.koebergebyr_oere),
      fragtOere: Number(b.fragt_oere),
      beskyttelse: b.beskyttelse,
      beskyttelseOere: Number(b.beskyttelse_oere),
      beskyttelsePrisOere: beskyttelseOere(Number(b.bud_oere)),
      totalOere: Number(b.total_oere),
      saelgergebyrOere: erKoeber ? null : Number(b.saelgergebyr_oere),
      udbetalingOere: erKoeber ? null : Number(b.udbetaling_oere),
      betaltKl: b.betalt_kl,
      frigivetKl: b.frigivet_kl,
      overfoertKl: b.overfoert_kl,
      // Aldrig den interne fejltekst: kun en fast dansk tekst, og kun for et
      // mislykket betalingsforsøg (ikke for interne markeringer til admin).
      sidsteFejl:
        erKoeber &&
        b.sidste_fejl &&
        !b.kraever_opmaerksomhed &&
        (b.status === "afventer" || b.status === "behandles")
          ? "Betalingen kunne ikke gennemføres."
          : null,
      // Stripes fejlkode sendes ikke til klienten - kun "fejlet_" eller "betalt".
      autobetalingResultat: !erKoeber
        ? null
        : b.autobetaling_resultat?.startsWith("fejlet_")
          ? "fejlet_autobetaling"
          : b.autobetaling_resultat === "betalt"
            ? "betalt"
            : null,
    };
  } catch (err) {
    console.error("hentBetalingsstatus fejlede:", err);
    return { fejl: GENERISK };
  }
}

// ------------------------------------------------------------------ betal

// Starter (eller genoptager) betalingen for en vundet auktion og returnerer
// client_secret til Stripes Payment Element. Beløbet kommer udelukkende fra
// betalingsrækken (BidHamr Beskyttelse er låst ved buddet) - klienten sender
// intet, der påvirker beløbet.
export async function startBetaling(
  handelId: string,
): Promise<{ ok: true; clientSecret: string; totalOere: number } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };

  try {
    const b = await hentBetalingForHandel(handelId);
    if (!b || b.buyer_id !== user.id) return { fejl: "Betalingen findes ikke." };
    if (b.status === "betalt") return { fejl: "Handlen er allerede betalt." };
    if (b.status === "behandles") {
      return { fejl: "Din betaling behandles. Du hører fra os, når den er gennemført." };
    }
    if (b.status !== "afventer") return { fejl: "Handlen kan ikke længere betales." };
    if (new Date(b.betal_senest).getTime() < Date.now()) {
      return { fejl: "Fristen for at betale er overskredet." };
    }

    const pi = await sikrPaymentIntent(b);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlPaymentIntent(pi);
      return { fejl: "Betalingen er allerede i gang eller gennemført." };
    }
    if (pi.status === "canceled") return { fejl: "Handlen kan ikke længere betales." };
    if (pi.amount !== Number(b.total_oere)) return { fejl: GENERISK };
    if (!pi.client_secret) return { fejl: GENERISK };

    return { ok: true, clientSecret: pi.client_secret, totalOere: pi.amount };
  } catch (err) {
    if (err instanceof BetalingsFejl) return { fejl: err.message };
    console.error("startBetaling fejlede:", err);
    return { fejl: GENERISK };
  }
}

// ------------------------------------------------------------------ gemt kort

export type Betalingsindstillinger = {
  gemtKort: { maerke: string | null; sidste4: string | null; udloeb: string | null } | null;
  autobetaling: boolean;
  saelger: {
    harKonto: boolean;
    detaljerIndsendt: boolean;
    overfoerslerAktiv: boolean;
    udbetalingerAktiv: boolean;
    // Stripe mangler oplysninger efter indsendelse (requirements.currently_due
    // eller past_due) - sælgeren skal fortsætte opsætningen.
    manglerOplysninger: boolean;
    // Stripe har afvist kontoen (disabled_reason rejected.*).
    afvist: boolean;
    // Sælgeren har lukket/frakoblet kontoen hos Stripe.
    frakoblet: boolean;
  };
};

export async function hentBetalingsindstillinger(): Promise<
  ({ ok: true } & Betalingsindstillinger) | Fejl
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    const p = await hentProfil(user.id);
    return {
      ok: true,
      gemtKort: p?.gemt_betalingsmetode_id
        ? { maerke: p.gemt_kort_maerke, sidste4: p.gemt_kort_sidste4, udloeb: p.gemt_kort_udloeb }
        : null,
      autobetaling: !!p?.autobetaling,
      saelger: {
        harKonto: !!p?.stripe_account_id,
        detaljerIndsendt: !!p?.connect_detaljer_indsendt,
        overfoerslerAktiv: !!p?.connect_overfoersler_aktiv,
        udbetalingerAktiv: !!p?.connect_udbetalinger_aktiv,
        manglerOplysninger:
          !!p?.stripe_account_id &&
          ((p.connect_mangler_nu?.length ?? 0) > 0 ||
            (p.connect_mangler_forfaldne?.length ?? 0) > 0),
        afvist: !!p?.connect_spaerret_aarsag?.startsWith("rejected."),
        frakoblet: !!p?.connect_frakoblet_kl,
      },
    };
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
  try {
    const kunde = await sikrStripeKunde(user.id);
    const stripe = getStripe();

    // Genbrug en åben SetupIntent for kunden, så gentagne klik ikke opretter
    // en ny hver gang.
    const aabne = await stripe.setupIntents.list({ customer: kunde, limit: 10 });
    const aaben = aabne.data.find(
      (s) =>
        s.usage === "off_session" &&
        s.metadata?.bruger_id === user.id &&
        (s.status === "requires_payment_method" ||
          s.status === "requires_confirmation" ||
          s.status === "requires_action"),
    );
    if (aaben?.client_secret) return { ok: true, clientSecret: aaben.client_secret };

    // Idempotency key bygget på kundens seneste SetupIntent: samtidige kald
    // ser samme liste og får samme SetupIntent. Når den er brugt, er den selv
    // den seneste, så næste "skift kort" får en ny nøgle.
    const vindue = aabne.data[0]?.id ?? "foerste";
    const si = await stripe.setupIntents.create(
      {
        customer: kunde,
        usage: "off_session",
        // Kort (inkl. Apple Pay / Google Pay, som gemmes som kort).
        payment_method_types: ["card"],
        metadata: { bruger_id: user.id },
      },
      { idempotencyKey: `bidhamr-gemkort-${user.id}-${vindue}` },
    );
    if (!si.client_secret) return { fejl: GENERISK };
    return { ok: true, clientSecret: si.client_secret };
  } catch (err) {
    console.error("startGemKort fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Kaldes, når brugeren vender tilbage fra confirmSetup (setup_intent i URL'en),
// så kortet vises med det samme. Webhooken gør det samme bagefter.
export async function bekraeftGemtKort(
  setupIntentId: string,
): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  if (typeof setupIntentId !== "string" || !setupIntentId.startsWith("seti_")) {
    return { fejl: "Ugyldig forespørgsel." };
  }
  try {
    const profil = await hentProfil(user.id);
    const si = await getStripe().setupIntents.retrieve(setupIntentId);
    const kunde = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!profil?.stripe_customer_id || kunde !== profil.stripe_customer_id) {
      return { fejl: "Ugyldig forespørgsel." };
    }
    if (si.status !== "succeeded") return { fejl: "Kortet blev ikke gemt." };
    await registrerGemtKort(si);
    revalidatePath("/konto");
    return { ok: true };
  } catch (err) {
    console.error("bekraeftGemtKort fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function saetAutobetaling(til: boolean): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  if (typeof til !== "boolean") return { fejl: "Ugyldigt valg." };
  try {
    const p = await hentProfil(user.id);
    if (til && !p?.gemt_betalingsmetode_id) {
      return { fejl: "Gem et kort, før du slår automatisk betaling til." };
    }
    if (!p) return { ok: true };
    const { error } = await createAdminClient()
      .from("betalingsprofiler")
      .update({ autobetaling: til, opdateret: new Date().toISOString() })
      .eq("user_id", user.id);
    if (error) throw new Error(error.message);
    revalidatePath("/konto");
    return { ok: true };
  } catch (err) {
    console.error("saetAutobetaling fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function fjernGemtKort(): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    const p = await hentProfil(user.id);
    if (!p?.gemt_betalingsmetode_id) return { ok: true };
    const { error } = await createAdminClient()
      .from("betalingsprofiler")
      .update({
        autobetaling: false,
        gemt_betalingsmetode_id: null,
        gemt_kort_maerke: null,
        gemt_kort_sidste4: null,
        gemt_kort_udloeb: null,
        opdateret: new Date().toISOString(),
      })
      .eq("user_id", user.id);
    if (error) throw new Error(error.message);
    try {
      await getStripe().paymentMethods.detach(p.gemt_betalingsmetode_id);
    } catch (err) {
      console.warn("Kunne ikke fjerne kort hos Stripe:", err);
    }
    revalidatePath("/konto");
    return { ok: true };
  } catch (err) {
    console.error("fjernGemtKort fejlede:", err);
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
  try {
    const url = await onboardingLink(user.id, erOnboardingRetur(retur) ? retur : "konto");
    return { ok: true, url };
  } catch (err) {
    if (err instanceof BetalingsFejl) return { fejl: err.message };
    console.error("startSaelgerOnboarding fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Henter sælgerkontoens status direkte fra Stripe (fx på return_url).
export async function opdaterSaelgerStatus(): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    const p = await hentProfil(user.id);
    if (!p?.stripe_account_id) return { ok: true };
    const konto = await getStripe().accounts.retrieve(p.stripe_account_id);
    await spejlConnectKonto(konto);
    revalidatePath("/konto");
    revalidatePath("/opret-auktion");
    return { ok: true };
  } catch (err) {
    console.error("opdaterSaelgerStatus fejlede:", err);
    return { fejl: GENERISK };
  }
}

// ------------------------------------------------------------------ udbetalinger

// Engangs-link til sælgerens egen oversigt hos Stripe (Express Dashboard:
// udbetalinger til banken, bankkonto, saldo). Kun for den indloggede brugers
// egen konto, og kun når oplysningerne er sendt ind. Linket returneres til
// klienten, som sender brugeren videre med det samme (det må ikke gemmes
// eller mailes).
export async function aabnStripeOversigt(): Promise<{ ok: true; url: string } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    const url = await stripeOversigtLink(user.id);
    if (!url) {
      return { fejl: "Du skal først gøre opsætningen af din udbetalingskonto færdig." };
    }
    return { ok: true, url };
  } catch (err) {
    console.error("aabnStripeOversigt fejlede:", err);
    return { fejl: GENERISK };
  }
}

export type { Overfoersel };

// Sælgerens egne overførsler fra handler på BidHamr til udbetalingskontoen
// hos Stripe (vare, dato, beløb). Kun egne - id'et kommer fra sessionen.
export async function hentMineOverfoersler(): Promise<
  { ok: true; overfoersler: Overfoersel[] } | Fejl
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  try {
    return { ok: true, overfoersler: await hentOverfoersler(user.id) };
  } catch (err) {
    console.error("hentMineOverfoersler fejlede:", err);
    return { fejl: GENERISK };
  }
}
