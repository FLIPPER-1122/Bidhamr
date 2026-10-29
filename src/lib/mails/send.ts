import "server-only";

// Fælles afsendelse af handelsmails (cron og server actions). På
// testdatabasen logger getResend() mailen i stedet for at sende den.
import { getResend } from "@/lib/resend";
import { HANDEL_AFSENDER } from "@/lib/mails/handel";

// text er tekstudgaven (multipart/alternative). Alle skabeloner i
// src/lib/mails laver den; uden den sender Resend kun HTML.
// replyTo bruges til interne mails (fx kontaktformularen), så "Svar" går til
// afsenderen. Kalderen skal have valideret adressen.
export type Mail = { subject: string; html: string; text?: string; replyTo?: string };

export async function sendHandelMail(til: string | undefined | null, mail: Mail): Promise<boolean> {
  return (await sendHandelMailDetaljer(til, mail)).ok;
}

// Som sendHandelMail, men med fejlen (Resends navn og besked - aldrig
// mailens indhold). Bruges af notifikationerne til /admin/drift.
// idempotencyKey: Resend sender højst én mail pr. nøgle (inden for 24 timer),
// så et nyt forsøg efter fx en timeout ikke giver to mails.
export async function sendHandelMailDetaljer(
  til: string | undefined | null,
  mail: Mail,
  opts: { idempotencyKey?: string } = {},
): Promise<{ ok: true } | { ok: false; fejl: string }> {
  if (!til) return { ok: false, fejl: "Ingen modtager" };
  // Slettede konti har en pladsholder-adresse (konto_slet) - send aldrig dertil.
  if (til.toLowerCase().endsWith("@slettet.invalid")) return { ok: false, fejl: "Slettet bruger" };
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY mangler - mail ikke sendt:", mail.subject);
    return { ok: false, fejl: "RESEND_API_KEY mangler" };
  }
  try {
    const payload = {
      from: HANDEL_AFSENDER,
      to: til,
      subject: mail.subject,
      html: mail.html,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    };
    const { error } = opts.idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey: opts.idempotencyKey })
      : await resend.emails.send(payload);
    if (error) {
      console.error("Mail fejlede:", error);
      return { ok: false, fejl: `Resend: ${error.name ?? "fejl"}: ${error.message ?? ""}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("Mail kastede:", err);
    return { ok: false, fejl: `Mail kastede: ${err instanceof Error ? err.message : String(err)}` };
  }
}
