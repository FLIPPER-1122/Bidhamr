"use server";

// Sælgeren redigerer eller annullerer sin egen auktion – kun så længe der
// ikke er bud (ROADMAP-BESLUTNINGER.md, "Midlertidige beslutninger",
// 4. oktober 2026).
//
// Begge kald sker med brugerens egen session. Databasefunktionerne udleder
// brugeren af auth.uid() og låser auktionsrækken, så et samtidigt bud ikke
// kan smutte ind under en redigering. Annullerede auktioner arkiveres
// (status 'annulleret') og slettes aldrig. Fejl RETURNERES.

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { kategorier } from "@/lib/kategorier";
import {
  MAKS_BESKRIVELSE,
  MAKS_BILLEDER,
  MAKS_TITEL,
  valideStartpris,
  STARTPRIS_FOR_LAV,
  AUKTION_LAAST,
  erAuktionLaastFejl,
} from "@/lib/auktionRegler";
import { erStand } from "@/lib/stand";
import { forbudtBesked } from "@/lib/forbudteVarer";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAAST = AUKTION_LAAST;

const REDIGER_FEJL: Record<string, string> = {
  ikke_fundet: "Auktionen findes ikke.",
  suspenderet: "Din konto er suspenderet, og du kan ikke ændre dine auktioner.",
  ikke_aktiv: "Auktionen er ikke aktiv længere og kan ikke ændres.",
  slut: "Auktionen er slut og kan ikke ændres.",
  har_bud: LAAST,
  ugyldig_titel: `Titlen skal være mellem 1 og ${MAKS_TITEL} tegn.`,
  ugyldig_beskrivelse: `Beskrivelsen må højst være ${MAKS_BESKRIVELSE} tegn.`,
  ugyldige_billeder: `Tilføj mellem 1 og ${MAKS_BILLEDER} billeder.`,
  ugyldig_kategori: "Vælg en kategori.",
  ugyldig_startpris: "Startprisen skal være et helt antal kroner.",
  startpris_for_lav: STARTPRIS_FOR_LAV,
  ugyldig_stand: "Vælg varens stand.",
};

export type RedigerAuktionInput = {
  titel: string;
  beskrivelse: string | null;
  billeder: string[];
  kategori: string;
  startpris: number;
  forsendelseMulig: boolean;
  // Kode fra src/lib/stand.ts. null = uændret (gamle auktioner uden stand).
  stand: string | null;
};

