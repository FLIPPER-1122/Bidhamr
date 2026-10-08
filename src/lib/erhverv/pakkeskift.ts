import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { ERHVERV_EMAIL, erhvervFejlTekst, type ErhvervPakke } from "@/lib/erhverv/regler";
import {
  annullerPlanlagtSkift,
  startNedgradering,
  startOpgradering,
  type BetalingsStatus,
  type Tilbagerul,
} from "@/lib/erhverv/betaling";
import { FIRMA_OVERSIGT, FIRMA_OVERSIGT_EKSTRA } from "@/lib/tekster/erhverv";

// Firmaets pakkeskift - ÉN vej for både hjemmesiden (/api/offentlig
// firma-skift-pakke -> skiftFirmaPakke) og appen (POST /api/firma/skift-pakke
// med Bearer-token). brugerId kommer altid fra et verificeret login, aldrig
// fra kroppen.
//
// 1. firma_skift_pakke_server (kun service role - authenticated kan ikke
//    kalde pakkeskift direkte) ændrer databasen og svarer med 'tilbagerul'.
// 2. Stripe: opgradering (faktura for forskellen), nedgradering (Subscription
//    Schedule) eller "behold pakken" (planen frigives).
// 3. Fejler Stripe, rulles databasen tilbage, og firmaet får en dansk fejl -
//    pakken er uændret begge steder.

