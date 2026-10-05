import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminActionKnap from "@/components/admin/AdminActionKnap";
import AabnChatKnap from "@/components/admin/staffchat/AabnChatKnap";
import { kontaktGenaabn, kontaktMarkerBesvaret } from "@/app/actions/adminTryghed";
import { kontaktEmneNavn } from "@/lib/tryghed";

// Henvendelser fra kontaktformularen (/kontakt). Medarbejder og op.
// Henvendelser slettes aldrig.

export const dynamic = "force-dynamic";

type Henvendelse = {
  id: string;
  bruger_id: string | null;
  email: string;
  emne: string;
  besked: string;
  handels_ref: string | null;
  trade_id: string | null;
  status: "ny" | "besvaret";
  besvaret_af: string | null;
  besvaret_kl: string | null;
  oprettet_kl: string;
};

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });

export default async function AdminKontaktSide({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const { admin } = await kraevSideRolle("medarbejder");
  const { vis } = await searchParams;
  const visBesvarede = vis === "besvarede";

  const { data, error } = await admin
    .from("kontakt_henvendelser")
    .select(
      "id, bruger_id, email, emne, besked, handels_ref, trade_id, status, besvaret_af, besvaret_kl, oprettet_kl",
    )
    .eq("status", visBesvarede ? "besvaret" : "ny")
    .order(visBesvarede ? "besvaret_kl" : "oprettet_kl", { ascending: false })
    .limit(300);
  const henvendelser = (data ?? []) as Henvendelse[];

  const brugerIds = [
    ...new Set(
      henvendelser.flatMap((h) => [h.bruger_id, h.besvaret_af]).filter((x): x is string => !!x),
    ),
  ];
  const { data: brugere } = brugerIds.length
    ? await admin.from("users").select("id, navn").in("id", brugerIds)
    : { data: [] as { id: string; navn: string | null }[] };
  const navnMap = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Kontaktformular"
        forklaring="Henvendelser fra kontaktformularen. Svar via staff-chatten, hvis brugeren er logget ind – ellers på mail. Markér henvendelsen som besvaret bagefter."
        hoejre={
          <span className="text-sm text-neutral-500">
            {henvendelser.length} {henvendelser.length === 1 ? "henvendelse" : "henvendelser"}
          </span>
        }
      />

      <div className="flex gap-2 text-sm">
        <Link
          href="/admin/kontakt"
          aria-current={!visBesvarede ? "page" : undefined}
          className={`rounded-full px-3 py-1 ${!visBesvarede ? "bg-groen text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
        >
          Nye
        </Link>
        <Link
          href="/admin/kontakt?vis=besvarede"
          aria-current={visBesvarede ? "page" : undefined}
          className={`rounded-full px-3 py-1 ${visBesvarede ? "bg-groen text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
        >
          Besvarede
        </Link>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Henvendelserne kunne ikke hentes. Er migrationen 20261006030000_tryghed_chat_kontakt.sql kørt?
        </p>
      )}

      <ul className="space-y-3">
        {henvendelser.map((h) => {
          const brugerNavn = h.bruger_id ? navnMap.get(h.bruger_id) : null;
          const emneTekst = kontaktEmneNavn(h.emne);
          return (
            <li key={h.id} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-neutral-900">{emneTekst}</p>
                  <p className="mt-0.5 break-all text-xs text-neutral-500">
                    {tid(h.oprettet_kl)} · {h.email}
                    {h.bruger_id && (
                      <>
                        {" · "}
                        <Link href={`/admin/brugere/${h.bruger_id}`} className="hover:underline">
                          {brugerNavn ?? "Bruger"}
                        </Link>
                      </>
                    )}
                    {!h.bruger_id && " · ikke logget ind"}
                  </p>
                </div>
                {(h.trade_id || h.handels_ref) && (
                  <span className="max-w-full break-all rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-700">
                    Handel:{" "}
                    {h.trade_id ? (
                      <Link href={`/admin/handler?q=${h.trade_id}`} className="font-medium hover:underline">
                        {h.trade_id.slice(0, 8)}
                      </Link>
                    ) : (
                      h.handels_ref
                    )}
                  </span>
                )}
              </div>

              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-800">{h.besked}</p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {h.bruger_id ? (
                  <AabnChatKnap
                    brugerId={h.bruger_id}
                    brugerNavn={brugerNavn ?? "brugeren"}
                    tradeId={h.trade_id ?? undefined}
                    knapTekst="Svar via staff-chat"
                  />
                ) : (
                  <a
                    href={`mailto:${encodeURIComponent(h.email)}?subject=${encodeURIComponent(`Re: ${emneTekst} – BidHamr`)}`}
                    className="rounded-lg border border-groen px-3 py-1.5 text-sm font-medium text-groen hover:bg-groen-lys"
                  >
                    Svar på mail
                  </a>
                )}
                {h.status === "ny" ? (
                  <AdminActionKnap
                    action={kontaktMarkerBesvaret}
                    hiddenFields={{ henvendelseId: h.id }}
                    label="Markér som besvaret"
                    className="whitespace-nowrap rounded-md bg-green-100 px-2 py-1 text-xs text-green-800 transition-colors hover:bg-green-200"
                  />
                ) : (
                  <>
                    <span className="text-xs text-neutral-500">
                      Besvaret af {h.besvaret_af ? (navnMap.get(h.besvaret_af) ?? "—") : "—"}
                      {h.besvaret_kl && ` · ${tid(h.besvaret_kl)}`}
                    </span>
                    <AdminActionKnap
                      action={kontaktGenaabn}
                      hiddenFields={{ henvendelseId: h.id }}
                      label="Genåbn"
                      className="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-200"
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
        {henvendelser.length === 0 && !error && (
          <li className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-400">
            {visBesvarede ? "Ingen besvarede henvendelser endnu." : "Der er ingen nye henvendelser."}
          </li>
        )}
      </ul>
    </div>
  );
}
