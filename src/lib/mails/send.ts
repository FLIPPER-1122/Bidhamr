import "server-only";

// Fælles afsendelse af handelsmails (cron og server actions). På
// testdatabasen logger getResend() mailen i stedet for at sende den.
import { getResend } from "@/lib/resend";
import { HANDEL_AFSENDER } from "@/lib/mails/handel";

// text er tekstudgaven (multipart/alternative). Alle skabeloner i
// src/lib/mails laver den; uden den sender Resend kun HTML.
export type Mail = { subject: string; html: string; text?: string };

export async function sendHandelMail(til: string | undefined | null, mail: Mail): Promise<boolean> {
  if (!til) return false;
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY mangler - mail ikke sendt:", mail.subject);
    return false;
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
      return false;
    }
    return true;
  } catch (err) {
    console.error("Mail kastede:", err);
    return false;
  }
}
