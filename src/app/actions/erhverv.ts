"use server";

// Erhverv - offentlige og firmaets egne handlinger.
//  - sendErhvervHenvendelse: formularen på /erhverv (også uden login).
//    Gemmes med service role (ingen browser-adgang til tabellen) efter
//    honeypot, tidsfælde og rate limits pr. IP, e-mail, CVR, bruger og samlet
//    (som kontaktformularen). IP-adressen bruges kun til rate limit og
//    gemmes ikke (kolonnen ip_hash er altid null).
//  - hentFirmaOversigt / skiftFirmaPakke: Firma oversigt for en firmakonto.
//    Databasen (firma_oversigt, firma_skift_pakke_server) tjekker selv, at
//    brugeren er en firmakonto. Pakkeskift kan KUN ske via serveren (appen:
//    POST /api/firma/skift-pakke), fordi Stripe også skal ændres.
// Fejl RETURNERES som { fejl } med dansk tekst.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import {
  EMAIL,
  ERHVERV_EMAIL,
  ERHVERV_GRAENSER as G,
  POSTNUMMER,
  renCvr,
  renTelefon,
  type FirmaOversigt,
} from "@/lib/erhverv/regler";
import { skiftPakkeForBruger, type SkiftPakkeSvar } from "@/lib/erhverv/pakkeskift";
import { ERHVERV_FORMULAR } from "@/lib/tekster/erhverv";
import { revalidatePath } from "next/cache";

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
    if (hvad.length < 3) return { fejl: "Skriv kort, hvad du sælger.", felt: "hvad_saelger_i" };
    if (hvad.length > G.hvadSaelgerI) {
      return { fejl: `Højst ${G.hvadSaelgerI.toLocaleString("da-DK")} tegn om, hvad du sælger.`, felt: "hvad_saelger_i" };
    }
    let antal: number | null = null;
    if (antalRaa) {
      if (!/^\d{1,8}$/.test(antalRaa) || Number(antalRaa) > G.antalVarerMaks) {
        return { fejl: ERHVERV_FORMULAR.fejl.antalUgyldigt, felt: "antal_varer_ca" };
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


export type { SkiftPakkeSvar } from "@/lib/erhverv/pakkeskift";

// Firmaet vælger en anden pakke i Firma oversigt (hjemmesiden, via
// /api/offentlig/firma-skift-pakke). Al logik - database, Stripe og
// tilbagerulning ved Stripe-fejl - ligger i src/lib/erhverv/pakkeskift.ts,
// som appen også bruger (POST /api/firma/skift-pakke).
//  - Større pakke: Stripe trækker forskellen for resten af perioden med det
//    samme (faktura). Først når den er betalt, får firmaet flere auktioner.
//  - Mindre pakke: gælder fra næste periode (Subscription Schedule).
export async function skiftFirmaPakke(pakkeId: string): Promise<SkiftPakkeSvar> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };
    const svar = await skiftPakkeForBruger(user.id, pakkeId);
    revalidatePath("/firma");
    return svar;
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "skiftFirmaPakke", fejl: err });
    return { fejl: GENERISK };
  }
}

// "Vi bruger brugtmomsordningen" (Firmaoplysninger). Kaldes via
// /api/offentlig/firma-brugtmoms. firma_saet_brugtmoms afviser alle andre
// end firmakontoen selv (auth.uid()). Bestemmer kun, om momsen vises i
// oplysningerne til firmaets egen faktura på varen.
export async function saetFirmaBrugtmoms(
  til: boolean,
): Promise<{ ok: true; brugtmoms: boolean } | { fejl: string }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };
    const { data, error } = await supabase.rpc("firma_saet_brugtmoms", { p_til: til });
    if (error) {
      if (error.code === "42501") return { fejl: "Kun firmakonti kan ændre dette." };
      await logDriftFejl({ kilde: "action", hvor: "saetFirmaBrugtmoms", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    revalidatePath("/firma", "layout");
    return { ok: true, brugtmoms: data === true };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "saetFirmaBrugtmoms", fejl: err });
    return { fejl: GENERISK };
  }
}
