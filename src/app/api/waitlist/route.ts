import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getResend } from "@/lib/resend";
import { velkomstMail } from "@/lib/mails/venteliste";
import { FOR_MANGE_FORSOEG, indenForGraense, klientIp } from "@/lib/rateLimit";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Kræver at bidhamr.dk er verificeret i Resend (DNS-records under Domains).
// Er domænet ikke verificeret, afviser Resend afsendelsen med en 403 - selve
// tilmeldingen gemmes stadig, og fejlen logges på serveren.
const AFSENDER = "BidHamr <noreply@bidhamr.dk>";

// Fast besked til klienten - den rigtige fejl logges kun på serveren.
const SERVERFEJL = "Vi kunne ikke skrive dig op lige nu. Prøv igen om lidt.";

export async function POST(req: NextRequest) {
  // Hoejst et par tilmeldinger pr. IP i timen, saa listen og Resend ikke kan spammes.
  if (!(await indenForGraense("venteliste_ip", await klientIp()))) {
    return NextResponse.json({ error: FOR_MANGE_FORSOEG }, { status: 429 });
  }

  let email: unknown;
  try {
    ({ email } = await req.json());
  } catch {
    return NextResponse.json({ error: "Ugyldig forespørgsel." }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return NextResponse.json(
      { error: "Indtast en gyldig e-mailadresse." },
      { status: 400 },
    );
  }

  const renEmail = email.trim().toLowerCase();
  let error: { code?: string; message?: string } | null;
  try {
    const supabase = await createClient();
    ({ error } = await supabase.from("venteliste").insert({ email: renEmail }));
  } catch (err) {
    console.error("Venteliste: kunne ikke gemme tilmelding:", err);
    return NextResponse.json({ error: SERVERFEJL }, { status: 500 });
  }

  // 23505 = unik-constraint: allerede tilmeldt. Det behandles som succes (vi
  // røber ikke om en e-mail er på listen), men vi sender ikke velkomstmailen
  // igen.
  const alleredeTilmeldt = error?.code === "23505";
  if (error && !alleredeTilmeldt) {
    console.error("Venteliste: kunne ikke gemme tilmelding:", error);
    return NextResponse.json({ error: SERVERFEJL }, { status: 500 });
  }

  // Mailen sendes kun ved en ny tilmelding. Fejler afsendelsen, må det ikke
  // vælte tilmeldingen - den er allerede gemt, og brugeren har gjort sit.
  if (!alleredeTilmeldt) {
    const resend = getResend();
    if (!resend) {
      console.warn("RESEND_API_KEY mangler - velkomstmail blev ikke sendt.");
    } else {
      try {
        const mail = velkomstMail(renEmail);
        const { error: mailFejl } = await resend.emails.send({
          from: AFSENDER,
          to: renEmail,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (mailFejl) {
          console.error("Kunne ikke sende velkomstmail:", mailFejl);
        }
      } catch (err) {
        console.error("Kunne ikke sende velkomstmail:", err);
      }
    }
  }

  return NextResponse.json({ success: true });
}
