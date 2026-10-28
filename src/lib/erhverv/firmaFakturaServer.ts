import "server-only";
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
  data: FirmaFakturaData | null;
};

function erPdf(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

// Kladde (forhåndsvisning) - laves altid frisk, gemmes ikke.
export async function kladdePdf(d: FirmaFakturaData): Promise<Uint8Array> {
  return lavFirmaFakturaPdf(d, await hentLogo(d.saelger.logo_url));
}

// Sendt faktura: den gemte PDF, ellers laves den ud fra øjebliksbilledet og
// gemmes (én gang).
export async function sendtPdf(r: SendtRaekke): Promise<Uint8Array> {
  if (r.status !== "sendt" || !r.data) throw new Error("Fakturaen er ikke sendt.");
  const admin = createAdminClient();
  if (r.pdf_sti) {
    const { data: fil, error } = await admin.storage.from(BUCKET).download(r.pdf_sti);
    if (!error && fil) {
      const pdf = new Uint8Array(await fil.arrayBuffer());
      if (erPdf(pdf)) return pdf;
    }
  }
  const pdf = await lavFirmaFakturaPdf(r.data, await hentLogo(r.data.saelger.logo_url));
  if (!r.pdf_sti) {
    const sti = `${r.firma_id}/${r.id}.pdf`;
    const { error: opFejl } = await admin.storage
      .from(BUCKET)
      .upload(sti, pdf, { contentType: "application/pdf", upsert: true, cacheControl: "0" });
    if (!opFejl) {
      const { error } = await admin.rpc("firma_faktura_gem_pdf", { p_id: r.id, p_sti: sti });
      if (error) await logDriftFejl({ kilde: "server", hvor: "firma_faktura_gem_pdf", fejl: error });
    } else {
      await logDriftFejl({ kilde: "server", hvor: "firma_faktura_upload", fejl: opFejl });
    }
  }
  return pdf;
}

// Henter en sendt faktura med service role. Kalderen har tjekket adgangen
// (firmaet selv eller køberen).
export async function hentSendtRaekke(id: string): Promise<SendtRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("firma_fakturaer")
    .select("id, firma_id, saelger_id, koeber_id, status, pdf_sti, data")
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
  const d = r.data;
  if (!d || r.status !== "sendt") return false;
  const admin = createAdminClient();
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
    const { error } = await resend.emails.send({
      from: afsender(d.saelger.firmanavn),
      to: til,
      ...(svar ? { replyTo: svar, bcc: svar } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: [{ filename: pdfFilnavn(d), content: Buffer.from(pdf) }],
    });
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
