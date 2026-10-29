import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResend } from "@/lib/resend";
import { logDriftFejl } from "@/lib/drift";
import { bygMail, escapeHtml } from "@/lib/mails/layout";
import { hentLogo, lavFirmaFakturaPdf } from "@/lib/pdf/firmaFakturaPdf";
import {
  EMAIL_FAKTURA,
  datoTekst,
  dokumentNavn,
  kroner,
  pdfFilnavn,
  type FirmaFakturaData,
} from "@/lib/erhverv/firmaFaktura";

// Serverdelen af fakturaer fra firma til køber: PDF (privat bucket
// firma-fakturaer) og mailen. Kaldes KUN efter firmaets eget tryk på "Send"
// (src/app/actions/firmaFaktura.ts) eller "Send mailen igen" - aldrig fra
// cron, webhooks eller triggere. Statusskiftet til 'sendt' sker i databasen
// (firma_faktura_send) med firmaets egen bruger; service role kan kun gemme
// PDF-stien og mailstatus.

const BUCKET = "firma-fakturaer";

export type SendtRaekke = {
  id: string;
  firma_id: string;
  saelger_id: string;
  koeber_id: string;
  status: "kladde" | "sendt";
  pdf_sti: string | null;
  mail_sendt_kl?: string | null;
  logo_sha256?: string | null;
  data: FirmaFakturaData | null;
};

function erPdf(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// Kladde (forhåndsvisning) - laves altid frisk, gemmes ikke.
export async function kladdePdf(d: FirmaFakturaData): Promise<Uint8Array> {
  return lavFirmaFakturaPdf(d, await hentLogo(d.saelger.logo_url));
}

async function hentGemt(admin: ReturnType<typeof createAdminClient>, sti: string): Promise<Uint8Array | null> {
  const { data: fil, error } = await admin.storage.from(BUCKET).download(sti);
  if (error || !fil) return null;
  const pdf = new Uint8Array(await fil.arrayBuffer());
  return erPdf(pdf) ? pdf : null;
}

// Sendt faktura: den gemte PDF, ellers laves den ud fra øjebliksbilledet og
// gemmes én gang (upsert: false - en gemt PDF overskrives aldrig; findes
// filen allerede, bruges den). Logoets hash gemmes sammen med stien, så en
// senere genskabelse kun bruger logoet, hvis det er præcis det samme billede.
export async function sendtPdf(r: SendtRaekke): Promise<Uint8Array> {
  if (r.status !== "sendt" || !r.data) throw new Error("Fakturaen er ikke sendt.");
  const admin = createAdminClient();
  const sti = r.pdf_sti ?? `${r.firma_id}/${r.id}.pdf`;
  const gemt = await hentGemt(admin, sti);
  if (gemt) {
    if (!r.pdf_sti) {
      const { error } = await admin.rpc("firma_faktura_gem_pdf", { p_id: r.id, p_sti: sti, p_logo_sha256: null });
      if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_gem_pdf", fejl: error });
    }
    return gemt;
  }

  let logo = await hentLogo(r.data.saelger.logo_url);
  const logoHash = logo ? sha256Hex(logo.bytes) : null;
  if (logo && r.logo_sha256 && r.logo_sha256 !== logoHash) {
    // Profilbilledet er skiftet siden afsendelsen: ikke et andet logo på en
    // sendt faktura.
    await logDriftFejl({ kilde: "server", hvor: "firma_faktura_logo_skiftet", fejl: new Error(`Logoet er ændret for ${r.id}`) });
    logo = null;
  }
  const pdf = await lavFirmaFakturaPdf(r.data, logo);
  if (!r.pdf_sti) {
    const { error: opFejl } = await admin.storage
      .from(BUCKET)
      .upload(sti, pdf, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
    if (opFejl) {
      // Fx en samtidig afsendelse, der nåede først: brug den gemte.
      const anden = await hentGemt(admin, sti);
      if (anden) {
        const { error } = await admin.rpc("firma_faktura_gem_pdf", { p_id: r.id, p_sti: sti, p_logo_sha256: null });
        if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_gem_pdf", fejl: error });
        return anden;
      }
      await logDriftFejl({ kilde: "server", hvor: "firma_faktura_upload", fejl: opFejl });
      return pdf;
    }
    const { error } = await admin.rpc("firma_faktura_gem_pdf", { p_id: r.id, p_sti: sti, p_logo_sha256: logo ? logoHash : null });
    if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_gem_pdf", fejl: error });
  }
  return pdf;
}

// Henter en sendt faktura med service role. Kalderen har tjekket adgangen
// (firmaet selv eller køberen).
export async function hentSendtRaekke(id: string): Promise<SendtRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("firma_fakturaer")
    .select("id, firma_id, saelger_id, koeber_id, status, pdf_sti, mail_sendt_kl, logo_sha256, data")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as SendtRaekke | null) ?? null;
}

