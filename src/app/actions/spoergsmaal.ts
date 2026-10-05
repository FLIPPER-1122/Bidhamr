"use server";

// "Spørg sælger" (ROADMAP.md fase 3). Alle kald går til databasefunktioner,
// der udleder brugeren af auth.uid() (stil_spoergsmaal, besvar_spoergsmaal,
// saet_spoergsmaal_aktiv). Staff skjuler via skjul_spoergsmaal
// (service_role), efter rollen er tjekket her. Fejl RETURNERES.

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertRole } from "@/lib/adminAuth";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { KONTAKTINFO_FEJL } from "@/lib/kontaktInfo";
import { MAKS_SPOERGSMAAL, MAKS_SVAR, MIN_SPOERGSMAAL } from "@/lib/spoergsmaal";
import { notificerNytSpoergsmaal, notificerSvar } from "@/lib/notifikationer/spoergsmaal";

type Fejl = { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  suspenderet: "Din konto er suspenderet, og du kan ikke stille eller besvare spørgsmål.",
  konto_lukket: "Din konto er lukket.",
  ikke_fundet: "Auktionen findes ikke.",
  egen_auktion: "Du kan ikke stille spørgsmål til din egen auktion.",
  ikke_aktiv: "Auktionen er slut, så der kan ikke stilles eller besvares spørgsmål længere.",
  slaaet_fra: "Sælgeren modtager ikke spørgsmål – læs beskrivelsen grundigt.",
  blokeret: "Du kan ikke stille spørgsmål til denne sælger.",
  ugyldig_tekst: `Spørgsmålet skal være mellem ${MIN_SPOERGSMAAL} og ${MAKS_SPOERGSMAAL} tegn.`,
  kontaktinfo: KONTAKTINFO_FEJL,
  for_mange: "Du har stillet mange spørgsmål på kort tid. Vent lidt, og prøv igen.",
  for_mange_ubesvarede:
    "Du har allerede 3 ubesvarede spørgsmål til denne auktion. Vent på, at sælgeren svarer.",
  allerede_besvaret: "Spørgsmålet er allerede besvaret.",
  skjult: "Spørgsmålet er skjult af BidHamr og kan ikke besvares.",
};

