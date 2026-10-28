"use server";

// Fakturaer fra firma til køber - firmaets egne handlinger og købers
// firmanavn/CVR. Alle tjekker login og kalder databasen med BRUGERENS klient,
// så auth.uid() afgør adgangen (firma_faktura_* afviser alle andre end
// firmakontoen selv). Fejl RETURNERES som { fejl } med dansk tekst.
//
// INTET SENDES AUTOMATISK: sendFirmaFaktura er den eneste vej til en sendt
// faktura, og den kaldes kun fra knappen "Send" (efter bekræftelse) i Firma
// oversigt. Den bruges ikke af cron, webhooks eller appen.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { indenForGraense, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { hentSendtRaekke, sendFakturaMail, sendFakturaMailLaast } from "@/lib/erhverv/firmaFakturaServer";
import {
  EMAIL_FAKTURA,
  MANGLER_TEKST,
  PRAEFIKS,
  fakturaTalStemmer,
  renTekst,
  type FirmaFakturaData,
  type ManglerKode,
} from "@/lib/erhverv/firmaFaktura";

const GENERISK = "Det lykkedes ikke. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function bruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return { supabase, user };
}

function genopfrisk() {
  revalidatePath("/firma/fakturaer", "layout");
  revalidatePath("/firma/salg");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
export type SendSvar =
  | { ok: true; fakturanummer: string; modtager: string; mailSendt: boolean; alleredeSendt: boolean }
  | { fejl: string; mangler?: string[] };

const MANGLER_FEJL = "Fakturaen kan ikke sendes endnu. Udfyld de manglende oplysninger.";

export async function sendFirmaFaktura(id: string): Promise<SendSvar> {
  try {
    if (typeof id !== "string" || !UUID.test(id)) return { fejl: "Fakturaen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_send", user.id))) return { fejl: FOR_MANGE_FORSOEG };

    const { data, error } = await supabase.rpc("firma_faktura_send", { p_id: id });
    if (error) {
      if (error.code === "42501") return { fejl: "Kun firmaet selv kan sende sine fakturaer." };
      if (error.code === "22023") return { fejl: "Fakturaen kan ikke sendes endnu." };
      // Manglerne tjekkes igen efter låsen; databasen har rullet alt tilbage
      // (intet nummer brugt).
      if (error.code === "BHF12") {
        let koder: ManglerKode[] = [];
        try {
          koder = JSON.parse(error.message.replace(/^.*?mangler_efter_laas:\s*/, "")) as ManglerKode[];
        } catch {
          koder = [];
        }
        return { fejl: MANGLER_FEJL, mangler: koder.map((k) => MANGLER_TEKST[k] ?? k) };
      }
      await logDriftFejl({ kilde: "action", hvor: "sendFirmaFaktura", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const svar = data as { kode: string; fakturanummer?: string; mangler?: ManglerKode[]; data?: FirmaFakturaData };
    if (svar.kode === "mangler") {
      return {
        fejl: MANGLER_FEJL,
        mangler: (svar.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k),
      };
    }
    const modtager = svar.data?.koeber.email ?? "";
    const alleredeSendt = svar.kode === "allerede_sendt";
    if (svar.data && !fakturaTalStemmer(svar.data)) {
      // Bør aldrig ske (samme regel i databasen og koden) - men sig det.
      await logDriftFejl({ kilde: "action", hvor: "sendFirmaFaktura/tal", fejl: new Error(`Momstal stemmer ikke for ${id}`), brugerId: user.id });
    }
    genopfrisk();
    // Et dobbeltklik giver ikke to mails: mailen sendes kun ved den første.
    if (alleredeSendt) return { ok: true, fakturanummer: svar.fakturanummer ?? "", modtager, mailSendt: true, alleredeSendt };
    const raekke = await hentSendtRaekke(id);
    const mailSendt = raekke ? await sendFakturaMail(raekke) : false;
    genopfrisk();
    return { ok: true, fakturanummer: svar.fakturanummer ?? "", modtager, mailSendt, alleredeSendt };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sendFirmaFaktura", fejl: err });
    return { fejl: GENERISK };
  }
}

// Fakturaen er udstedt, men mailen fejlede: firmaet trykker selv igen.
export async function sendFirmaFakturaMailIgen(id: string): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (typeof id !== "string" || !UUID.test(id)) return { fejl: "Fakturaen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_mail_igen", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    // Adgang: firma_faktura_hent giver kun firmaets egne.
    const { data, error } = await supabase.rpc("firma_faktura_hent", { p_id: id });
    if (error) {
      await logDriftFejl({ kilde: "action", hvor: "sendFirmaFakturaMailIgen", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const f = data as { status?: string; mail_sendt_kl?: string | null; kun_laes?: boolean } | null;
    if (!f || f.status !== "sendt") return { fejl: "Fakturaen er ikke sendt." };
    if (f.kun_laes) return { fejl: "Firmakontoen er lukket. Download PDF'en, og send den selv." };
    if (f.mail_sendt_kl) return { fejl: "Mailen er allerede sendt til køberen." };
    const raekke = await hentSendtRaekke(id);
    if (!raekke || raekke.saelger_id !== user.id) return { fejl: "Fakturaen findes ikke." };
    if (raekke.mail_sendt_kl) return { fejl: "Mailen er allerede sendt til køberen." };
    // To samtidige tryk: kun det første sender (låsen i databasen).
    const udfald = await sendFakturaMailLaast(raekke);
    genopfrisk();
    if (udfald === "sendt") return { ok: true };
    if (udfald === "i_gang") return { fejl: "Mailen er ved at blive sendt. Vent et øjeblik, og genindlæs siden." };
    return { fejl: "Mailen kunne ikke sendes. Download PDF'en, og send den selv, eller prøv igen senere." };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sendFirmaFakturaMailIgen", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Ret kladden
// ---------------------------------------------------------------------------
export type GemKladdeSvar = { ok: true; mangler: string[] } | { fejl: string };

export async function gemFirmaFakturaKladde(_forrige: unknown, form: FormData): Promise<GemKladdeSvar> {
  try {
    const id = form.get("id");
    if (typeof id !== "string" || !UUID.test(id)) return { fejl: "Fakturaen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };

    const postnummer = renTekst(form.get("koeber_postnummer"), 10);
    if (postnummer && !/^[0-9]{4}$/.test(postnummer)) return { fejl: "Postnummeret skal være 4 cifre." };
    const email = renTekst(form.get("koeber_email"), 254);
    if (email && !EMAIL_FAKTURA.test(email)) return { fejl: "Tjek købers e-mail." };
    const cvr = renTekst(form.get("koeber_cvr"), 20)?.replace(/[\s-]/g, "") ?? null;
    if (cvr && !/^[0-9]{8}$/.test(cvr)) return { fejl: "CVR skal være 8 cifre." };
    const lev = renTekst(form.get("leveringsdato"), 10);
    if (lev && !/^\d{4}-\d{2}-\d{2}$/.test(lev)) return { fejl: "Tjek leveringsdatoen." };

    const { data, error } = await supabase.rpc("firma_faktura_kladde_gem", {
      p_id: id,
      p_koeber_navn: renTekst(form.get("koeber_navn"), 200),
      p_koeber_adresse: renTekst(form.get("koeber_adresse"), 200),
      p_koeber_postnummer: postnummer,
      p_koeber_by: renTekst(form.get("koeber_by"), 100),
      p_koeber_email: email,
      p_koeber_firmanavn: renTekst(form.get("koeber_firmanavn"), 200),
      p_koeber_cvr: cvr,
      p_leveringsdato: lev,
      p_varetekst: renTekst(form.get("varetekst"), 300),
    });
    if (error) {
      if (error.code === "BHF10") return { fejl: "Fakturaen er sendt og kan ikke ændres. Lav en kreditnota." };
      if (error.code === "22023") return { fejl: error.message.replace(/^.*?: /, "") || "Tjek felterne." };
      if (error.code === "23514") return { fejl: "Tjek felterne, og prøv igen." };
      if (error.code === "42501") return { fejl: "Fakturaen findes ikke." };
      await logDriftFejl({ kilde: "action", hvor: "gemFirmaFakturaKladde", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    genopfrisk();
    const d = data as FirmaFakturaData | null;
    return { ok: true, mangler: (d?.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k) };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "gemFirmaFakturaKladde", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Kreditnota
// ---------------------------------------------------------------------------
export async function lavFirmaKreditnota(fakturaId: string): Promise<{ ok: true; id: string } | { fejl: string }> {
  try {
    if (typeof fakturaId !== "string" || !UUID.test(fakturaId)) return { fejl: "Fakturaen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    const { data, error } = await supabase.rpc("firma_kreditnota_opret", { p_faktura: fakturaId });
    if (error) {
      if (error.code === "22023") return { fejl: "Der kan kun laves en kreditnota på en sendt faktura." };
      if (error.code === "42501") return { fejl: "Fakturaen findes ikke." };
      await logDriftFejl({ kilde: "action", hvor: "lavFirmaKreditnota", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    genopfrisk();
    return { ok: true, id: String(data) };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "lavFirmaKreditnota", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Momsordning på en kladde (kun mens den er kladde - databasen afviser resten)
// ---------------------------------------------------------------------------
export async function skiftFirmaFakturaMomsordning(
  id: string,
  momsordning: "moms" | "brugtmoms",
): Promise<{ ok: true; mangler: string[] } | { fejl: string }> {
  try {
    if (typeof id !== "string" || !UUID.test(id)) return { fejl: "Fakturaen findes ikke." };
    if (momsordning !== "moms" && momsordning !== "brugtmoms") return { fejl: "Vælg momsordning." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    const { data, error } = await supabase.rpc("firma_faktura_kladde_momsordning", { p_id: id, p_momsordning: momsordning });
    if (error) {
      if (error.code === "BHF10") return { fejl: "Fakturaen er sendt og kan ikke ændres. Lav en kreditnota." };
      if (error.code === "22023") return { fejl: "En kreditnota har altid samme momsordning som fakturaen." };
      if (error.code === "42501") return { fejl: "Fakturaen findes ikke." };
      await logDriftFejl({ kilde: "action", hvor: "skiftFirmaFakturaMomsordning", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    genopfrisk();
    const d = data as FirmaFakturaData | null;
    return { ok: true, mangler: (d?.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k) };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "skiftFirmaFakturaMomsordning", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// "Lav ny faktura" efter en sendt kreditnota (laver kun en KLADDE)
// ---------------------------------------------------------------------------
export async function lavNyFirmaFaktura(tradeId: string): Promise<{ ok: true; id: string } | { fejl: string }> {
  try {
    if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    const { data, error } = await supabase.rpc("firma_faktura_ny", { p_trade: tradeId, p_momsordning: null });
    if (error) {
      if (error.code === "22023") {
        return {
          fejl: /kreditnota_mangler/.test(error.message)
            ? "Send en kreditnota på fakturaen først."
            : "Købet er betalt tilbage eller annulleret. Der skal ikke laves en ny faktura.",
        };
      }
      if (error.code === "42501") return { fejl: "Fakturaen findes ikke." };
      await logDriftFejl({ kilde: "action", hvor: "lavNyFirmaFaktura", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    genopfrisk();
    return { ok: true, id: String(data) };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "lavNyFirmaFaktura", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Indstillinger
// ---------------------------------------------------------------------------
export type IndstillingerSvar = { ok: true } | { fejl: string };

export async function gemFirmaFakturaIndstillinger(_forrige: unknown, form: FormData): Promise<IndstillingerSvar> {
  try {
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    const praefiks = typeof form.get("praefiks") === "string" ? String(form.get("praefiks")).trim() : "";
    if (!PRAEFIKS.test(praefiks)) return { fejl: "Præfikset må højst have 12 tegn: bogstaver, tal og - _ . /" };
    const start = Number(form.get("startnummer"));
    if (!Number.isInteger(start) || start < 1 || start > 99_999_999) return { fejl: "Startnummeret skal være et helt tal fra 1." };
    const cifre = Number(form.get("cifre"));
    if (!Number.isInteger(cifre) || cifre < 1 || cifre > 8) return { fejl: "Vælg antal cifre (1-8)." };
    const moms = form.get("momsordning");
    if (moms !== "moms" && moms !== "brugtmoms") return { fejl: "Vælg momsordning." };
    const tekst = renTekst(form.get("betalingstekst"), 200);
    if (!tekst) return { fejl: "Skriv en betalingstekst, fx \"Betalt via BidHamr\"." };
    const svarEmail = renTekst(form.get("svar_email"), 254);
    if (svarEmail && !EMAIL_FAKTURA.test(svarEmail)) return { fejl: "Tjek e-mailen til svar." };
    const { error } = await supabase.rpc("firma_faktura_indstillinger_gem", {
      p_praefiks: praefiks,
      p_startnummer: start,
      p_cifre: cifre,
      p_momsordning: moms,
      p_betalingstekst: tekst,
      p_svar_email: svarEmail,
      p_vis_logo: form.get("vis_logo") === "on",
    });
    if (error) {
      if (error.code === "BHF11") return { fejl: "Præfiks og nummer kan ikke ændres, når du har sendt en faktura." };
      if (error.code === "42501") return { fejl: "Kun firmakonti kan ændre dette." };
      if (error.code === "23514" || error.code === "22023") return { fejl: "Tjek felterne, og prøv igen." };
      await logDriftFejl({ kilde: "action", hvor: "gemFirmaFakturaIndstillinger", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    genopfrisk();
    revalidatePath("/firma/oplysninger");
    return { ok: true };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "gemFirmaFakturaIndstillinger", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Momsordning pr. auktion (Opret og Redigér auktion for firmaer)
// ---------------------------------------------------------------------------
export async function saetAuktionMomsordning(
  auktionId: string,
  valg: "standard" | "moms" | "brugtmoms",
): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (typeof auktionId !== "string" || !UUID.test(auktionId)) return { fejl: "Auktionen findes ikke." };
    if (valg !== "standard" && valg !== "moms" && valg !== "brugtmoms") return { fejl: "Vælg momsordning." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    const { error } = await supabase.rpc("firma_saet_auktion_momsordning", {
      p_auktion: auktionId,
      p_momsordning: valg === "standard" ? null : valg,
    });
    if (error) {
      if (error.code === "BHM01") return { fejl: "Momsordningen kan ikke ændres, når der er budt, eller varen er solgt." };
      if (error.code === "42501") return { fejl: "Auktionen findes ikke." };
      await logDriftFejl({ kilde: "action", hvor: "saetAuktionMomsordning", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    return { ok: true };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "saetAuktionMomsordning", fejl: err });
    return { fejl: GENERISK };
  }
}

// ---------------------------------------------------------------------------
// Køberen: firmanavn og CVR til sælgers faktura
// ---------------------------------------------------------------------------
export async function gemKoeberFakturaFirma(
  tradeId: string,
  firmanavn: string,
  cvr: string,
): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
    const { supabase, user } = await bruger();
    if (!user) return { fejl: "Du skal være logget ind." };
    if (!(await indenForGraense("firma_faktura_gem", user.id))) return { fejl: FOR_MANGE_FORSOEG };
    const { data, error } = await supabase.rpc("koeber_faktura_firma_gem", {
      p_trade: tradeId,
      p_firmanavn: typeof firmanavn === "string" ? firmanavn.slice(0, 200) : "",
      p_cvr: typeof cvr === "string" ? cvr.slice(0, 20) : "",
    });
    if (error) {
      if (error.code === "22023") return { fejl: error.message };
      await logDriftFejl({ kilde: "action", hvor: "gemKoeberFakturaFirma", fejl: error, brugerId: user.id });
      return { fejl: GENERISK };
    }
    const svar = data as { ok: boolean; kode?: string };
    if (!svar.ok) {
      return {
        fejl:
          svar.kode === "allerede_sendt"
            ? "Sælgeren har allerede sendt fakturaen. Skriv til sælgeren, hvis noget skal rettes."
            : "Der er ingen faktura fra sælgeren på denne handel.",
      };
    }
    revalidatePath(`/mine-handler/${tradeId}`);
    return { ok: true };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "gemKoeberFakturaFirma", fejl: err });
    return { fejl: GENERISK };
  }
}
