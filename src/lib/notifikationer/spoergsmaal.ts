import "server-only";

// Notifikationer for "Spørg sælger":
// - nyt spørgsmål -> sælgeren   (nøgle spoergsmaal:<id>)
// - nyt svar      -> spørgeren  (nøgle spoergsmaal_svar:<id>)
//
// Sendes med det samme fra server actions (src/app/actions/spoergsmaal.ts) og
// samles op af notifikations-cron'en for spørgsmål/svar fra appen, som kalder
// RPC'erne direkte. Samme nøgler, så intet sendes dobbelt. Kaster aldrig.
//
// Spørgerens identitet nævnes aldrig over for sælgeren, og ingen bruger-id
// lægges i data.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";

type Admin = ReturnType<typeof createAdminClient>;

export type SpoergsmaalRaekke = {
  id: string;
  auction_id: string;
  asker_id: string;
  question: string;
  answer: string | null;
  hidden: boolean;
};

export const spoergsmaalNoegle = (id: string) => `spoergsmaal:${id}`;
export const svarNoegle = (id: string) => `spoergsmaal_svar:${id}`;

export function spoergsmaalInput(
  q: SpoergsmaalRaekke,
  titel: string,
): NotifikationInput & { noegle: string } {
  return {
    titel: "Nyt spørgsmål til din auktion",
    // Teksten citeres ikke: staff kan skjule spørgsmål, og notifikationen
    // ville ellers blive ved med at vise den skjulte tekst.
    tekst: `Der er et nyt spørgsmål til "${titel}". Svar på auktionssiden – svaret kan ses af alle.`,
    link: `/auktion/${q.auction_id}#spoergsmaal`,
    data: { auction_id: q.auction_id, question_id: q.id },
    noegle: spoergsmaalNoegle(q.id),
  };
}

export function svarInput(q: SpoergsmaalRaekke, titel: string): NotifikationInput & { noegle: string } {
  return {
    titel: "Sælgeren har svaret på dit spørgsmål",
    tekst: `Sælgeren af "${titel}" har svaret på dit spørgsmål – se svaret på auktionssiden.`,
    link: `/auktion/${q.auction_id}#spoergsmaal`,
    data: { auction_id: q.auction_id, question_id: q.id },
    noegle: svarNoegle(q.id),
  };
}

async function hent(admin: Admin, id: string) {
  const { data: q } = await admin
    .from("auction_questions")
    .select("id, auction_id, asker_id, question, answer, hidden")
    .eq("id", id)
    .maybeSingle<SpoergsmaalRaekke>();
  if (!q || q.hidden) return null;
  const { data: a } = await admin
    .from("auctions")
    .select("titel, bruger_id")
    .eq("id", q.auction_id)
    .maybeSingle<{ titel: string; bruger_id: string }>();
  if (!a) return null;
  return { q, a };
}

export async function notificerNytSpoergsmaal(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const r = await hent(admin, id);
    if (!r || r.a.bruger_id === r.q.asker_id) return;
    await send(r.a.bruger_id, "spoergsmaal", spoergsmaalInput(r.q, r.a.titel));
  } catch (err) {
    console.error("notificerNytSpoergsmaal fejlede:", err);
  }
}

export async function notificerSvar(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const r = await hent(admin, id);
    if (!r || !r.q.answer) return;
    await send(r.q.asker_id, "spoergsmaal", svarInput(r.q, r.a.titel));
  } catch (err) {
    console.error("notificerSvar fejlede:", err);
  }
}
