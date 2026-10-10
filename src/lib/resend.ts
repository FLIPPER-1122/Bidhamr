import "server-only";

import { Resend } from "resend";
import { erTestdatabase } from "@/lib/miljoe";

// Lazy-initialiseret, så en manglende nøgle ikke kaster ved module-load og
// dermed vælter `next build` (samme problem som Stripe-klienten havde).
let client: Resend | null = null;

type SendInput = Parameters<Resend["emails"]["send"]>[0];

// På testdatabasen sendes der aldrig rigtige mails. Alle mails går gennem
// getResend(), så nye mails er automatisk dækket. I stedet logges modtager,
// emne og starten af teksten. Returnerer samme form som Resend ({ data, error }).
const testKlient = {
  emails: {
    async send(input: SendInput) {
      const i = input as {
        to?: string | string[];
        subject?: string;
        text?: string;
        html?: string;
      };
      const tekst = (i.text ?? i.html?.replace(/<[^>]*>/g, " ") ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      console.info(
        `[testmail, ikke sendt] til: ${[i.to].flat().join(", ")} | emne: ${i.subject ?? ""} | ${tekst}`,
      );
      return { data: { id: "testmail-ikke-sendt" }, error: null, headers: null };
    },
  },
} as unknown as Resend;

// Kun på testdatabasen: er MAIL_TEST_MODTAGER sat (og RESEND_API_KEY), sendes
// ALLE mails rigtigt, men til MAIL_TEST_MODTAGER i stedet for den rigtige
// modtager. Emnet får præfikset "[TEST til <oprindelig modtager>] ".
// erTestdatabase() er fail closed, så det kan aldrig slå til i produktion.
let omdirigeringsKlient: Resend | null = null;

function testOmdirigering(): Resend | null {
  const modtager = process.env.MAIL_TEST_MODTAGER?.trim();
  const key = process.env.RESEND_API_KEY;
  if (!modtager || !key || !erTestdatabase()) return null;
  if (omdirigeringsKlient) return omdirigeringsKlient;
  const rigtig = new Resend(key);
  omdirigeringsKlient = {
    emails: {
      send(input: SendInput, ...rest: unknown[]) {
        const i = input as { to?: string | string[]; subject?: string; cc?: unknown; bcc?: unknown };
        const oprindelig = [i.to].flat().filter(Boolean).join(", ");
        const omdirigeret = {
          ...input,
          to: modtager,
          cc: undefined,
          bcc: undefined,
          subject: `[TEST til ${oprindelig}] ${i.subject ?? ""}`,
        } as SendInput;
        return (rigtig.emails.send as (...a: unknown[]) => ReturnType<Resend["emails"]["send"]>)(
          omdirigeret,
          ...rest,
        );
      },
    },
  } as unknown as Resend;
  return omdirigeringsKlient;
}

export function getResend(): Resend | null {
  if (erTestdatabase()) return testOmdirigering() ?? testKlient;
  if (client) return client;

  const key = process.env.RESEND_API_KEY;
  if (!key) return null;

  client = new Resend(key);
  return client;
}
