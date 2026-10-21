import Link from "next/link";
import { notFound } from "next/navigation";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminBadge from "@/components/admin/AdminBadge";
import EkstraFragtStaffHandlinger, { EkstraFragtNote } from "@/components/admin/ekstraFragt/EkstraFragtStaffHandlinger";
import { EkstraFragtStatusBadge, oereKr } from "@/components/admin/ekstraFragt/visning";
import { kraevSideRolle } from "@/lib/adminAuth";
import { erInhabil } from "@/lib/admin/sagTaget";
import { erSystem } from "@/lib/moderationLog";
import type { EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";
import { ekstraFragtTid, maalingTekst, valgtStoerrelseNavn } from "@/lib/ekstraFragt/visning";
import { transportoerNavn } from "@/lib/fragt/types";

// Én regning for ekstra fragt: fragtfirmaets måling og dokumentation,
// sælgerens indsigelse, tidslinje, intern note og knapperne (frafald, afgør
// indsigelse). Kun staff (kraevSideRolle). Ingen ændringer ved visning.

export const metadata = { title: "Ekstra fragt" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Regning = {
  id: string;
  trade_id: string;
  saelger_id: string;
  transportoer: string | null;
  sporingsnummer: string | null;
  valgt_stoerrelse: string;
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
  maalt_maal: string | null;
  beloeb_oere: number;
  fragtfirma_fakturanummer: string;
  forklaring: string | null;
  dokumentation_navn: string | null;
  status: EkstraFragtStatus;
  frist: string;
  oprettet_af: string;
  oprettet_kl: string;
  betalt_kl: string | null;
  indsigelse_tekst: string | null;
  indsigelse_kl: string | null;
  afgoerelse: "frafaldet" | "fastholdt" | null;
  afgoerelse_begrundelse: string | null;
  afgjort_kl: string | null;
  afgjort_af: string | null;
  frafaldet_kl: string | null;
  frafaldet_af: string | null;
  frafald_grund: string | null;
  refunderet_kl: string | null;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
  sidste_fejl: string | null;
  intern_note: string | null;
};

const KOLONNER =
  "id, trade_id, saelger_id, transportoer, sporingsnummer, valgt_stoerrelse, maalt_stoerrelse, maalt_vaegt_gram, maalt_maal, beloeb_oere, fragtfirma_fakturanummer, forklaring, dokumentation_navn, status, frist, oprettet_af, oprettet_kl, betalt_kl, indsigelse_tekst, indsigelse_kl, afgoerelse, afgoerelse_begrundelse, afgjort_kl, afgjort_af, frafaldet_kl, frafaldet_af, frafald_grund, refunderet_kl, kraever_opmaerksomhed, opmaerksomhed_tekst, sidste_fejl, intern_note";

function Kort({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold text-tekst">{titel}</h2>
      {children}
    </section>
  );
}

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-t border-admin-kant py-2.5 first:border-t-0">
      <dt className="text-xs text-tekst-svag">{navn}</dt>
      <dd className="mt-0.5 break-words text-sm text-tekst">{children}</dd>
    </div>
  );
}

