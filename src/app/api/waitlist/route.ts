import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getResend } from "@/lib/resend";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRAND = "#E63946";

// Kræver at bidhamr.dk er verificeret i Resend (DNS-records under Domains).
// Er domænet ikke verificeret, afviser Resend afsendelsen med en 403 - selve
// tilmeldingen gemmes stadig, og fejlen logges på serveren.
const AFSENDER = "BidHamr <noreply@bidhamr.dk>";

function velkomstMail(email: string) {
  return `<!DOCTYPE html>
<html lang="da">
  <body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
            <tr>
              <td align="center" style="background-color:${BRAND};padding:28px 24px;">
                <span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;">BidHamr</span>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 28px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:#171717;">
                  Tak for din tilmelding!
                </h1>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#525252;">
                  Du er nu på ventelisten til BidHamr — Danmarks nye lokale
                  auktionsplatform.
                </p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#525252;">
                  Vi giver dig besked, så snart vi lancerer, så du kan være med
                  fra dag ét. Du hører først fra os igen, når der er nyt — vi
                  sender ikke spam.
                </p>
                <p style="margin:0;font-size:15px;line-height:1.6;color:#525252;">
                  Vi glæder os til at have dig med.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid #f0f0f0;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#a3a3a3;">
                  Du modtager denne mail, fordi ${email} blev tilmeldt ventelisten
                  på bidhamr.dk. Har du ikke selv tilmeldt dig, kan du roligt
                  ignorere denne mail.
                </p>
                <p style="margin:12px 0 0 0;font-size:12px;color:#a3a3a3;">
                  BidHamr · <a href="mailto:support@bidhamr.dk" style="color:#a3a3a3;">support@bidhamr.dk</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function POST(req: NextRequest) {
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
  const supabase = await createClient();

  const { error } = await supabase.from("venteliste").insert({ email: renEmail });

  // 23505 = unik-constraint: allerede tilmeldt. Det behandles som succes (vi
  // røber ikke om en e-mail er på listen), men vi sender ikke velkomstmailen
  // igen.
  const alleredeTilmeldt = error?.code === "23505";
  if (error && !alleredeTilmeldt) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mailen sendes kun ved en ny tilmelding. Fejler afsendelsen, må det ikke
  // vælte tilmeldingen - den er allerede gemt, og brugeren har gjort sit.
  if (!alleredeTilmeldt) {
    const resend = getResend();
    if (!resend) {
      console.warn("RESEND_API_KEY mangler - velkomstmail blev ikke sendt.");
    } else {
      const { error: mailFejl } = await resend.emails.send({
        from: AFSENDER,
        to: renEmail,
        subject: "Velkommen til BidHamr ventelisten 🎉",
        html: velkomstMail(renEmail),
      });
      if (mailFejl) {
        console.error("Kunne ikke sende velkomstmail:", mailFejl);
      }
    }
  }

  return NextResponse.json({ success: true });
}
