"use server";

// Admin → Penge (kun chef): nødstop, godkendelse af udbetalinger (når
// købers samlede betaling er 10.000 kr. eller mere), frosne sælgere og
// "BidHamr dækker" (sikkerhedsnet A, 20261019010000_pengesikkerhed.sql). Databasen tjekker rolle og
// inhabilitet igen og logger i moderation_log.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { CHEF_BELOEBSGRAENSE_OERE } from "@/lib/betaling/beregn";
import { glemNoedstop, hentNoedstop, type Noedstop } from "@/lib/betaling/noedstop";
import { logDriftFejl } from "@/lib/drift";

class BrugerFejl extends Error {}
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INHABIL =
  "Du kan ikke behandle en handel, hvor du selv er køber eller sælger, eller hvor du har handlet med en af dem.";

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error(`Admin-handling ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

const tekst = (f: FormData, n: string) => ((f.get(n) as string | null) ?? "").trim();

// ------------------------------------------------------------------ nødstop

// Bjælken i admin (alle staff): kun om noget er stoppet - årsagen ses af chefen.
export async function hentNoedstopBjaelke() {
  return koer("hentNoedstopBjaelke", async () => {
    const { rolle } = await assertRole("medarbejder");
    const n = await hentNoedstop(true);
    return {
      ok: true as const,
      udbetalinger: n.udbetalingerStoppet,
      nyeBetalinger: n.nyeBetalingerStoppet,
      aarsag: rolle === "chef" ? (n.udbetalingerAarsag ?? n.nyeBetalingerAarsag) : null,
    };
  });
}

const NOEDSTOP_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan bruge nødstoppet.",
  ugyldig: "Ugyldigt valg.",
  begrundelse_mangler: "Skriv en begrundelse.",
  begrundelse_for_lang: "Begrundelsen er for lang (højst 1000 tegn).",
  uaendret: "Det er allerede sådan. Opdatér siden.",
};

// formData: hvad ('udbetalinger' | 'nye_betalinger'), stop ('ja' | 'nej'), aarsag.
export async function saetNoedstop(formData: FormData) {
  return koer("saetNoedstop", async () => {
    const { admin, userId } = await assertRole("chef");
    const hvad = tekst(formData, "hvad");
    const stop = tekst(formData, "stop") === "ja";
    const aarsag = tekst(formData, "aarsag");
    if (hvad !== "udbetalinger" && hvad !== "nye_betalinger") throw new BrugerFejl(NOEDSTOP_FEJL.ugyldig);
    if (!aarsag) throw new BrugerFejl(NOEDSTOP_FEJL.begrundelse_mangler);
    const { data, error } = await admin.rpc("stripe_noedstop_saet", {
      p_medarbejder: userId,
      p_hvad: hvad,
      p_stop: stop,
      p_aarsag: aarsag,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as {
      kode?: string;
      forlaenget?: { trade_id: string; buyer_id: string; betal_senest: string }[];
      forlaengelse_fejlet?: number;
    };
    const kode = svar.kode ?? "";
    if (kode !== "ok") throw new BrugerFejl(NOEDSTOP_FEJL[kode] ?? GENERISK);
    glemNoedstop();

    let ekstra = "";
    let tilbage = 0;
    if (hvad === "nye_betalinger" && stop) {
      // Åbne checkouts kan ikke betales under stoppet (sikkerhedsnet A).
      const a = await annullerOgBeskriv();
      ekstra = a.tekst;
      tilbage = a.tilbage;
    }
    if (hvad === "nye_betalinger" && !stop) {
      const forl = svar.forlaenget ?? [];
      await giveKoeberneBesked(forl);
      ekstra = ` Betalingsfristen er forlænget for ${forl.length} handel(er).${svar.forlaengelse_fejlet ? ` ${svar.forlaengelse_fejlet} betaling(er) fik IKKE fristen forlænget - kontrollér dem under Betalinger, før fristen udløber.` : ""}`;
    }
    await logDriftFejl({
      kilde: "action",
      hvor: "betaling/noedstop",
      fejl: `Nødstop: ${hvad === "udbetalinger" ? "udbetalinger til sælgernes bank" : "nye betalinger"} er ${stop ? "STOPPET" : "genoptaget"} af chefen.${ekstra}`,
      brugerId: userId,
    });
    revalidatePath("/admin", "layout");
    if (tilbage > 0) throw new BrugerFejl(`Nye betalinger er stoppet.${ekstra}`);
    return { ok: true as const };
  });
}

async function annullerOgBeskriv(): Promise<{ tekst: string; tilbage: number }> {
  const { annullerAabneBetalinger } = await import("@/lib/betaling/noedstop");
  const a = await annullerAabneBetalinger();
  const tekst =
    ` ${a.annulleret} åbne betaling(er) er annulleret hos Stripe.` +
    (a.igang ? ` ${a.igang} betaling(er) var allerede sendt til banken og kan nå at gå igennem (de registreres som normalt).` : "") +
    (a.fejlet ? ` ${a.fejlet} kunne ikke annulleres - de kan stadig betales; kontrollér dem i Stripe.` : "") +
    (a.tilbage > 0
      ? ` Der er flere end der kunne nås på én gang (${a.tilbage} tilbage) - tryk "Annullér åbne betalinger" for at køre igen.`
      : "");
  return { tekst, tilbage: a.tilbage };
}

// Kør annulleringen af åbne betalinger igen (fx flere end 500, eller nogle
// kunne ikke annulleres). Kun chef, kun mens nye betalinger er stoppet.
export async function annullerAabneBetalingerIgen() {
  return koer("annullerAabneBetalingerIgen", async () => {
    const { userId } = await assertRole("chef");
    if (!(await hentNoedstop(true)).nyeBetalingerStoppet) {
      throw new BrugerFejl("Nye betalinger er ikke stoppet. Opdatér siden.");
    }
    const a = await annullerOgBeskriv();
    await logDriftFejl({
      kilde: "action",
      hvor: "betaling/noedstop",
      fejl: `Nødstop: åbne betalinger annulleret igen af chefen.${a.tekst}`,
      brugerId: userId,
    });
    revalidatePath("/admin/penge");
    if (a.tilbage > 0) throw new BrugerFejl(a.tekst.trim());
    return { ok: true as const };
  });
}

// Køberne, hvis frist er forlænget efter et stop for nye betalinger, får
// besked (én pr. handel og frist). Kaster aldrig.
async function giveKoeberneBesked(forl: { trade_id: string; buyer_id: string; betal_senest: string }[]) {
  if (forl.length === 0) return;
  const { send } = await import("@/lib/notifikationer/send");
  const { fristDato } = await import("@/lib/betalingsfrist");
  for (const f of forl) {
    try {
      await send(f.buyer_id, "betalingsfrist", {
        titel: "Du kan betale igen",
        tekst: `Betalingen var midlertidigt sat på pause. Du kan nu betale igen, og din frist er forlænget til ${fristDato(f.betal_senest)}.`,
        link: `/mine-handler/${f.trade_id}`,
        data: { trade_id: f.trade_id },
        noegle: `noedstop_forlaenget:${f.trade_id}:${new Date(f.betal_senest).getTime()}`,
      });
    } catch (err) {
      console.error("Besked om forlænget frist fejlede:", f.trade_id, err);
    }
  }
}

// ------------------------------------------------------------------ Penge-siden

export type GodkendelseRaekke = {
  betalingId: string;
  tradeId: string;
  titel: string | null;
  saelger: string | null;
  // Købers samlede betaling - det beløb, grænsen regnes på.
  totalOere: number;
  udbetalingOere: number;
  frigivetKl: string | null;
};

export type FrossenSaelger = {
  brugerId: string;
  navn: string | null;
  grund: string | null;
  udbetalingFrossetKl: string | null;
  salgFrosset: boolean;
};

export type Pengesikkerhed = {
  ok: true;
  noedstop: Noedstop;
  godkendelser: GodkendelseRaekke[];
  frosne: FrossenSaelger[];
};

export async function hentPengesikkerhed() {
  return koer("hentPengesikkerhed", async (): Promise<Pengesikkerhed> => {
    const { admin } = await assertRole("chef");
    const noedstop = await hentNoedstop(true);
    const [{ data: g, error: gFejl }, { data: f, error: fFejl }] = await Promise.all([
      admin
        .from("betalinger")
        .select("id, trade_id, auction_id, seller_id, total_oere, udbetaling_oere, frigivet_kl")
        .eq("pengemodel", "destination")
        .eq("status", "betalt")
        .not("frigivet_kl", "is", null)
        .is("saelger_udbetaling_id", null)
        .is("udbetaling_godkendt_kl", null)
        // Samme grundlag som databasen (betaling_udbetaling_blokeret):
        // greatest(total_oere, udbetaling_oere) >= grænsen, altså købers
        // samlede betaling (Filip, 12. okt. 2026).
        .or(`total_oere.gte.${CHEF_BELOEBSGRAENSE_OERE},udbetaling_oere.gte.${CHEF_BELOEBSGRAENSE_OERE}`)
        .order("frigivet_kl", { ascending: true })
        .limit(100),
      admin
        .from("betalingsprofiler")
        .select("user_id, udbetaling_frosset_kl, salg_frosset_kl")
        .or("udbetaling_frosset_kl.not.is.null,salg_frosset_kl.not.is.null")
        .limit(100),
    ]);
    // Før migrationen findes kolonnerne ikke: tomme lister.
    const mangler = (e: { code?: string } | null) =>
      !!e && ["42703", "PGRST204", "PGRST205", "42P01"].includes(e.code ?? "");
    if (gFejl && !mangler(gFejl)) throw new Error(gFejl.message);
    if (fFejl && !mangler(fFejl)) throw new Error(fFejl.message);
    const brugere = [...new Set([...(g ?? []).map((x) => x.seller_id as string), ...(f ?? []).map((x) => x.user_id as string)])];
    const auktioner = [...new Set((g ?? []).map((x) => x.auction_id as string))];
    const frosneIds = (f ?? []).map((x) => x.user_id as string);
    const [{ data: u }, { data: a }, { data: gr }] = await Promise.all([
      brugere.length ? admin.from("users").select("id, navn").in("id", brugere) : Promise.resolve({ data: [] }),
      auktioner.length ? admin.from("auctions").select("id, titel").in("id", auktioner) : Promise.resolve({ data: [] }),
      // Grunden står i en tabel, kun staff kan læse (sælgeren ser den ikke).
      frosneIds.length
        ? admin.from("saelger_frysning_grunde").select("user_id, grund").in("user_id", frosneIds)
        : Promise.resolve({ data: [] }),
    ]);
    const navn = new Map(((u ?? []) as { id: string; navn: string | null }[]).map((x) => [x.id, x.navn]));
    const titel = new Map(((a ?? []) as { id: string; titel: string | null }[]).map((x) => [x.id, x.titel]));
    const grund = new Map(((gr ?? []) as { user_id: string; grund: string }[]).map((x) => [x.user_id, x.grund]));
    return {
      ok: true,
      noedstop,
      godkendelser: (gFejl ? [] : (g ?? [])).map((x) => ({
        betalingId: x.id as string,
        tradeId: x.trade_id as string,
        titel: titel.get(x.auction_id as string) ?? null,
        saelger: navn.get(x.seller_id as string) ?? null,
        totalOere: Number(x.total_oere),
        udbetalingOere: Number(x.udbetaling_oere),
        frigivetKl: (x.frigivet_kl as string | null) ?? null,
      })),
      frosne: (fFejl ? [] : (f ?? [])).map((x) => ({
        brugerId: x.user_id as string,
        navn: navn.get(x.user_id as string) ?? null,
        grund: grund.get(x.user_id as string) ?? null,
        udbetalingFrossetKl: (x.udbetaling_frosset_kl as string | null) ?? null,
        salgFrosset: !!x.salg_frosset_kl,
      })),
    };
  });
}

const GODKEND_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan godkende udbetalinger.",
  note_mangler: "Skriv, hvad du har kontrolleret.",
  note_for_lang: "Noten er for lang (højst 2000 tegn).",
  ikke_fundet: "Betalingen blev ikke fundet.",
  inhabil: INHABIL,
  ikke_noedvendig: "Udbetalingen er under beløbsgrænsen og kræver ingen godkendelse.",
  allerede: "Udbetalingen er allerede godkendt.",
  ikke_frigivet: "Handlen er ikke frigivet endnu.",
  udbetalt: "Pengene er allerede udbetalt.",
};

// Hvad der ellers holder udbetalingen tilbage (betaling_udbetaling_blokeret),
// når chefen prøver at godkende for tidligt (kode andre_hindringer).
const HINDRING: Record<string, string> = {
  sag: "der er en sag eller anke på handlen, som ikke er færdig",
  sag_aaben: "handlen er markeret som sag",
  indsigelse: "køberen har lavet en indsigelse",
  refusion: "der er en refusion i gang",
  svindelvarsel: "der er et uløst svindelvarsel",
  radar_review: "Stripe gennemgår betalingen",
  ikke_afhentet: "pakken er ikke afhentet",
  returneret: "pakken er sendt retur",
  kraever_opmaerksomhed: "handlen har en markering, der skal lukkes under Betalinger",
  handel_annulleret: "handlen er annulleret",
  midler_ikke_tilgaengelige: "pengene er ikke tilgængelige hos Stripe endnu",
  ventetid: "ventetiden før udbetaling er ikke udløbet",
  fortrydelsesfrist: "køberens fortrydelsesfrist er ikke udløbet",
  udbetaling_frosset: "sælgerens udbetalinger er frosset",
  konto_frakoblet: "sælgerens Stripe-konto er frakoblet",
  konto_skiftet: "sælgeren har skiftet Stripe-konto",
  plan_ikke_manuel: "sælgerkontoens udbetalingsplan er ikke manuel",
  udbetalinger_inaktive: "sælgerkontoen kan ikke modtage udbetalinger",
  venter_paa_bank: "en tidligere udbetaling til sælgerens bank fejlede",
  transfer_ukendt: "overførslen til sælgerkontoen er ikke registreret",
};

// formData: betalingId, note.
export async function godkendUdbetaling(formData: FormData) {
  return koer("godkendUdbetaling", async () => {
    const { admin, userId } = await assertRole("chef");
    const id = tekst(formData, "betalingId");
    const note = tekst(formData, "note");
    if (!note) throw new BrugerFejl(GODKEND_FEJL.note_mangler);
    const { data, error } = await admin.rpc("betaling_udbetaling_godkend", {
      p_medarbejder: userId,
      p_betaling: id,
      p_note: note,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as { kode?: string; seller_id?: string; grund?: string | null };
    if (svar.kode === "andre_hindringer") {
      const hvad = HINDRING[svar.grund ?? ""];
      throw new BrugerFejl(
        `Udbetalingen kan ikke godkendes endnu${hvad ? `: ${hvad}` : ""}. Du kan først godkende, når din godkendelse er det eneste, der mangler.`,
      );
    }
    if (svar.kode !== "ok") throw new BrugerFejl(GODKEND_FEJL[svar.kode ?? ""] ?? GENERISK);
    // Udbetalingen sendes med det samme (ellers af cron'en).
    if (svar.seller_id) {
      try {
        const { udbetalVentende } = await import("@/lib/betaling/udbetaling");
        await udbetalVentende(svar.seller_id);
      } catch (err) {
        console.error("Udbetaling efter godkendelse fejlede (cron prøver igen):", id, err);
      }
    }
    revalidatePath("/admin/penge");
    return { ok: true as const };
  });
}

const OPHAEV_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan ophæve en frysning.",
  note_mangler: "Skriv, hvad du har kontrolleret.",
  note_for_lang: "Noten er for lang (højst 2000 tegn).",
  inhabil: "Du kan ikke ophæve frysningen af en sælger, du selv har handlet med.",
  ikke_frosset: "Sælgeren er ikke frosset. Opdatér siden.",
};

// formData: brugerId, note.
export async function ophaevFrysning(formData: FormData) {
  return koer("ophaevFrysning", async () => {
    const { admin, userId } = await assertRole("chef");
    const bruger = tekst(formData, "brugerId");
    const note = tekst(formData, "note");
    if (!note) throw new BrugerFejl(OPHAEV_FEJL.note_mangler);
    const { data, error } = await admin.rpc("saelger_frysning_ophaev", {
      p_medarbejder: userId,
      p_saelger: bruger,
      p_note: note,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode ?? "";
    if (kode !== "ok") throw new BrugerFejl(OPHAEV_FEJL[kode] ?? GENERISK);
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  });
}

const FRYS_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan fryse en sælger.",
  begrundelse_mangler: "Skriv en begrundelse.",
  begrundelse_for_lang: "Begrundelsen er for lang (højst 1000 tegn).",
  inhabil: "Du kan ikke fryse en sælger, du selv har handlet med.",
  ingen_profil: "Brugeren har ingen udbetalingskonto, så der er intet at fryse.",
  allerede: "Sælgeren er allerede frosset. Opdatér siden.",
};

// Chefen fryser selv en sælger (Admin → brugeren): ingen udbetalinger, og alle
// ventende handler markeres. formData: brugerId, begrundelse, frysSalg ('ja'
// = også nye auktioner og bud på sælgerens auktioner). Ophæves under
// Admin → Penge → "Frosne sælgere".
export async function frysSaelgerManuelt(formData: FormData) {
  return koer("frysSaelgerManuelt", async () => {
    const { admin, userId } = await assertRole("chef");
    const bruger = tekst(formData, "brugerId");
    const begrundelse = tekst(formData, "begrundelse");
    const frysSalg = tekst(formData, "frysSalg") === "ja";
    if (!bruger) throw new BrugerFejl(FRYS_FEJL.ingen_profil);
    if (!begrundelse) throw new BrugerFejl(FRYS_FEJL.begrundelse_mangler);
    const { data, error } = await admin.rpc("saelger_frys_manuelt", {
      p_medarbejder: userId,
      p_saelger: bruger,
      p_begrundelse: begrundelse,
      p_frys_salg: frysSalg,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode ?? "";
    if (kode !== "ok") throw new BrugerFejl(FRYS_FEJL[kode] ?? GENERISK);
    await logDriftFejl({
      kilde: "action",
      hvor: "betaling/frysning",
      fejl: `Chefen har frosset sælgerens udbetalinger${frysSalg ? " (også nye auktioner og bud)" : ""}. Ophæves under Admin → Penge → Frosne sælgere.`,
      brugerId: bruger,
    });
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ BidHamr dækker

const DAEKKER: Record<string, string> = {
  ingen_adgang: "Kun chefen kan lade BidHamr dække en refusion.",
  begrundelse_mangler: "Skriv en begrundelse.",
  begrundelse_for_lang: "Begrundelsen er for lang (højst 2000 tegn).",
  ikke_fundet: "Betalingen blev ikke fundet.",
  inhabil: INHABIL,
  ugyldig: "Betalingen kan ikke refunderes på denne måde.",
  allerede: "Køberen har allerede fået pengene tilbage.",
  i_gang: "En refusion er i gang lige nu. Vent et par minutter, og opdatér siden.",
  ikke_betalt: "Handlen er ikke betalt.",
  ikke_udbetalt:
    "Pengene er ikke udbetalt til sælgeren. Brug den almindelige refusion (Refundér køber) - så hentes pengene fra sælgerens Stripe-konto.",
  udbetaling_uafklaret: "Kan først bruges, når udbetalingen er gennemført hos banken.",
  indsigelse: "Køberen har en indsigelse hos sin bank. Banken afgør pengene - der refunderes ikke herfra.",
  konflikt: "Der findes allerede en refusion på betalingen hos Stripe. Intet er sendt - kontrollér betalingen i Stripe.",
  // Refusionen ER oprettet hos Stripe, men kunne ikke registreres her.
  konflikt_efter:
    "Refusionen kan være sendt til køberen hos Stripe, men den kunne ikke registreres her. Tjek betalingen i Stripe, før du gør mere.",
  stripe_afviste: "Stripe afviste refusionen. Prøv igen i morgen, eller kontakt Stripe.",
  uafklaret:
    "Stripe svarede ikke. Refusionen kan være sendt - vent et par minutter, og prøv igen. Den sendes aldrig to gange.",
  ikke_laast: "Refusionen blev sendt, men kunne ikke registreres med det samme. Den registreres, når Stripe bekræfter den.",
};

// formData: tradeId, begrundelse.
export async function bidhamrDaekkerRefusion(formData: FormData) {
  return koer("bidhamrDaekkerRefusion", async () => {
    const { admin, userId } = await assertRole("chef");
    const tradeId = tekst(formData, "tradeId");
    const begrundelse = tekst(formData, "begrundelse");
    if (!tradeId) throw new BrugerFejl(DAEKKER.ikke_fundet);
    if (!begrundelse) throw new BrugerFejl(DAEKKER.begrundelse_mangler);
    const { data: b, error } = await admin
      .from("betalinger")
      .select("id")
      .eq("trade_id", tradeId)
      .maybeSingle<{ id: string }>();
    if (error) throw new Error(error.message);
    if (!b) throw new BrugerFejl(DAEKKER.ikke_fundet);
    const { bidhamrDaekker } = await import("@/lib/betaling/bidhamrDaekker");
    let r: string;
    try {
      r = await bidhamrDaekker(b.id, userId, begrundelse);
    } catch (err) {
      console.error("BidHamr dækker fejlede:", b.id, err);
      revalidatePath("/admin", "layout");
      // Kun fejl, før refusionen blev sendt (opslag hos Stripe eller i databasen).
      throw new BrugerFejl("Refusionen kunne ikke startes. Intet er sendt - prøv igen om lidt.");
    }
    revalidatePath("/admin", "layout");
    if (r === "refunderet" || r === "afventer") return { ok: true as const };
    throw new BrugerFejl(DAEKKER[r] ?? GENERISK);
  });
}