export default async function AdminEkstraFragtRegning({ params }: { params: Promise<{ id: string }> }) {
  const { admin, userId } = await kraevSideRolle("medarbejder");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const { data: r, error } = await admin.from("ekstra_fragt_regninger").select(KOLONNER).eq("id", id.toLowerCase()).maybeSingle<Regning>();
  if (error) throw new Error(`Regningen kunne ikke hentes: ${error.message}`);
  if (!r) notFound();

  const { data: handel } = await admin
    .from("trades")
    .select("buyer_id, seller_id, auction_id")
    .eq("id", r.trade_id)
    .maybeSingle<{ buyer_id: string | null; seller_id: string | null; auction_id: string | null }>();
  const personIds = [
    ...new Set([r.saelger_id, r.oprettet_af, r.afgjort_af, r.frafaldet_af].filter((x): x is string => !!x && !erSystem(x))),
  ];
  const [{ data: auktion }, { data: personer }, inhabil] = await Promise.all([
    handel?.auction_id
      ? admin.from("auctions").select("titel").eq("id", handel.auction_id).maybeSingle<{ titel: string | null }>()
      : Promise.resolve({ data: null }),
    admin.from("users").select("id, navn").in("id", personIds),
    erInhabil(admin, userId, handel?.buyer_id ?? null, handel?.seller_id ?? null),
  ]);
  const navn = new Map(((personer ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]));
  const hvem = (pid: string | null) => (!pid ? "ukendt" : erSystem(pid) ? "BidHamr (automatisk)" : (navn.get(pid) ?? "ukendt"));
  const firma = transportoerNavn(r.transportoer);
  const spaerrer = r.status === "afventer_betaling" && Date.parse(r.frist) <= new Date().getTime();

  // Tidslinjen udledes af regningens egne tidsstempler (præcis for denne regning).
  const tidslinje: { kl: string; titel: string; hvem: string; tekst?: string | null }[] = [
    { kl: r.oprettet_kl, titel: `Regning oprettet (${oereKr(r.beloeb_oere)})`, hvem: hvem(r.oprettet_af), tekst: r.forklaring },
    ...(r.indsigelse_kl ? [{ kl: r.indsigelse_kl, titel: "Sælgeren gjorde indsigelse", hvem: "Sælgeren", tekst: r.indsigelse_tekst }] : []),
    ...(r.afgjort_kl && r.afgoerelse
      ? [
          {
            kl: r.afgjort_kl,
            titel: r.afgoerelse === "fastholdt" ? "Indsigelsen afvist – regningen fastholdt" : "Indsigelsen godkendt – regningen frafaldet",
            hvem: hvem(r.afgjort_af),
            tekst: r.afgoerelse_begrundelse,
          },
        ]
      : []),
    ...(r.frafaldet_kl && r.afgoerelse !== "frafaldet"
      ? [{ kl: r.frafaldet_kl, titel: "Regningen frafaldet", hvem: hvem(r.frafaldet_af), tekst: r.frafald_grund }]
      : []),
    ...(r.betalt_kl ? [{ kl: r.betalt_kl, titel: "Sælgeren betalte", hvem: "Sælgeren" }] : []),
    ...(r.refunderet_kl ? [{ kl: r.refunderet_kl, titel: "Betalingen er refunderet", hvem: "Stripe" }] : []),
  ].sort((a, b) => Date.parse(a.kl) - Date.parse(b.kl));

  return (
    <AdminSide detalje>
      <AdminSideHoved
        tilbage={{ href: "/admin/ekstra-fragt", label: "Ekstra fragt" }}
        badges={
          <>
            <EkstraFragtStatusBadge status={r.status} spaerrer={spaerrer} />
            {r.kraever_opmaerksomhed && <AdminBadge tone="roed">Kræver opmærksomhed</AdminBadge>}
            {firma && <AdminBadge tone="graa">{firma}</AdminBadge>}
          </>
        }
        titel={`Ekstra fragt: ${oereKr(r.beloeb_oere)}`}
        forklaring={
          <>
            {auktion?.titel ?? "(slettet auktion)"} · Sælger: {navn.get(r.saelger_id) ?? "Uden navn"}
            {r.status === "afventer_betaling" && <> · Frist {ekstraFragtTid(r.frist)}</>}
          </>
        }
      />

      {r.kraever_opmaerksomhed && r.opmaerksomhed_tekst && (
        <p role="note" className="rounded-[14px] border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          {r.opmaerksomhed_tekst}
        </p>
      )}

      {r.status === "indsigelse" && r.indsigelse_tekst && (
        <section className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-4 text-fejl-tekst sm:p-5">
          <h2 className="text-base font-semibold">Sælgerens indsigelse ({ekstraFragtTid(r.indsigelse_kl)})</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{r.indsigelse_tekst}</p>
        </section>
      )}

      <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
        <EkstraFragtStaffHandlinger regningId={r.id} status={r.status} inhabil={inhabil} />
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-admin-kant pt-4 text-sm">
          <Link href={`/admin/handler/${r.trade_id}`} className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
            Se handlen →
          </Link>
          <Link href={`/admin/brugere/${r.saelger_id}`} className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
            Se sælgeren →
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Fragtfirmaets måling">
          <dl>
            <Felt navn="Sælgeren valgte">{valgtStoerrelseNavn(r.valgt_stoerrelse)}</Felt>
            <Felt navn="Fragtfirmaet målte">{maalingTekst(r)}</Felt>
            <Felt navn="Beløb (inkl. moms)">{oereKr(r.beloeb_oere)}</Felt>
            <Felt navn="Fragtfirmaets fakturanummer">
              <span className="select-all">{r.fragtfirma_fakturanummer}</span>
            </Felt>
            {r.sporingsnummer && (
              <Felt navn="Sporingsnummer">
                <span className="select-all break-all font-mono">{r.sporingsnummer}</span>
              </Felt>
            )}
            <Felt navn="Dokumentation">{r.dokumentation_navn ?? "Fragtfirmaets faktura"}</Felt>
            {r.forklaring && <Felt navn="Forklaring til sælgeren">{r.forklaring}</Felt>}
            {r.sidste_fejl && (
              <Felt navn="Sidste betalingsfejl">
                <span className="text-fejl-tekst">{r.sidste_fejl}</span>
              </Felt>
            )}
          </dl>
        </Kort>

        <div className="space-y-5">
          <Kort titel="Tidslinje">
            <ol className="space-y-3">
              {tidslinje.map((t, i) => (
                <li key={`${t.kl}-${i}`} className="border-l-2 border-admin-kant pl-3 text-sm">
                  <p className="font-medium text-tekst">{t.titel}</p>
                  <p className="text-xs text-tekst-svag">
                    {ekstraFragtTid(t.kl)} · {t.hvem}
                  </p>
                  {t.tekst && <p className="mt-1 whitespace-pre-wrap break-words text-tekst-daempet">{t.tekst}</p>}
                </li>
              ))}
            </ol>
          </Kort>
          <Kort titel="Intern note">
            {inhabil ? (
              <p className="text-sm text-tekst-daempet">Du er inhabil og kan ikke skrive en note.</p>
            ) : (
              <EkstraFragtNote regningId={r.id} note={r.intern_note} />
            )}
          </Kort>
        </div>
      </div>
    </AdminSide>
  );
}
