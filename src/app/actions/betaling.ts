"use server";

// Server actions til den nye betalingsmodel. Frontend bruger disse - beløb
// sendes ALDRIG fra klienten; de beregnes i databasen og læses herfra.
//
// Alle funktioner returnerer enten { ok: true, ... } eller { fejl: string }.

import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { logDriftFejl } from "@/lib/drift";
import { fjernGemtKortForBruger, saetAutobetalingForBruger } from "@/lib/betaling/kort";
import { beskyttelseOere } from "@/lib/betaling/beregn";
import { maksBetalingsfrist } from "@/lib/betalingsfrist";
import {
  BetalingsFejl,
  LeveringManglerFejl,
  BetalingVenterFejl,
  VENTER_TEKST,
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
} from "@/lib/betaling/stripeBetaling";

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

type FaellesBetalingsstatus = {
  handelId: string;
  status: "afventer" | "behandles" | "betalt" | "annulleret" | "refunderet";
  betalSenest: string;
  // Seneste frist, sælgeren kan forlænge til (7 dage efter fristens start).
  maksBetalSenest: string;
  fristOverskredet: boolean;
  // Betalingsmodel destination: betalingen venter på, at sælgerens Stripe-
  // konto bliver godkendt. Køberen kan ikke betale endnu, og betalSenest er
  // IKKE købers frist (den starter, når betalingen åbner) - vis i stedet
  // "Betalingen åbner, når sælgerens konto er godkendt".
  venterPaaSaelgerkonto: boolean;
  budOere: number;
  betaltKl: string | null;
  frigivetKl: string | null;
  overfoertKl: string | null;
};

// Køberens visning: hele beløbet inkl. BidHamr Beskyttelse.
export type KoeberBetalingsstatus = FaellesBetalingsstatus & {
  erKoeber: true;
  koebergebyrOere: number;
  fragtOere: number;
  beskyttelse: boolean;
  beskyttelseOere: number;
  // Hvad BidHamr Beskyttelse koster på denne handel, hvis den tilvælges.
  beskyttelsePrisOere: number;
  totalOere: number;
  sidsteFejl: string | null;
  autobetalingResultat: string | null;
};

// Sælgerens visning. Sælgeren må ikke kunne se, om køberen har købt BidHamr
// Beskyttelse - derfor hverken beskyttelse, købers total eller noget, den
// kan regnes ud fra.
export type SaelgerBetalingsstatus = FaellesBetalingsstatus & {
  erKoeber: false;
  // Det, der overføres ved frigivelse.
  saelgergebyrOere: number;
  udbetalingOere: number;
};

export type Betalingsstatus = KoeberBetalingsstatus | SaelgerBetalingsstatus;

