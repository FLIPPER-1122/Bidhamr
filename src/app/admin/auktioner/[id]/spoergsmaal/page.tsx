import { notFound } from "next/navigation";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import SkjulSpoergsmaal from "@/components/SkjulSpoergsmaal";
import { kraevSideRolle } from "@/lib/adminAuth";

// Spørgsmål og svar på én auktion, hvor staff kan skjule og vise dem igen.
// Med admin på egen host (ADMIN_VAERT) er auktionssiden på bidhamr.dk uden
// staff-knapper - den linker hertil ("Åbn i admin"). Skjulte spørgsmål ser
// staff kun her (migration B: auktion_spoergsmaal_liste kræver aal2).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Spoergsmaal = {
  id: string;
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  hidden: boolean;
  hidden_at: string | null;
  hidden_reason: string | null;
};

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AdminAuktionSpoergsmaal({ params }: { params: Promise<{ id: string }> }) {
  const { admin } = await kraevSideRolle("medarbejder");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [{ data: auktion }, { data: raekker }] = await Promise.all([
    admin.from("auctions").select("id, titel").eq("id", id).maybeSingle<{ id: string; titel: string | null }>(),
    admin
      .from("auction_questions")
      .select("id, question, answer, asked_at, answered_at, hidden, hidden_at, hidden_reason")
      .eq("auction_id", id)
      .order("asked_at", { ascending: false })
      .limit(200),
  ]);
  if (!auktion) notFound();
  const spoergsmaal = (raekker ?? []) as Spoergsmaal[];

  return (
    <AdminSide detalje>
      <AdminSideHoved
        titel="Spørgsmål til sælger"
        forklaring={`${auktion.titel ?? "Auktion"} – skjul et spørgsmål, der bryder reglerne. Den, der skrev det, får en begrundelse og kan klage.`}
        tilbage={{ href: `/admin/auktioner/${auktion.id}`, label: "Auktionen" }}
      />
      {spoergsmaal.length === 0 ? (
        <p className="rounded-none border border-admin-kant bg-white p-6 text-sm text-tekst-svag">
          Der er ingen spørgsmål til denne auktion.
        </p>
      ) : (
        <ul className="space-y-3">
          {spoergsmaal.map((q) => (
            <li
              key={q.id}
              id={`spoergsmaal-${q.id}`}
              className={`scroll-mt-24 rounded-none border p-4 ${q.hidden ? "border-advarsel-kant bg-advarsel-bg" : "border-admin-kant bg-white"}`}
            >
              {q.hidden && (
                <p className="mb-2 text-[13px] font-semibold text-advarsel-tekst">
                  Skjult{q.hidden_at ? ` ${tid(q.hidden_at)}` : ""}
                  {q.hidden_reason ? ` – ${q.hidden_reason}` : ""}
                </p>
              )}
              <p className="text-xs text-tekst-svag">{tid(q.asked_at)}</p>
              <p className="mt-1 whitespace-pre-line break-words text-[15px] text-tekst">{q.question}</p>
              {q.answer && (
                <div className="mt-3 rounded-xl bg-groen-lys px-4 py-3">
                  <p className="text-xs font-medium text-groen-mork">
                    Sælgerens svar{q.answered_at ? ` · ${tid(q.answered_at)}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-line break-words text-[15px] text-tekst">{q.answer}</p>
                </div>
              )}
              <SkjulSpoergsmaal auktionId={auktion.id} spoergsmaalId={q.id} skjult={q.hidden} />
            </li>
          ))}
        </ul>
      )}
    </AdminSide>
  );
}