export async function redigerAuktion(
  auktionId: string,
  input: RedigerAuktionInput,
): Promise<{ ok: true } | Fejl> {
  try {
    if (typeof auktionId !== "string" || !UUID.test(auktionId)) {
      return { fejl: REDIGER_FEJL.ikke_fundet };
    }
    if (!input || typeof input !== "object") return { fejl: GENERISK };

    const titel = typeof input.titel === "string" ? input.titel.trim() : "";
    if (titel.length < 1 || titel.length > MAKS_TITEL) return { fejl: REDIGER_FEJL.ugyldig_titel };

    const beskrivelse =
      typeof input.beskrivelse === "string" && input.beskrivelse.trim() !== ""
        ? input.beskrivelse.trim()
        : null;
    if (beskrivelse && beskrivelse.length > MAKS_BESKRIVELSE) {
      return { fejl: REDIGER_FEJL.ugyldig_beskrivelse };
    }

    if (typeof input.kategori !== "string" || !kategorier.includes(input.kategori)) {
      return { fejl: REDIGER_FEJL.ugyldig_kategori };
    }

    // "Mindst 1 kr" afgøres af databasen (rediger_auktion), som kun tjekker
    // det, når startprisen ændres - så en gammel auktion med startpris 0 kan
    // få rettet titel/billeder.
    const prisFejl = valideStartpris(input.startpris);
    if (prisFejl && !(prisFejl === STARTPRIS_FOR_LAV && input.startpris === 0)) {
      return { fejl: prisFejl };
    }

    if (
      !Array.isArray(input.billeder) ||
      input.billeder.length < 1 ||
      input.billeder.length > MAKS_BILLEDER ||
      !input.billeder.every((b) => typeof b === "string" && b.length <= 1000)
    ) {
      return { fejl: REDIGER_FEJL.ugyldige_billeder };
    }

    if (input.stand !== null && !erStand(input.stand)) return { fejl: REDIGER_FEJL.ugyldig_stand };

    // Forbudte varer afgøres af databasen (rediger_auktion), som kun tjekker
    // ordene, når titel eller beskrivelse er ændret - så en gammel auktion kan
    // få rettet pris/billeder. Svaret 'forbudt_vare' håndteres herunder.

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    // Billederne før redigeringen (kun egen auktion), så de billeder, der
    // fjernes, kan slettes fra storage bagefter.
    const { data: foer } = await supabase
      .from("auctions")
      .select("billeder")
      .eq("id", auktionId)
      .eq("bruger_id", user.id)
      .maybeSingle<{ billeder: string[] | null }>();

    const { data, error } = await supabase.rpc("rediger_auktion", {
      p_auktion: auktionId,
      p_titel: titel,
      p_beskrivelse: beskrivelse,
      p_billeder: input.billeder,
      p_kategori: input.kategori,
      p_startpris: input.startpris,
      p_forsendelse_mulig: input.forsendelseMulig === true,
      p_stand: input.stand,
    });
    if (error) {
      if (erAuktionLaastFejl(error)) return { fejl: LAAST };
      console.error("rediger_auktion fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const svar = data as { kode?: string; ord?: string; kategori?: string } | null;
    const kode = svar?.kode;
    if (kode === "forbudt_vare") {
      return { fejl: forbudtBesked(svar?.ord ?? "", svar?.kategori ?? "") };
    }
    if (kode !== "ok") return { fejl: (kode && REDIGER_FEJL[kode]) || GENERISK };

    // rediger_auktion lykkes kun på brugerens egen aktive auktion uden bud
    // (og dermed uden handel), så de fjernede billeder er ikke længere i brug
    // på denne auktion og må slettes.
    const fjernede = (foer?.billeder ?? []).filter((url) => !input.billeder.includes(url));
    if (fjernede.length > 0) {
      const brugerId = user.id;
      after(() => sletFjernedeBilleder(brugerId, auktionId, fjernede));
    }

    revalidatePath(`/auktion/${auktionId}`);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    console.error("redigerAuktion fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Sletter billeder, sælgeren har fjernet ved redigering. Kun filer i
// brugerens egen mappe i auktion-billeder, og kun hvis ingen af brugerens
// auktioner (fx en genopsat vare) stadig bruger dem - sammenlignet på
// storage-stien, ikke den præcise URL. Slettes aldrig, mens der er en åben
// DSA-anmeldelse (ny eller videresendt) eller en åben rapport om auktionen:
// billederne kan være bevis. Service role, fordi storage-policyen ikke lader
// brugeren slette - ejeren er tjekket af rediger_auktion. Kaster aldrig.
const BILLEDE_STI = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,100}\.[a-z0-9]{1,5}$/;
const BILLEDE_MARKOER = "/storage/v1/object/public/auktion-billeder/";

function billedeSti(url: string): string | null {
  const i = url.indexOf(BILLEDE_MARKOER);
  if (i < 0) return null;
  try {
    return decodeURIComponent(url.slice(i + BILLEDE_MARKOER.length).split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
}

async function sletFjernedeBilleder(brugerId: string, auktionId: string, urls: string[]) {
  try {
    const admin = createAdminClient();
    const kandidater = urls
      .map(billedeSti)
      .filter((sti): sti is string => !!sti && BILLEDE_STI.test(sti) && sti.startsWith(`${brugerId.toLowerCase()}/`));
    if (kandidater.length === 0) return;

    // Åben sag om auktionen: behold alt.
    const [anm, rap] = await Promise.all([
      admin
        .from("dsa_anmeldelser")
        .select("id")
        .eq("status", "ny")
        .or(`auktion_id.eq.${auktionId},and(indhold_type.eq.auktion,indhold_id.eq.${auktionId})`)
        .limit(1),
      admin
        .from("reports")
        .select("id")
        .eq("auction_id", auktionId)
        .in("status", ["pending", "under_behandling"])
        .limit(1),
    ]);
    if (anm.error || rap.error) throw new Error(anm.error?.message ?? rap.error?.message);
    if ((anm.data?.length ?? 0) > 0 || (rap.data?.length ?? 0) > 0) return;

    // Billederne ligger i brugerens egen mappe og kan kun bruges af
    // brugerens egne auktioner (auktion_billeder_gyldige).
    const { data: auktioner, error } = await admin
      .from("auctions")
      .select("billeder")
      .eq("bruger_id", brugerId)
      .limit(5000);
    if (error) throw new Error(error.message);
    const iBrug = new Set<string>();
    for (const a of (auktioner ?? []) as { billeder: string[] | null }[]) {
      for (const url of a.billeder ?? []) {
        const sti = billedeSti(url);
        if (sti) iBrug.add(sti);
      }
    }

    const stier = [...new Set(kandidater)].filter((sti) => !iBrug.has(sti));
    if (stier.length === 0) return;
    const { error: sletFejl } = await admin.storage.from("auktion-billeder").remove(stier);
    if (sletFejl) throw sletFejl;
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "redigerAuktion: slet fjernede billeder", fejl: err });
  }
}

export async function annullerAuktion(auktionId: string): Promise<{ ok: true } | Fejl> {
  try {
    if (typeof auktionId !== "string" || !UUID.test(auktionId)) {
      return { fejl: "Auktionen findes ikke." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    // Idempotent i databasen: ejer, status og "ingen bud" tjekkes i samme update.
    const { data, error } = await supabase.rpc("annuller_egen_auktion", {
      p_auktion: auktionId,
    });
    if (error) {
      // Der er budt: auktionen er låst (databasen afviser med auktion_laast).
      if (erAuktionLaastFejl(error)) return { fejl: LAAST };
      console.error("annuller_egen_auktion fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    if (data !== true) {
      // Allerede annulleret (dobbeltklik) tæller som gennemført.
      const { data: a } = await supabase
        .from("auctions")
        .select("status, bruger_id, skjult, pauset_kl")
        .eq("id", auktionId)
        .maybeSingle<{ status: string; bruger_id: string; skjult: boolean | null; pauset_kl: string | null }>();
      if (a && a.bruger_id === user.id && a.status === "annulleret") return { ok: true };
      return {
        fejl:
          a?.bruger_id !== user.id
            ? "Auktionen findes ikke."
            : a.skjult
              ? "Auktionen er skjult af BidHamr og kan ikke annulleres lige nu."
              : a.pauset_kl
                ? "Auktionen er sat på pause af BidHamr og kan ikke annulleres lige nu."
                : "Auktionen kan ikke annulleres længere, fordi den er slut.",
      };
    }

    revalidatePath(`/auktion/${auktionId}`);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    console.error("annullerAuktion fejlede:", err);
    return { fejl: GENERISK };
  }
}

// "Sæt varen op igen" med ét klik: en auktion, som BidHamr har fjernet eller
// stoppet (og hvor afgørelsen er ophævet), eller som blev annulleret
// automatisk efter 14 dages pause. En annulleret auktion genåbnes aldrig
// (Filip, 6. okt. 2026) - der oprettes en ny auktion med samme indhold,
// startpris og varighed. Databasen (saet_annulleret_op_igen) tjekker ejer,
// konto, udbetalingskonto, åben klage, gældende fjernelse og forbudte ord.
const SAET_OP_IGEN_FEJL: Record<string, string> = {
  ikke_fundet: "Auktionen findes ikke.",
  ikke_saelger: "Auktionen findes ikke.",
  ikke_annulleret: "Auktionen er ikke annulleret og kan ikke sættes op igen herfra.",
  allerede_genopsat: "Varen er allerede sat op igen.",
  klage_afventer: "Din klage er ikke afgjort endnu. Vent på svaret, før du sætter varen op igen.",
  fjernet: "Auktionen er fjernet af BidHamr. Overholder varen vores regler, kan du oprette en ny auktion.",
  ikke_bidhamr: "Opret en ny auktion for at sætte varen til salg igen.",
  konto_lukket: "Din konto er lukket.",
  suspenderet: "Din konto er suspenderet, og du kan ikke sætte varer op.",
  mangler_udbetalingskonto: "Du skal oprette en udbetalingskonto, før du kan sætte varer til salg.",
};

export async function saetVarenOpIgen(auktionId: string): Promise<{ ok: true; auktionId: string } | Fejl> {
  try {
    if (typeof auktionId !== "string" || !UUID.test(auktionId)) {
      return { fejl: SAET_OP_IGEN_FEJL.ikke_fundet };
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Log ind for at sætte varen op igen." };

    const { data, error } = await createAdminClient().rpc("saet_annulleret_op_igen", {
      p_auction: auktionId,
      p_seller: user.id,
    });
    if (error) {
      if (error.code === "23505") return { fejl: SAET_OP_IGEN_FEJL.allerede_genopsat };
      console.error("saet_annulleret_op_igen fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const r = data as { kode?: string; auction_id?: string; ord?: string; kategori?: string } | null;
    if (r?.kode === "forbudt_vare") return { fejl: forbudtBesked(r.ord ?? "", r.kategori ?? "") };
    if (r?.kode !== "ok" || !r.auction_id) return { fejl: SAET_OP_IGEN_FEJL[r?.kode ?? ""] ?? GENERISK };

    revalidatePath("/");
    revalidatePath(`/auktion/${auktionId}`);
    return { ok: true, auktionId: r.auction_id };
  } catch (err) {
    console.error("saetVarenOpIgen fejlede:", err);
    return { fejl: GENERISK };
  }
}