// Afsendernavn "Firmanavn via BidHamr" - uden tegn, der kan bryde headeren.
export function afsender(firmanavn: string): string {
  const navn = firmanavn.replace(/[\r\n"<>\\,;:@]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Firma";
  return `"${navn} via BidHamr" <noreply@bidhamr.dk>`;
}

export function fakturaMail(d: FirmaFakturaData): { subject: string; html: string; text: string } {
  const firma = d.saelger.firmanavn;
  const type = dokumentNavn(d);
  const nr = d.fakturanummer ?? "";
  const vare = d.linjer.map((l) => l.tekst).join(", ");
  const hej = d.koeber.navn ? `Hej ${escapeHtml(d.koeber.navn)}` : "Hej";
  const afsnit =
    d.type === "kreditnota"
      ? [
          `${hej}`,
          `${escapeHtml(firma)} har lavet en kreditnota nr. ${escapeHtml(nr)} til faktura nr. ${escapeHtml(d.krediterer?.fakturanummer ?? "")}. Du finder den vedhæftet som PDF.`,
          `Har du spørgsmål, kan du bare svare på denne mail – så går dit svar direkte til ${escapeHtml(firma)}.`,
          `Venlig hilsen<br>${escapeHtml(firma)}`,
        ]
      : [
          `${hej}`,
          `Tak for dit køb hos ${escapeHtml(firma)}. Her er din faktura nr. ${escapeHtml(nr)} – du finder den vedhæftet som PDF.`,
          `Købet er allerede betalt via BidHamr, så du skal ikke gøre mere.`,
          `Har du spørgsmål til fakturaen, kan du bare svare på denne mail – så går dit svar direkte til ${escapeHtml(firma)}.`,
          `Venlig hilsen<br>${escapeHtml(firma)}`,
        ];
  const { html, text } = bygMail({
    preheader: `${type} nr. ${nr} fra ${firma}`,
    overskriftHtml: `${escapeHtml(type)} nr. ${escapeHtml(nr)} fra ${escapeHtml(firma)}`,
    afsnitHtml: afsnit,
    info: [
      { noegle: "Vare", vaerdiHtml: escapeHtml(vare) },
      { noegle: "Dato", vaerdiHtml: escapeHtml(datoTekst(d.udstedt_dato)) },
      { noegle: d.type === "kreditnota" ? "Krediteret" : "Beløb", vaerdiHtml: escapeHtml(kroner(Number(d.total_oere))), fremhaev: true },
    ],
    aarsag: `Du får denne mail, fordi du har købt en vare af ${firma} på BidHamr. ${type}en er udstedt af ${firma} (CVR-nr. ${d.saelger.cvr}); BidHamr sender den kun på firmaets vegne.`,
  });
  return { subject: `${type} nr. ${nr} fra ${firma}`, html, text };
}

// Sender mailen med PDF'en til køberen (kopi til firmaet som bcc) og gemmer
// resultatet. Returnerer true, hvis Resend tog imod den.
export async function sendFakturaMail(r: SendtRaekke): Promise<boolean> {
  return (await sendFakturaMailLaast(r)) === "sendt";
}

type MailUdfald = "sendt" | "fejl" | "i_gang";

// Som sendFakturaMail, men "i_gang", hvis et andet forsøg sender mailen
// lige nu (to samtidige tryk på "Send mailen igen"). Låsen tages under
// rækkelåsen på fakturaen (firma_faktura_mail_tag, 20261102410000) og
// slippes, når forsøget er slut (ellers efter 5 minutter). Låsen har en ejer
// (et tilfældigt id pr. forsøg, 20261102430000): kun det forsøg, der tog
// den, kan slippe den - også hvis den er udløbet og taget af et nyt forsøg.
export async function sendFakturaMailLaast(r: SendtRaekke): Promise<MailUdfald> {
  const d = r.data;
  if (!d || r.status !== "sendt") return "fejl";
  // Mailen sendes højst én gang (ingen dobbelt-mail ved "Send mailen igen").
  if (r.mail_sendt_kl) return "sendt";
  const admin = createAdminClient();
  const ejer = randomUUID();
  const { data: laast, error: laasFejl } = await admin.rpc("firma_faktura_mail_tag", { p_id: r.id, p_ejer: ejer });
  // Migrationen er ikke kørt: som før (uden lås).
  const udenLaas = laasFejl?.code === "PGRST202" || laasFejl?.code === "42883";
  if (laasFejl && !udenLaas) {
    await logDriftFejl({ kilde: "server", hvor: "firma_faktura_mail_tag", fejl: laasFejl });
    return "fejl";
  }
  if (!laasFejl && laast !== true) {
    // Allerede sendt (af det andet forsøg) eller i gang.
    const nu = await hentSendtRaekke(r.id);
    return nu?.mail_sendt_kl ? "sendt" : "i_gang";
  }
  try {
    return (await sendFakturaMailNu(admin, r, d)) ? "sendt" : "fejl";
  } finally {
    if (!udenLaas) {
      const { error } = await admin.rpc("firma_faktura_mail_frigiv", { p_id: r.id, p_ejer: ejer });
      if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_mail_frigiv", fejl: error });
    }
  }
}

async function sendFakturaMailNu(
  admin: ReturnType<typeof createAdminClient>,
  r: SendtRaekke,
  d: FirmaFakturaData,
): Promise<boolean> {
  const gem = async (ok: boolean, fejl: string | null) => {
    const { error } = await admin.rpc("firma_faktura_mail_resultat", { p_id: r.id, p_ok: ok, p_fejl: fejl });
    if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_mail_resultat", fejl: error });
  };
  const til = d.koeber.email ?? "";
  if (!EMAIL_FAKTURA.test(til) || til.toLowerCase().endsWith("@slettet.invalid")) {
    await gem(false, "Købers e-mail mangler");
    return false;
  }
  const svar = d.saelger.email && EMAIL_FAKTURA.test(d.saelger.email) ? d.saelger.email : undefined;
  try {
    const pdf = await sendtPdf(r);
    const resend = getResend();
    if (!resend) {
      await gem(false, "RESEND_API_KEY mangler");
      return false;
    }
    const mail = fakturaMail(d);
    // Idempotency key pr. faktura (Resend, 24 timer): er mailen sendt, men
    // svaret eller markeringen gik tabt (timeout), sender et nyt forsøg den
    // ikke igen. Mailen sendes alligevel højst én gang (mail_sendt_kl).
    const { error } = await resend.emails.send(
      {
        from: afsender(d.saelger.firmanavn),
        to: til,
        ...(svar ? { replyTo: svar, bcc: svar } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: [{ filename: pdfFilnavn(d), content: Buffer.from(pdf) }],
      },
      { idempotencyKey: `firma-faktura-${r.id}` },
    );
    if (error) {
      await gem(false, `Resend: ${error.name ?? "fejl"}: ${error.message ?? ""}`);
      return false;
    }
    await gem(true, null);
    return true;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "firma_faktura_mail", fejl: err });
    await gem(false, err instanceof Error ? err.message : String(err));
    return false;
  }
}
