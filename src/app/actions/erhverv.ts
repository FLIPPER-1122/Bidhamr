"use server";

// Erhverv - offentlige og firmaets egne handlinger.
//  - sendErhvervHenvendelse: formularen på /erhverv (også uden login).
//    Gemmes med service role (ingen browser-adgang til tabellen) efter
//    honeypot, tidsfælde og rate limits pr. IP, e-mail, CVR, bruger og samlet
//    (som kontaktformularen). IP gemmes kun som HMAC (ip_hash).
//  - hentFirmaOversigt / skiftFirmaPakke: Firma oversigt for en firmakonto.
//    Databasen (firma_oversigt, firma_skift_pakke) tjekker selv, at brugeren
//    er en firmakonto - samme RPC'er bruges af appen.
// Fejl RETURNERES som { fejl } med dansk tekst.

import { createHmac } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { hemmeligNoegle } from "@/lib/supabase/noeglerServer";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import {
  EMAIL,
  ERHVERV_EMAIL,
  ERHVERV_GRAENSER as G,
  POSTNUMMER,
  erhvervFejlTekst,
  renCvr,
  renTelefon,
  type ErhvervPakke,
  type FirmaOversigt,
} from "@/lib/erhverv/regler";
import { startNedgradering, startOpgradering } from "@/lib/erhverv/betaling";
import { revalidatePath } from "next/cache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Udfyldes formularen hurtigere end dette, er det næsten altid en robot.
const MIN_SEKUNDER = 5;
const GENERISK = `Noget gik galt. Prøv igen om lidt, eller skriv til ${ERHVERV_EMAIL}.`;

function felt(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
}

// Fritekst: bevar linjeskift, men fjern overflødige blanke linjer.
function fritekst(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
}

function ipHash(ip: string): string {
  return createHmac("sha256", `erhverv-ip|${hemmeligNoegle()}`).update(ip).digest("hex");
}

// Felter i formularen (name-attributter): firmanavn, cvr, kontaktperson,
// telefon, email, adresse, postnummer, by, hvad_saelger_i, antal_varer_ca,
// besked. Skjulte felter: "hjemmeside" (honeypot) og "t" (Date.now(), da
// formularen blev vist).
export async function sendErhvervHenvendelse(
  formData: FormData,
): Promise<{ ok: true } | { fejl: string; felt?: string }> {
  try {
    // Honeypot: robotten får "ok", så den ikke prøver igen.
    if (felt(formData, "hjemmeside") !== "") return { ok: true };

    const firmanavn = felt(formData, "firmanavn");
    const cvr = renCvr(felt(formData, "cvr"));
    const kontaktperson = felt(formData, "kontaktperson");
    const telefon = renTelefon(felt(formData, "telefon"));
    const email = felt(formData, "email").toLowerCase();
    const adresse = felt(formData, "adresse");
    const postnummer = felt(formData, "postnummer");
    const by = felt(formData, "by");
    const hvad = fritekst(formData, "hvad_saelger_i");
    const antalRaa = felt(formData, "antal_varer_ca").replace(/[.\s]/g, "");
    const besked = fritekst(formData, "besked");

    if (!firmanavn || firmanavn.length > G.firmanavn) return { fejl: "Skriv firmaets navn.", felt: "firmanavn" };
    if (!cvr) return { fejl: "Skriv et CVR-nummer med 8 cifre.", felt: "cvr" };
    if (!kontaktperson || kontaktperson.length > G.kontaktperson) {
      return { fejl: "Skriv navnet på kontaktpersonen.", felt: "kontaktperson" };
    }
    if (!telefon) return { fejl: "Skriv et telefonnummer, vi kan ringe på.", felt: "telefon" };
    if (!EMAIL.test(email) || email.length > G.email) {
      return { fejl: "Skriv en gyldig e-mailadresse.", felt: "email" };
    }
    if (adresse.length > G.adresse) return { fejl: "Adressen er for lang.", felt: "adresse" };
    if (postnummer && !POSTNUMMER.test(postnummer)) return { fejl: "Postnummeret skal have 4 cifre.", felt: "postnummer" };
    if (by.length > G.by) return { fejl: "Bynavnet er for langt.", felt: "by" };
    if (hvad.length < 3) return { fejl: "Skriv kort, hvad I sælger.", felt: "hvad_saelger_i" };
    if (hvad.length > G.hvadSaelgerI) {
      return { fejl: `Højst ${G.hvadSaelgerI.toLocaleString("da-DK")} tegn om, hvad I sælger.`, felt: "hvad_saelger_i" };
    }
    let antal: number | null = null;
    if (antalRaa) {
      if (!/^\d{1,8}$/.test(antalRaa) || Number(antalRaa) > G.antalVarerMaks) {
        return { fejl: "Skriv antallet af varer som et tal.", felt: "antal_varer_ca" };
      }
      antal = Number(antalRaa);
    }
    if (besked.length > G.besked) {
      return { fejl: `Beskeden må højst være ${G.besked.toLocaleString("da-DK")} tegn.`, felt: "besked" };
    }

    // Tidsfælde: mangler feltet, behandles det som for hurtigt.
    const raa = formData.get("t");
    const start = typeof raa === "string" && /^\d{1,16}$/.test(raa) ? Number(raa) : NaN;
    if (!Number.isFinite(start) || start <= 0 || Date.now() - start < MIN_SEKUNDER * 1000) {
      return { fejl: "Vent et øjeblik, og prøv igen." };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);

    const ip = await klientIp();
    const graenser: Parameters<typeof tjekGraenser>[0] = [
      ["erhverv_ip", ip],
      ["erhverv_email", email],
      ["erhverv_cvr", cvr],
      ["erhverv_alle", "alle"],
    ];
    if (user) graenser.push(["erhverv_bruger", user.id]);
    if (!(await tjekGraenser(graenser))) return { fejl: FOR_MANGE_FORSOEG };

    const { error } = await createAdminClient().from("erhverv_henvendelser").insert({
      firmanavn,
      cvr,
      kontaktperson,
      telefon,
      email,
      adresse: adresse || null,
      postnummer: postnummer || null,
      bynavn: by || null,
      hvad_saelger_i: hvad,
      antal_varer_ca: antal,
      besked: besked || null,
      bruger_id: user?.id ?? null,
      ip_hash: ip && ip !== "ukendt" ? ipHash(ip) : null,
    });
    if (error) {
      await logDriftFejl({ kilde: "action", hvor: "sendErhvervHenvendelse", fejl: error });
      return { fejl: GENERISK };
    }
    return { ok: true };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sendErhvervHenvendelse", fejl: err });
    return { fejl: GENERISK };
  }
}

