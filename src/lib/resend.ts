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

export function getResend(): Resend | null {
  if (erTestdatabase()) return testKlient;
  if (client) return client;

  const key = process.env.RESEND_API_KEY;
  if (!key) return null;

  client = new Resend(key);
  return client;
}
