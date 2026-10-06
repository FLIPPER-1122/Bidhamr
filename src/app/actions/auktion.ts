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
import { getUserMedToTrin } from "@/lib/mfa";
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
} from "@/lib/auktionRegler";
import { erStand } from "@/lib/stand";
import { forbudtBesked } from "@/lib/forbudteVarer";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAAST = "Auktionen kan ikke ændres, når der er budt på den.";

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
    } = await getUserMedToTrin(supabase);
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
      after(() => sletFjernedeBilleder(brugerId, fjernede));
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
// brugerens egen mappe i auktion-billeder, og kun hvis ingen auktion (heller
// ikke en anden af brugerens egne, fx en genopsat vare) stadig bruger dem.
// Service role, fordi storage-policyen ikke lader brugeren slette - ejeren er
// tjekket af rediger_auktion. Kaster aldrig.
const BILLEDE_STI = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,100}\.[a-z0-9]{1,5}$/;
async function sletFjernedeBilleder(brugerId: string, urls: string[]) {
  try {
    const markoer = "/storage/v1/object/public/auktion-billeder/";
    const admin = createAdminClient();
    const stier: string[] = [];
    for (const url of urls) {
      const i = url.indexOf(markoer);
      if (i < 0) continue;
      const sti = decodeURIComponent(url.slice(i + markoer.length).split("?")[0]);
      if (!BILLEDE_STI.test(sti) || !sti.startsWith(`${brugerId.toLowerCase()}/`)) continue;
      const { data: iBrug, error } = await admin
        .from("auctions")
        .select("id")
        .contains("billeder", [url])
        .limit(1);
      if (error || (iBrug && iBrug.length > 0)) continue;
      stier.push(sti);
    }
    if (stier.length === 0) return;
    const { error } = await admin.storage.from("auktion-billeder").remove(stier);
    if (error) throw error;
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
    } = await getUserMedToTrin(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    // Idempotent i databasen: ejer, status og "ingen bud" tjekkes i samme update.
    const { data, error } = await supabase.rpc("annuller_egen_auktion", {
      p_auktion: auktionId,
    });
    if (error) {
      console.error("annuller_egen_auktion fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    if (data !== true) {
      // Allerede annulleret (dobbeltklik) tæller som gennemført.
      const { data: a } = await supabase
        .from("auctions")
        .select("status, bruger_id")
        .eq("id", auktionId)
        .maybeSingle<{ status: string; bruger_id: string }>();
      if (a && a.bruger_id === user.id && a.status === "annulleret") return { ok: true };
      return {
        fejl:
          a?.bruger_id === user.id
            ? "Auktionen kan ikke annulleres længere – der er budt på den, eller den er slut."
            : "Auktionen findes ikke.",
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