// Firma oversigt (dashboard). null = brugeren er ikke en firmakonto.
export async function hentFirmaOversigt(): Promise<{ ok: true; oversigt: FirmaOversigt | null } | { fejl: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };
    const { data, error } = await supabase.rpc("firma_oversigt");
    if (error) {
      await logDriftFejl({ kilde: "action", hvor: "hentFirmaOversigt", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    return { ok: true, oversigt: (data as FirmaOversigt | null) ?? null };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "hentFirmaOversigt", fejl: err });
    return { fejl: GENERISK };
  }
}

export type SkiftPakkeSvar =
  | { ok: true; kode: "opgradering_afventer_betaling"; pakke: ErhvervPakke; besked: string }
  | { ok: true; kode: "nedgradering_planlagt"; pakke: ErhvervPakke; gaelderFra: string; besked: string }
  | { ok: true; kode: "uaendret"; besked: string }
  | { fejl: string };

// Firmaet vælger en anden pakke i Firma oversigt.
//  - Større pakke: registreres og venter på betaling (Stripe, på pause) -
//    giver IKKE flere auktioner før betalt (src/lib/erhverv/betaling.ts).
//  - Mindre pakke: gælder fra næste periode.
export async function skiftFirmaPakke(pakkeId: string): Promise<SkiftPakkeSvar> {
  try {
    if (typeof pakkeId !== "string" || !UUID.test(pakkeId)) return { fejl: "Vælg en pakke." };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    const { data, error } = await supabase.rpc("firma_skift_pakke", { p_pakke: pakkeId });
    if (error) {
      const tekst = erhvervFejlTekst(error.message, error.code);
      if (tekst) return { fejl: tekst };
      if (error.code === "BHR01") return { fejl: FOR_MANGE_FORSOEG };
      await logDriftFejl({ kilde: "action", hvor: "skiftFirmaPakke", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const svar = data as { kode?: string; skift_id?: string; gaelder_fra?: string; pakke?: ErhvervPakke } | null;
    revalidatePath("/firma");

    if (svar?.kode === "opgradering_afventer_betaling" && svar.pakke && svar.skift_id) {
      const betaling = await startOpgradering(svar.skift_id);
      return {
        ok: true,
        kode: "opgradering_afventer_betaling",
        pakke: svar.pakke,
        besked:
          betaling.status === "afventer_betaling"
            ? betaling.besked
            : `Jeres pakke er nu ${svar.pakke.navn}.`,
      };
    }
    if (svar?.kode === "nedgradering_planlagt" && svar.pakke && svar.gaelder_fra && svar.skift_id) {
      await startNedgradering(svar.skift_id);
      const dato = new Date(svar.gaelder_fra).toLocaleDateString("da-DK", {
        timeZone: "Europe/Copenhagen",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      return {
        ok: true,
        kode: "nedgradering_planlagt",
        pakke: svar.pakke,
        gaelderFra: svar.gaelder_fra,
        besked: `I skifter til ${svar.pakke.navn} den ${dato}. Indtil da beholder I jeres nuværende pakke.`,
      };
    }
    if (svar?.kode === "uaendret") return { ok: true, kode: "uaendret", besked: "I beholder jeres nuværende pakke." };
    if (svar?.kode === "ugyldig_pakke") return { fejl: "Pakken findes ikke længere. Vælg en anden." };
    return { fejl: GENERISK };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "skiftFirmaPakke", fejl: err });
    return { fejl: GENERISK };
  }
}
