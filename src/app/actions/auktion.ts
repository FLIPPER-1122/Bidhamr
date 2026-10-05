"use server";

// Sælgeren redigerer eller annullerer sin egen auktion – kun så længe der
// ikke er bud (ROADMAP-BESLUTNINGER.md, "Midlertidige beslutninger",
// 4. oktober 2026).
//
// Begge kald sker med brugerens egen session. Databasefunktionerne udleder
// brugeren af auth.uid() og låser auktionsrækken, så et samtidigt bud ikke
// kan smutte ind under en redigering. Annullerede auktioner arkiveres
// (status 'annulleret') og slettes aldrig. Fejl RETURNERES.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { kategorier } from "@/lib/kategorier";
import {
  MAKS_BESKRIVELSE,
  MAKS_BILLEDER,
  MAKS_TITEL,
  valideStartpris,
  STARTPRIS_FOR_LAV,
} from "@/lib/auktionRegler";

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
};

export type RedigerAuktionInput = {
  titel: string;
  beskrivelse: string | null;
  billeder: string[];
  kategori: string;
  startpris: number;
  forsendelseMulig: boolean;
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

    const prisFejl = valideStartpris(input.startpris);
    if (prisFejl) return { fejl: prisFejl };

    if (
      !Array.isArray(input.billeder) ||
      input.billeder.length < 1 ||
      input.billeder.length > MAKS_BILLEDER ||
      !input.billeder.every((b) => typeof b === "string" && b.length <= 1000)
    ) {
      return { fejl: REDIGER_FEJL.ugyldige_billeder };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: "Du skal være logget ind." };

    const { data, error } = await supabase.rpc("rediger_auktion", {
      p_auktion: auktionId,
      p_titel: titel,
      p_beskrivelse: beskrivelse,
      p_billeder: input.billeder,
      p_kategori: input.kategori,
      p_startpris: input.startpris,
      p_forsendelse_mulig: input.forsendelseMulig === true,
    });
    if (error) {
      console.error("rediger_auktion fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") return { fejl: (kode && REDIGER_FEJL[kode]) || GENERISK };

    revalidatePath(`/auktion/${auktionId}`);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    console.error("redigerAuktion fejlede:", err);
    return { fejl: GENERISK };
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
    } = await supabase.auth.getUser();
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
