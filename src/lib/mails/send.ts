import "server-only";

// Fælles afsendelse af handelsmails (cron og server actions). På
// testdatabasen logger getResend() mailen i stedet for at sende den.
import { getResend } from "@/lib/resend";
import { HANDEL_AFSENDER } from "@/lib/mails/handel";

// text er tekstudgaven (multipart/alternative). Alle skabeloner i
// src/lib/mails laver den; uden den sender Resend kun HTML.
export type Mail = { subject: string; html: string; text?: string };

export async function sendHandelMail(til: string | undefined | null, mail: Mail): Promise<boolean> {
  return (await sendHandelMailDetaljer(til, mail)).ok;
}

// Som sendHandelMail, men med fejlen (Resends navn og besked - aldrig
// mailens indhold). Bruges af notifikationerne til /admin/drift.
export async function sendHandelMailDetaljer(
  til: string | undefined | null,
  mail: Mail,
): Promise<{ ok: true } | { ok: false; fejl: string }> {
  if (!til) return { ok: false, fejl: "Ingen modtager" };
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY mangler - mail ikke sendt:", mail.subject);
    return { ok: false, fejl: "RESEND_API_KEY mangler" };
  }
  try {
    const { error } = await resend.emails.send({
      from: HANDEL_AFSENDER,
      to: til,
      subject: mail.subject,
      html: mail.html,
      ...(mail.text ? { text: mail.text } : {}),
    });
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