function tjekUuid(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

export async function stilSpoergsmaal(
  auktionId: string,
  tekst: string,
): Promise<{ ok: true } | Fejl> {
  try {
    if (!tjekUuid(auktionId)) return { fejl: FEJL.ikke_fundet };
    const t = typeof tekst === "string" ? tekst.trim() : "";
    if (t.length < MIN_SPOERGSMAAL || t.length > MAKS_SPOERGSMAAL) return { fejl: FEJL.ugyldig_tekst };
    // Kontaktoplysninger afgøres af databasen (indeholder_kontaktinfo).

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: FEJL.ikke_logget_ind };

    if (!(await tjekGraenser([["spoergsmaal_ip", await klientIp()]]))) {
      return { fejl: FOR_MANGE_FORSOEG };
    }

    const { data, error } = await supabase.rpc("stil_spoergsmaal", {
      p_auktion: auktionId,
      p_tekst: t,
    });
    if (error) {
      console.error("stil_spoergsmaal fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const svar = data as { kode?: string; id?: string; dublet?: boolean } | null;
    if (svar?.kode !== "ok" || !svar.id) {
      return { fejl: (svar?.kode && FEJL[svar.kode]) || GENERISK };
    }

    const id = svar.id;
    if (!svar.dublet) after(() => notificerNytSpoergsmaal(id));
    revalidatePath(`/auktion/${auktionId}`);
    return { ok: true };
  } catch (err) {
    console.error("stilSpoergsmaal fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function besvarSpoergsmaal(
  auktionId: string,
  spoergsmaalId: string,
  svarTekst: string,
): Promise<{ ok: true } | Fejl> {
  try {
    if (!tjekUuid(auktionId) || !tjekUuid(spoergsmaalId)) return { fejl: "Spørgsmålet findes ikke." };
    const t = typeof svarTekst === "string" ? svarTekst.trim() : "";
    if (t.length < 1 || t.length > MAKS_SVAR) {
      return { fejl: `Svaret skal være mellem 1 og ${MAKS_SVAR} tegn.` };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("besvar_spoergsmaal", {
      p_spoergsmaal: spoergsmaalId,
      p_svar: t,
    });
    if (error) {
      console.error("besvar_spoergsmaal fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") {
      if (kode === "ugyldig_tekst") return { fejl: `Svaret skal være mellem 1 og ${MAKS_SVAR} tegn.` };
      if (kode === "ikke_fundet") return { fejl: "Spørgsmålet findes ikke." };
      return { fejl: (kode && FEJL[kode]) || GENERISK };
    }

    after(() => notificerSvar(spoergsmaalId));
    revalidatePath(`/auktion/${auktionId}`);
    return { ok: true };
  } catch (err) {
    console.error("besvarSpoergsmaal fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function saetSpoergsmaalAktiv(
  auktionId: string,
  aktiv: boolean,
): Promise<{ ok: true; aktiv: boolean } | Fejl> {
  try {
    if (!tjekUuid(auktionId)) return { fejl: FEJL.ikke_fundet };
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { fejl: FEJL.ikke_logget_ind };

    const { data, error } = await supabase.rpc("saet_spoergsmaal_aktiv", {
      p_auktion: auktionId,
      p_aktiv: aktiv === true,
    });
    if (error) {
      console.error("saet_spoergsmaal_aktiv fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const svar = data as { kode?: string; aktiv?: boolean } | null;
    if (svar?.kode !== "ok") {
      if (svar?.kode === "ikke_aktiv") return { fejl: "Auktionen er slut og kan ikke ændres." };
      return { fejl: (svar?.kode && FEJL[svar.kode]) || GENERISK };
    }
    revalidatePath(`/auktion/${auktionId}`);
    return { ok: true, aktiv: svar.aktiv === true };
  } catch (err) {
    console.error("saetSpoergsmaalAktiv fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Staff (medarbejder og op) skjuler eller viser et spørgsmål. Begrundelse
// kræves ved skjul og logges i medarbejder-loggen.
export async function skjulSpoergsmaal(
  auktionId: string,
  spoergsmaalId: string,
  skjul: boolean,
  aarsag: string,
): Promise<{ ok: true } | Fejl> {
  try {
    if (!tjekUuid(auktionId) || !tjekUuid(spoergsmaalId)) return { fejl: "Spørgsmålet findes ikke." };
    const grund = typeof aarsag === "string" ? aarsag.trim() : "";
    if (skjul && !grund) return { fejl: "Skriv en begrundelse." };
    if (grund.length > 500) return { fejl: "Begrundelsen må højst være 500 tegn." };

    let adgang;
    try {
      adgang = await assertRole("medarbejder");
    } catch {
      return { fejl: "Du har ikke adgang til at gøre dette." };
    }

    const { data, error } = await adgang.admin.rpc("skjul_spoergsmaal", {
      p_medarbejder: adgang.userId,
      p_spoergsmaal: spoergsmaalId,
      p_skjul: skjul === true,
      p_aarsag: grund || null,
    });
    if (error) {
      console.error("skjul_spoergsmaal fejlede:", error.code, error.message);
      return { fejl: GENERISK };
    }
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok" && kode !== "uaendret") {
      return {
        fejl:
          kode === "ingen_adgang"
            ? "Du har ikke adgang til at gøre dette."
            : kode === "begrundelse_mangler"
              ? "Skriv en begrundelse."
              : kode === "ikke_fundet"
                ? "Spørgsmålet findes ikke."
                : GENERISK,
      };
    }
    revalidatePath(`/auktion/${auktionId}`);
    return { ok: true };
  } catch (err) {
    console.error("skjulSpoergsmaal fejlede:", err);
    return { fejl: GENERISK };
  }
}