export type SkiftPakkeSvar =
  | { ok: true; kode: "opgradering_afventer_betaling"; pakke: ErhvervPakke; besked: string }
  // Kortet kræver godkendelse (fx 3D Secure), eller betalingen fejlede:
  // firmaet sendes til Stripes fakturaside for at betale forskellen.
  | { ok: true; kode: "betal_forskellen"; pakke: ErhvervPakke; url: string; besked: string }
  // Betalingen gik igennem med det samme, og pakken er aktiveret.
  | { ok: true; kode: "opgraderet"; pakke: ErhvervPakke; besked: string }
  | { ok: true; kode: "nedgradering_planlagt"; pakke: ErhvervPakke; gaelderFra: string; besked: string }
  | { ok: true; kode: "uaendret"; besked: string }
  | { fejl: string; kode?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = `Noget gik galt. Prøv igen om lidt, eller skriv til ${ERHVERV_EMAIL}.`;

type DbSvar = {
  kode?: string;
  skift_id?: string;
  gaelder_fra?: string;
  pakke?: ErhvervPakke;
  tilbagerul?: Tilbagerul;
  // "I gang"-markering (20261010051000): kun ét skift pr. firma ad gangen.
  laas?: string;
};

function stripeFejl(b: Extract<BetalingsStatus, { status: "fejl" }>): SkiftPakkeSvar {
  // Et andet pakkeskift er gået i gang imens: dette skift er ikke rullet
  // tilbage, og det nye gælder. Sig det ærligt i stedet for "ikke ændret".
  if (b.laasOvertaget) return { fejl: FIRMA_OVERSIGT_EKSTRA.pakkeskiftLaasOvertaget, kode: "i_gang" };
  if (b.betalFoerst) return { fejl: FIRMA_OVERSIGT_EKSTRA.pakkeskiftBetalFoerst, kode: "betal_foerst" };
  return { fejl: b.rulletTilbage ? FIRMA_OVERSIGT_EKSTRA.pakkeskiftFejl : FIRMA_OVERSIGT_EKSTRA.opgraderingBetalingFejl, kode: "stripe_fejl" };
}

export async function skiftPakkeForBruger(brugerId: string, pakkeId: unknown): Promise<SkiftPakkeSvar> {
  if (typeof pakkeId !== "string" || !UUID.test(pakkeId)) return { fejl: "Vælg en pakke.", kode: "ugyldig_pakke" };

  const { data, error } = await createAdminClient().rpc("firma_skift_pakke_server", {
    p_bruger: brugerId,
    p_pakke: pakkeId,
  });
  if (error) {
    const tekst = erhvervFejlTekst(error.message, error.code);
    if (tekst) return { fejl: tekst, kode: error.code === "BHE07" ? "i_gang" : "ikke_tilladt" };
    if (error.code === "BHR01") return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
    await logDriftFejl({ kilde: "action", hvor: "skiftPakke", fejl: error, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
  const svar = (data ?? null) as DbSvar | null;
  try {
    return await stripeDel(brugerId, svar);
  } finally {
    // Stripe-delen er færdig (eller rullet tilbage): et nyt skift må startes.
    // Fejler det, udløber markeringen selv efter 5 minutter.
    if (svar?.laas) {
      const firma = await createAdminClient().from("firmaer").select("id").eq("bruger_id", brugerId).maybeSingle<{ id: string }>();
      if (firma.data) {
        const { error: lf } = await createAdminClient().rpc("firma_pakkeskift_laas_frigiv", {
          p_firma: firma.data.id,
          p_laas: svar.laas,
        });
        if (lf) await logDriftFejl({ kilde: "action", hvor: "skiftPakke/frigiv", fejl: lf, brugerId });
      }
    }
  }
}

async function stripeDel(brugerId: string, svar: DbSvar | null): Promise<SkiftPakkeSvar> {
  const tilbagerul = svar?.tilbagerul ?? null;
  // Tilbagerulning rydder kun vores egen lås (firma_pakkeskift_rul_tilbage).
  const laas = svar?.laas ?? null;

  if (svar?.kode === "opgradering_afventer_betaling" && svar.pakke && svar.skift_id) {
    const betaling = await startOpgradering(svar.skift_id, tilbagerul, laas);
    // Kun "Din pakke er nu X", når betalingen er gået igennem og pakken
    // faktisk er aktiveret.
    if (betaling.status === "betalt") {
      return { ok: true, kode: "opgraderet", pakke: svar.pakke, besked: FIRMA_OVERSIGT.abonnement.opgraderetSvar(svar.pakke.navn) };
    }
    if (betaling.status === "fejl") {
      await logDriftFejl({ kilde: "action", hvor: "skiftPakke/startOpgradering", fejl: betaling.fejl, brugerId });
      return stripeFejl(betaling);
    }
    if (betaling.status === "kraever_handling") {
      return {
        ok: true,
        kode: "betal_forskellen",
        pakke: svar.pakke,
        url: betaling.url,
        besked: FIRMA_OVERSIGT_EKSTRA.betalForskellenSvar,
      };
    }
    return { ok: true, kode: "opgradering_afventer_betaling", pakke: svar.pakke, besked: betaling.besked };
  }

  if (svar?.kode === "nedgradering_planlagt" && svar.pakke && svar.gaelder_fra && svar.skift_id) {
    const plan = await startNedgradering(svar.skift_id, tilbagerul, laas);
    if (plan.status === "fejl") {
      await logDriftFejl({ kilde: "action", hvor: "skiftPakke/startNedgradering", fejl: plan.fejl, brugerId });
      return stripeFejl(plan);
    }
    // Datoen følger Stripes periode (startNedgradering har rettet den).
    const { data: s } = await createAdminClient()
      .from("firma_pakkeskift")
      .select("gaelder_fra")
      .eq("id", svar.skift_id)
      .maybeSingle<{ gaelder_fra: string | null }>();
    const gaelderFra = s?.gaelder_fra ?? svar.gaelder_fra;
    const dato = new Date(gaelderFra).toLocaleDateString("da-DK", {
      timeZone: "Europe/Copenhagen",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    return {
      ok: true,
      kode: "nedgradering_planlagt",
      pakke: svar.pakke,
      gaelderFra,
      besked: FIRMA_OVERSIGT_EKSTRA.nedgraderetSvar(svar.pakke.navn, dato),
    };
  }

  if (svar?.kode === "uaendret") {
    const res = await annullerPlanlagtSkift(brugerId, tilbagerul, laas);
    if (res.status === "fejl") {
      await logDriftFejl({ kilde: "action", hvor: "skiftPakke/annullerPlanlagtSkift", fejl: res.fejl, brugerId });
      return stripeFejl(res);
    }
    return { ok: true, kode: "uaendret", besked: FIRMA_OVERSIGT_EKSTRA.uaendretSvar };
  }
  if (svar?.kode === "ugyldig_pakke") return { fejl: "Pakken findes ikke længere. Vælg en anden.", kode: "ugyldig_pakke" };
  return { fejl: GENERISK, kode: "fejl" };
}
