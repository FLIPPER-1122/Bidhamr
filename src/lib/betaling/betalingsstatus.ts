import "server-only";

// Betalingsstatus for en handel - ÉN kodevej for hjemmesiden
// (hentBetalingsstatus i src/app/actions/betaling.ts) og appen
// (POST /api/handel/app/status). supabase kalder databasen SOM brugeren
// (cookie-session eller Bearer-token), brugerId er den samme, verificerede
// bruger.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { gammelBeskyttelseOere, type Prismodel } from "@/lib/betaling/beregn";
import { maksBetalingsfrist } from "@/lib/betalingsfrist";
import { hentBetalingForHandel, spejlPaymentIntent } from "@/lib/betaling/stripeBetaling";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

export type FaellesBetalingsstatus = {
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
  // Seller founder-rabat (0/50/100) på købergebyr og sælgergebyr, låst på
  // betalingen (20261102420000). Gebyrbeløbene ovenfor er allerede efter
  // rabatten - feltet er kun til teksten "Founding seller".
  founderRabatPct: number;
};

// Køberens visning: hele beløbet inkl. BidHamr Beskyttelse.
export type KoeberBetalingsstatus = FaellesBetalingsstatus & {
  erKoeber: true;
  koebergebyrOere: number;
  fragtOere: number;
  beskyttelse: boolean;
  beskyttelseOere: number;
  // Hvad BidHamr Beskyttelse koster særskilt på denne handel ved forsendelse.
  // Ny prismodel (20261031010000): 0 - den er inkluderet i købergebyret.
  beskyttelsePrisOere: number;
  // Gebyrmodellen (gammel = før 26. okt. 2026: "Købergebyr (5 %)" og evt.
  // tilkøbt Beskyttelse). Til den rigtige gebyrtekst (beregn.ts koebergebyrTekst).
  prismodel: Prismodel;
  totalOere: number;
  sidsteFejl: string | null;
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
export async function hentBetalingsstatusFor(
  supabase: SupabaseClient,
  brugerId: string,
  handelId: string,
): Promise<({ ok: true } & KoeberBetalingsstatus) | ({ ok: true } & SaelgerBetalingsstatus) | Fejl> {
  const user = { id: brugerId };
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
      founderRabatPct: Number(b.founder_rabat_pct ?? 0),
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
      beskyttelsePrisOere: (b.prismodel ?? "gammel") === "gammel" ? gammelBeskyttelseOere(Number(b.bud_oere)) : 0,
      prismodel: b.prismodel ?? "gammel",
      totalOere: Number(b.total_oere),
      // Aldrig den interne fejltekst: kun en fast dansk tekst, og kun for et
      // mislykket betalingsforsøg (ikke for interne markeringer til admin).
      sidsteFejl:
        b.sidste_fejl &&
        !b.kraever_opmaerksomhed &&
        (b.status === "afventer" || b.status === "behandles")
          ? "Betalingen kunne ikke gennemføres."
          : null,
    };
  } catch (err) {
    console.error("hentBetalingsstatus fejlede:", err);
    return { fejl: GENERISK };
  }
}
