import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFilterChips from "@/components/admin/AdminFilterChips";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminSideskift, { adminHref, laesSide } from "@/components/admin/AdminSideskift";
import AdminActionKnap from "@/components/admin/AdminActionKnap";
import SkrivTilBrugerKnap from "@/components/admin/SkrivTilBrugerKnap";
import { HenvendelserFaner } from "@/components/admin/OmraadeFaner";
import { kontaktGenaabn, kontaktMarkerBesvaret } from "@/app/actions/adminTryghed";
import { kontaktEmneNavn } from "@/lib/tryghed";
import { KONTAKT_SVAR } from "@/lib/tekster/adminSkabeloner";

// Henvendelser fra kontaktformularen (/kontakt). Medarbejder og op.
// Henvendelser slettes aldrig. Hurtigst: "Svar" på kortet skriver til
// brugeren i staff-chatten og markerer henvendelsen besvaret i samme klik.

export const dynamic = "force-dynamic";

const PR_SIDE = 25;

type Henvendelse = {
  id: string;
  bruger_id: string | null;
  email: string;
  emne: string;
  besked: string;
  handels_ref: string | null;
  trade_id: string | null;
  bot_samtale_id: string | null;
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
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { admin } = await kraevSideRolle("medarbejder");
  const { vis, side: sideParam } = await searchParams;
  const visBesvarede = vis === "besvarede";
  const side = laesSide(sideParam);

  // Nye: ældste først (dem, der har ventet længst). Besvarede: nyeste først.
  const { data, error, count } = await admin
    .from("kontakt_henvendelser")
    .select("id, bruger_id, email, emne, besked, handels_ref, trade_id, bot_samtale_id, status, besvaret_af, besvaret_kl, oprettet_kl", {
      count: "exact",
    })
    .eq("status", visBesvarede ? "besvaret" : "ny")
    .order(visBesvarede ? "besvaret_kl" : "oprettet_kl", { ascending: !visBesvarede })
    .range((side - 1) * PR_SIDE, side * PR_SIDE - 1);
  const henvendelser = (data ?? []) as Henvendelse[];
  const antal = count ?? henvendelser.length;

  const brugerIds = [
    ...new Set(henvendelser.flatMap((h) => [h.bruger_id, h.besvaret_af]).filter((x): x is string => !!x)),
  ];
  const { data: brugere } = brugerIds.length
    ? await admin.from("users").select("id, navn").in("id", brugerIds)
    : { data: [] as { id: string; navn: string | null }[] };
  const navnMap = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));

  const href = (v: string | null, s = 1) => adminHref("/admin/kontakt", { vis: v, side: s });

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Henvendelser"
        forklaring="Beskeder fra kontaktformularen og chats med brugere. Tryk Svar – beskeden sendes i staff-chatten, og henvendelsen markeres som besvaret."
        hoejre={
          <span className="text-sm text-tekst-daempet">
            {antal} {antal === 1 ? "henvendelse" : "henvendelser"}
          </span>
        }
      />
      <HenvendelserFaner aktiv="kontakt" />
      <AdminFilterChips
        label="Vis"
        aktiv={visBesvarede ? "besvarede" : "nye"}
        chips={[
          { id: "nye", label: "Nye", href: href(null) },
          { id: "besvarede", label: "Besvarede", href: href("besvarede") },
        ]}
      />

      {error && <AdminFejl hvad="Henvendelserne" />}

      {!error && henvendelser.length === 0 ? (
        <AdminTom
          tekst={visBesvarede ? "Ingen besvarede henvendelser endnu." : "Der er ingen nye henvendelser."}
          link={visBesvarede ? undefined : { href: "/admin/chats", label: "Se chats" }}
        />
      ) : (
        <ul className="space-y-3">
          {henvendelser.map((h) => {
            const brugerNavn = h.bruger_id ? navnMap.get(h.bruger_id) : null;
            const emneTekst = kontaktEmneNavn(h.emne);
            const mailBody = KONTAKT_SVAR[0].tekst;
            return (
              <li
                key={h.id}
                className={`rounded-none border bg-white p-4 sm:p-5 ${h.status === "ny" ? "border-advarsel-kant" : "border-admin-kant"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-tekst">{emneTekst}</p>
                    <p className="mt-0.5 break-all text-xs text-tekst-svag">
                      {tid(h.oprettet_kl)} · {h.email}
                      {h.bruger_id ? (
                        <>
                          {" · "}
                          <Link href={`/admin/brugere/${h.bruger_id}`} className="text-groen hover:underline">
                            {brugerNavn ?? "Bruger"}
                          </Link>
                        </>
                      ) : (
                        " · ikke logget ind"
                      )}
                    </p>
                  </div>
                  {(h.trade_id || h.handels_ref) && (
                    <span className="max-w-full break-all rounded-md bg-admin-graa px-2 py-1 text-xs text-tekst">
                      Handel:{" "}
                      {h.trade_id ? (
                        <Link href={`/admin/handler/${h.trade_id}`} className="font-medium text-groen hover:underline">
                          {h.trade_id.slice(0, 8)}
                        </Link>
                      ) : (
                        h.handels_ref
                      )}
                    </span>
                  )}
                </div>

                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-tekst">{h.besked}</p>
                {h.bot_samtale_id && (
                  <p className="mt-2 text-xs text-tekst-svag">
                    Teksten ovenfor er en kopi, og brugerens linjer står efter &quot;&gt; &quot;. Den rigtige samtale står her:{" "}
                    <Link href={`/admin/bot/${h.bot_samtale_id}`} className="font-medium text-groen hover:underline">
                      Se hele samtalen med BidHamr-bot
                    </Link>
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {h.status === "ny" ? (
                    <>
                      {h.bruger_id ? (
                        <SkrivTilBrugerKnap
                          brugerId={h.bruger_id}
                          brugerNavn={brugerNavn ?? "brugeren"}
                          tradeId={h.trade_id}
                          knapTekst="Svar"
                          titel={`Svar ${brugerNavn ?? "brugeren"}`}
                          emne={`Re: ${emneTekst}`.slice(0, 120)}
                          skabeloner={KONTAKT_SVAR}
                          henvendelseId={h.id}
                          kvittering="Svaret er sendt"
                        />
                      ) : (
                        <a
                          href={`mailto:${encodeURIComponent(h.email)}?subject=${encodeURIComponent(`Re: ${emneTekst} – BidHamr`)}&body=${encodeURIComponent(mailBody)}`}
                          className="btn btn-primaer btn-lille"
                        >
                          Svar på mail
                        </a>
                      )}
                      <AdminActionKnap
                        action={kontaktMarkerBesvaret}
                        hiddenFields={{ henvendelseId: h.id }}
                        label="Markér som besvaret"
                        kvittering="Henvendelsen er markeret som besvaret"
                      />
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-tekst-svag">
                        Besvaret af {h.besvaret_af ? (navnMap.get(h.besvaret_af) ?? "—") : "—"}
                        {h.besvaret_kl && ` · ${tid(h.besvaret_kl)}`}
                      </span>
                      <AdminActionKnap
                        action={kontaktGenaabn}
                        hiddenFields={{ henvendelseId: h.id }}
                        label="Genåbn"
                        kvittering="Henvendelsen er genåbnet"
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AdminSideskift
        side={side}
        harNaeste={side * PR_SIDE < antal}
        antalSider={Math.max(1, Math.ceil(antal / PR_SIDE))}
        lavHref={(s) => href(visBesvarede ? "besvarede" : null, s)}
      />
    </AdminSide>
  );
}