// Henter betalingsstatus for en handel. Kun køber og sælger (RLS + eksplicit
// tjek). Står betalingen som ikke-betalt, men har en PaymentIntent, spørges
// Stripe direkte, så status er korrekt, når køberen vender tilbage fra
// betalingen, selv om webhooken ikke er nået frem endnu.
export async function hentBetalingsstatus(
  handelId: string,
): Promise<({ ok: true } & KoeberBetalingsstatus) | ({ ok: true } & SaelgerBetalingsstatus) | Fejl> {
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

    const venter = !!b.venter_paa_saelgerkonto_kl;
    const faelles: FaellesBetalingsstatus = {
      handelId,
      status: b.status,
      betalSenest: b.betal_senest,
      // Fristen kan forlænges til 7 dage efter, at betalingen åbnede.
      maksBetalSenest: maksBetalingsfrist(b.betaling_aabnet_kl ?? b.oprettet),
      fristOverskredet: !venter && new Date(b.betal_senest).getTime() < Date.now(),
      venterPaaSaelgerkonto: venter,
      budOere: Number(b.bud_oere),
      betaltKl: b.betalt_kl,
      frigivetKl: b.frigivet_kl,
      overfoertKl: b.overfoert_kl,
    };
    if (b.buyer_id !== user.id) {
      return {
        ok: true,
        ...faelles,
        erKoeber: false,
        saelgergebyrOere: Number(b.saelgergebyr_oere),
        udbetalingOere: Number(b.udbetaling_oere),
      };
    }
    return {
      ok: true,
      ...faelles,
      erKoeber: true,
      koebergebyrOere: Number(b.koebergebyr_oere),
      fragtOere: Number(b.fragt_oere),
      beskyttelse: b.beskyttelse,
      beskyttelseOere: Number(b.beskyttelse_oere),
      beskyttelsePrisOere: beskyttelseOere(Number(b.bud_oere)),
      totalOere: Number(b.total_oere),
      // Aldrig den interne fejltekst: kun en fast dansk tekst, og kun for et
      // mislykket betalingsforsøg (ikke for interne markeringer til admin).
      sidsteFejl:
        b.sidste_fejl &&
        !b.kraever_opmaerksomhed &&
        (b.status === "afventer" || b.status === "behandles")
          ? "Betalingen kunne ikke gennemføres."
          : null,
      // Stripes fejlkode sendes ikke til klienten - kun "fejlet_" eller "betalt".
      autobetalingResultat: b.autobetaling_resultat?.startsWith("fejlet_")
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
): Promise<
  { ok: true; clientSecret: string; totalOere: number } | (Fejl & { betalt?: true; kode?: "vaelg_levering" })
> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };

  try {
    const b = await hentBetalingForHandel(handelId);
    if (!b || b.buyer_id !== user.id) return { fejl: "Betalingen findes ikke." };
    // Fx en gammel fane: siden genindlæses, så den nye status vises.
    if (b.status === "betalt") return { fejl: "Handlen er allerede betalt.", betalt: true };
    if (b.status === "behandles") {
      return { fejl: "Din betaling behandles. Du hører fra os, når den er gennemført.", betalt: true };
    }
    if (b.status !== "afventer") return { fejl: "Handlen kan ikke længere betales." };
    if (b.venter_paa_saelgerkonto_kl) return { fejl: VENTER_TEKST };
    if (new Date(b.betal_senest).getTime() < Date.now()) {
      return { fejl: "Fristen for at betale er overskredet." };
    }

    const pi = await sikrPaymentIntent(b);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlPaymentIntent(pi);
      return { fejl: "Handlen er allerede betalt.", betalt: true };
    }
    if (pi.status === "canceled") return { fejl: "Handlen kan ikke længere betales." };
    if (pi.amount !== Number(b.total_oere)) return { fejl: GENERISK };
    if (!pi.client_secret) return { fejl: GENERISK };

    return { ok: true, clientSecret: pi.client_secret, totalOere: pi.amount };
  } catch (err) {
    // Fragt: køberen skal vælge levering i checkout først.
    if (err instanceof LeveringManglerFejl) return { fejl: err.message, kode: "vaelg_levering" };
    if (err instanceof BetalingsFejl || err instanceof BetalingVenterFejl) return { fejl: err.message };
    console.error("startBetaling fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startBetaling", fejl: err, brugerId: user.id });
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
    // Kontoen blev ikke godkendt i tide, og en auktion er annulleret: kan ikke
    // sætte varer til salg, før Stripe har godkendt kontoen (betalingsmodel
    // destination, 20261011020000).
    frosset: boolean;
    // En udbetaling til banken er fejlet - sælgeren skal rette bankkontoen hos Stripe.
    venterPaaBank: boolean;
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
        frosset: !!p?.saelger_frosset_kl,
        venterPaaBank: !!p?.connect_udbetaling_fejlet_kl,
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
    // en ny hver gang - men kun en, der er NYERE end det gemte kort og seneste
    // "Fjern kort". En ældre ville registrerGemtKort afvise bagefter (kortet
    // blev ikke gemt), så den annulleres, og der laves en ny.
    const profil = await hentProfil(user.id);
    const p2 = profil as (typeof profil & { gemt_kort_kl?: string | null; kort_fjernet_kl?: string | null }) | null;
    const graense = Math.max(
      ...[p2?.gemt_kort_kl, p2?.kort_fjernet_kl].map((x) => (x ? Math.floor(new Date(x).getTime() / 1000) : 0)),
    );
    const aabne = await stripe.setupIntents.list({ customer: kunde, limit: 10 });
    let aaben: (typeof aabne.data)[number] | undefined;
    for (const s of aabne.data) {
      if (
        s.usage !== "off_session" ||
        s.metadata?.bruger_id !== user.id ||
        !(s.status === "requires_payment_method" || s.status === "requires_confirmation" || s.status === "requires_action")
      ) {
        continue;
      }
      if (s.created <= graense) {
        try {
          await stripe.setupIntents.cancel(s.id);
        } catch (err) {
          console.warn("Kunne ikke annullere gammel SetupIntent:", s.id, err instanceof Error ? err.message : err);
        }
        continue;
      }
      aaben ??= s;
    }
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
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startGemKort", fejl: err, brugerId: user.id });
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
    if (!(await registrerGemtKort(si))) {
      // Afvist (fx et forsinket svar efter "Fjern kort", eller kortet er
      // fjernet hos Stripe i mellemtiden).
      revalidatePath("/konto");
      return { fejl: "Kortet blev ikke gemt. Prøv at tilføje det igen." };
    }
    revalidatePath("/konto");
    return { ok: true };
  } catch (err) {
    console.error("bekraeftGemtKort fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "bekraeftGemtKort", fejl: err, brugerId: user.id });
    return { fejl: GENERISK };
  }
}

export async function saetAutobetaling(til: boolean): Promise<{ ok: true } | Fejl> {
  const user = await indloggetBruger();
  if (!user) return { fejl: "Du skal være logget ind." };
  if (typeof til !== "boolean") return { fejl: "Ugyldigt valg." };
  try {
    const svar = await saetAutobetalingForBruger(user.id, til);
    if ("ok" in svar) revalidatePath("/konto");
    return svar;
  } catch (err) {
    console.error("saetAutobetaling fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "saetAutobetaling", fejl: err, brugerId: user.id });
    return { fejl: GENERISK };
  }
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
  try {
    const url = await onboardingLink(user.id, erOnboardingRetur(retur) ? retur : "konto");
    return { ok: true, url };
  } catch (err) {
    if (err instanceof BetalingsFejl) return { fejl: err.message };
    console.error("startSaelgerOnboarding fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startSaelgerOnboarding", fejl: err, brugerId: user.id });
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
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "opdaterSaelgerStatus", fejl: err, brugerId: user.id });
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
  } | null;
  return {
    ok: true,
    visning: v
      ? { status: v.status, tidligstKl: v.tidligst_kl, sendtKl: v.sendt_kl, beloebOere: Number(v.beloeb_oere) }
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
