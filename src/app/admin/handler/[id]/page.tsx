import Link from "next/link";
import { notFound } from "next/navigation";
import { harMindstRolle, kraevSideRolle } from "@/lib/adminAuth";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminBadge from "@/components/admin/AdminBadge";
import HandelStatusBadge from "@/components/HandelStatusBadge";
import HandelHandlinger, { kr } from "@/components/admin/handler/HandelHandlinger";
import { HAENGER_TEKST, erHaengerGrund, type HaengerGrund } from "@/lib/adminGraenser";
import { SPORINGS_NAVN, erSporingsType, transportoerNavn } from "@/lib/fragt/types";
import { UUID_RE, handlingNavn, visAarsag } from "@/lib/moderationLog";
import { sidsteStaffBeskedOmHandel } from "@/lib/admin/paamindelse";
import { SAG_TYPE_NAVN, adminSagSti, type SagStatus, type SagType } from "@/lib/sager";
import { SAG_STATUS_KORT } from "@/components/sager/visning";

// Detaljeside for én handel (docs/ADMIN-REDESIGN.md 4.5, punkt 23): samler
// handel, betaling, fragt, sager, chat og log ét sted. Tidligere linkede man
// til en søgning (/admin/handler?vis=alle&q=<id>). Ingen databaseændring -
// data hentes som på Handler. Medarbejder og op; beløbsdetaljer kun chef.

export const metadata = { title: "Handel" };

const TZ = "Europe/Copenhagen";
const tid = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }) : "–";

const oere = (v: number | null | undefined) =>
  v == null ? "–" : (v / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

type Handel = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  created_at: string;
  sag_aaben: boolean;
  sag_note: string | null;
  sag_aabnet_at: string | null;
  afhentning: boolean | null;
};

type Betaling = {
  status: string;
  frigivet_kl: string | null;
  refusion_anmodet_kl: string | null;
  refunderet_kl: string | null;
  sidste_fejl: string | null;
  kraever_opmaerksomhed: boolean | null;
  total_oere?: number | null;
  udbetaling_oere?: number | null;
  fragt_oere?: number | null;
  koebergebyr_oere?: number | null;
  beskyttelse_oere?: number | null;
};

type Forsendelse = {
  id: string;
  type: "udgaaende" | "retur";
  status: string;
  transportoer: string | null;
  sporingsnummer: string | null;
  opmaerksomhed_tekst: string | null;
  kraever_opmaerksomhed: boolean | null;
  opdateret_kl: string;
  returneret_kl: string | null;
  leveret_kl: string | null;
};

const BETALING_NAVN: Record<string, string> = {
  afventer: "Afventer betaling",
  behandles: "Behandles",
  betalt: "Betalt",
  annulleret: "Annulleret",
  refunderet: "Refunderet",
};

function Kort({ titel, children, hoejre }: { titel: string; children: React.ReactNode; hoejre?: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-tekst">{titel}</h2>
        {hoejre}
      </div>
      {children}
    </section>
  );
}

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-tekst-svag">{navn}</dt>
      <dd className="mt-0.5 break-words text-sm text-tekst">{children}</dd>
    </div>
  );
}

export default async function AdminHandel({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const kanFlyttePenge = harMindstRolle(rolle, "admin");
  const erChef = rolle === "chef";

  const { data: h } = await admin
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, amount, status, tracking_number, created_at, sag_aaben, sag_note, sag_aabnet_at, afhentning")
    .eq("id", id)
    .maybeSingle<Handel>();
  if (!h) notFound();

  const betalingKolonner = `status, frigivet_kl, refusion_anmodet_kl, refunderet_kl, sidste_fejl, kraever_opmaerksomhed${
    erChef ? ", total_oere, udbetaling_oere, fragt_oere, koebergebyr_oere, beskyttelse_oere" : ""
  }`;

  const [auktion, brugere, betaling, forsendelser, sager, log, haengende] = await Promise.all([
    admin.from("auctions").select("id, titel").eq("id", h.auction_id).maybeSingle<{ id: string; titel: string }>(),
    admin.from("users").select("id, navn, email").in("id", [h.buyer_id, h.seller_id]),
    admin.from("betalinger").select(betalingKolonner).eq("trade_id", h.id).maybeSingle(),
    admin
      .from("forsendelser")
      .select("id, type, status, transportoer, sporingsnummer, opmaerksomhed_tekst, kraever_opmaerksomhed, opdateret_kl, returneret_kl, leveret_kl")
      .eq("trade_id", h.id)
      .order("opdateret_kl", { ascending: false })
      .limit(10),
    admin.from("sager").select("id, status, type, oprettet_kl").eq("trade_id", h.id).order("oprettet_kl", { ascending: false }).limit(10),
    admin
      .from("moderation_log")
      .select("id, handling, aarsag, oprettet_kl, medarbejder_id")
      .eq("maal_type", "handel")
      .eq("maal_id", h.id)
      .order("oprettet_kl", { ascending: false })
      .limit(30),
    admin.rpc("admin_haengende_handler"),
  ]);

  const navne = new Map(((brugere.data ?? []) as { id: string; navn: string | null; email: string }[]).map((u) => [u.id, u]));
  const logRaekker = (log.data ?? []) as { id: string; handling: string; aarsag: string | null; oprettet_kl: string; medarbejder_id: string | null }[];
  const staffIds = [...new Set(logRaekker.map((l) => l.medarbejder_id).filter((x): x is string => !!x))];
  const { data: staff } = staffIds.length
    ? await admin.from("users").select("id, navn").in("id", staffIds)
    : { data: [] as { id: string; navn: string | null }[] };
  const staffNavn = new Map((staff ?? []).map((s) => [s.id as string, (s.navn as string | null) ?? "ukendt"]));

  const titel = auktion.data?.titel ?? "(slettet auktion)";
  const koeber = navne.get(h.buyer_id);
  const saelger = navne.get(h.seller_id);
  const b = (betaling.data ?? null) as Betaling | null;
  const fs = (forsendelser.data ?? []) as Forsendelse[];
  const haenger = ((haengende.data ?? []) as { trade_id: string; grund: unknown; siden: string }[]).find((r) => r.trade_id === h.id);
  const haengerGrund: HaengerGrund | null = haenger && erHaengerGrund(haenger.grund) ? haenger.grund : null;
  const paamindBruger = haengerGrund ? (haengerGrund === "ikke_sendt" ? h.seller_id : h.buyer_id) : null;
  const sidstPaamindet = paamindBruger
    ? ((await sidsteStaffBeskedOmHandel(admin, [{ tradeId: h.id, brugerId: paamindBruger }]))?.get(`${h.id}:${paamindBruger}`) ?? null)
    : null;
  const returMeldt = fs.some(
    (f) => f.type === "udgaaende" && f.status !== "annulleret" && f.status !== "fejlet" && !!f.returneret_kl && !f.leveret_kl,
  );

  return (
    <AdminSide detalje>
      <AdminSideHoved
        tilbage={{ href: "/admin/handler?vis=alle", label: "Handler" }}
        badges={
          <>
            <HandelStatusBadge status={h.status} />
            {h.sag_aaben && <AdminBadge tone="roed">Markeret – pengene er frosset</AdminBadge>}
            {haengerGrund && <AdminBadge tone="gul">{HAENGER_TEKST[haengerGrund]}</AdminBadge>}
            {b?.kraever_opmaerksomhed && <AdminBadge tone="roed">Betalingen kræver opmærksomhed</AdminBadge>}
          </>
        }
        titel={titel}
        forklaring={`Handel ${h.id.slice(0, 8)} · oprettet ${tid(h.created_at)} · bud ${kr(h.amount)}`}
      />

      <div className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
        <HandelHandlinger
          h={h}
          titel={titel}
          koeber={{ id: h.buyer_id, navn: koeber?.navn ?? "Køber" }}
          saelger={{ id: h.seller_id, navn: saelger?.navn ?? "Sælger" }}
          haenger={haengerGrund}
          returMeldt={returMeldt}
          kanFlyttePenge={kanFlyttePenge}
          kanSkriveFaelles={kanFlyttePenge}
          visAabn={false}
          sidstPaamindet={sidstPaamindet}
        />
        {h.sag_aaben && h.sag_note && (
          <p className="mt-3 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
            Markeret {tid(h.sag_aabnet_at)}: {h.sag_note}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Parter">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Felt navn="Køber">
              <Link href={`/admin/brugere/${h.buyer_id}`} className="font-medium text-groen hover:underline">
                {koeber?.navn ?? "Uden navn"}
              </Link>
              {koeber?.email && <span className="block text-xs text-tekst-daempet">{koeber.email}</span>}
            </Felt>
            <Felt navn="Sælger">
              <Link href={`/admin/brugere/${h.seller_id}`} className="font-medium text-groen hover:underline">
                {saelger?.navn ?? "Uden navn"}
              </Link>
              {saelger?.email && <span className="block text-xs text-tekst-daempet">{saelger.email}</span>}
            </Felt>
            <Felt navn="Auktion">
              <Link href={`/auktion/${h.auction_id}`} className="font-medium text-groen hover:underline">
                {titel}
              </Link>
            </Felt>
            <Felt navn="Levering">{h.afhentning ? "Afhentning" : "Forsendelse"}</Felt>
          </dl>
        </Kort>

        <Kort titel="Betaling">
          {b ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Felt navn="Status">{BETALING_NAVN[b.status] ?? b.status}</Felt>
              <Felt navn="Frigivet til sælger">{b.frigivet_kl ? tid(b.frigivet_kl) : "Nej"}</Felt>
              <Felt navn="Refusion anmodet">{b.refusion_anmodet_kl ? tid(b.refusion_anmodet_kl) : "Nej"}</Felt>
              <Felt navn="Refunderet">{b.refunderet_kl ? tid(b.refunderet_kl) : "Nej"}</Felt>
              {erChef && (
                <>
                  <Felt navn="Betalt i alt">{oere(b.total_oere)}</Felt>
                  <Felt navn="Til sælger">{oere(b.udbetaling_oere)}</Felt>
                  <Felt navn="Fragt">{oere(b.fragt_oere)}</Felt>
                  <Felt navn="Købergebyr">{oere(b.koebergebyr_oere)}</Felt>
                  <Felt navn="BidHamr Beskyttelse">{oere(b.beskyttelse_oere)}</Felt>
                </>
              )}
              {b.sidste_fejl && (
                <div className="sm:col-span-2">
                  <Felt navn="Sidste fejl">
                    <span className="text-fejl-tekst">{b.sidste_fejl}</span>
                  </Felt>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-tekst-daempet">Ingen betaling endnu.</p>
          )}
          {b?.kraever_opmaerksomhed && (
            <Link href="/admin/betalinger" className="mt-3 inline-flex text-sm font-semibold text-groen hover:underline">
              Gå til Betalingsfejl →
            </Link>
          )}
        </Kort>
      </div>

      <Kort titel={`Fragt (${fs.length})`}>
        {h.tracking_number && (
          <p className="mb-3 text-sm text-tekst-daempet">
            Sporingsnummer: <span className="select-all font-mono text-tekst">{h.tracking_number}</span>
          </p>
        )}
        {fs.length === 0 ? (
          <p className="text-sm text-tekst-daempet">Ingen forsendelser.</p>
        ) : (
          <ul className="space-y-2">
            {fs.map((f) => (
              <li
                key={f.id}
                className={`rounded-lg border px-3 py-2 text-sm ${f.kraever_opmaerksomhed ? "border-advarsel-kant bg-advarsel-bg" : "border-admin-kant"}`}
              >
                <p className="font-medium text-tekst">
                  {f.type === "retur" ? "Returpakke" : "Pakke til køber"} ·{" "}
                  {erSporingsType(f.status) ? SPORINGS_NAVN[f.status] : f.status}
                </p>
                <p className="text-xs text-tekst-daempet">
                  {transportoerNavn(f.transportoer) && <span>{transportoerNavn(f.transportoer)} · </span>}
                  {f.sporingsnummer && <span className="break-all font-mono">{f.sporingsnummer} · </span>}
                  opdateret {tid(f.opdateret_kl)}
                </p>
                {f.kraever_opmaerksomhed && f.opmaerksomhed_tekst && (
                  <p className="mt-1 text-advarsel-tekst">{f.opmaerksomhed_tekst}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {fs.some((f) => f.kraever_opmaerksomhed) && (
          <Link href="/admin/handler?vis=fragt" className="mt-3 inline-flex text-sm font-semibold text-groen hover:underline">
            Løs det under Fragt →
          </Link>
        )}
      </Kort>

      <Kort titel={`Sager (${(sager.data ?? []).length})`}>
        {(sager.data ?? []).length === 0 ? (
          <p className="text-sm text-tekst-daempet">Køberen har ikke oprettet en sag.</p>
        ) : (
          <ul className="space-y-2">
            {((sager.data ?? []) as { id: string; status: SagStatus; type: SagType; oprettet_kl: string }[]).map((s) => (
              <li key={s.id}>
                <Link href={adminSagSti(s.id)} className="flex flex-wrap items-center gap-2 rounded-lg border border-admin-kant px-3 py-2 text-sm hover:bg-admin-bg">
                  <AdminBadge tone={s.status === "aaben" ? "gul" : "graa"}>{SAG_STATUS_KORT[s.status] ?? s.status}</AdminBadge>
                  <span className="font-medium text-tekst">{SAG_TYPE_NAVN[s.type]?.split(" (")[0] ?? s.type}</span>
                  <span className="text-tekst-daempet">· {tid(s.oprettet_kl)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Kort>

      <Kort titel="Log">
        {logRaekker.length === 0 ? (
          <p className="text-sm text-tekst-daempet">Ingen handlinger fra BidHamr på handlen endnu.</p>
        ) : (
          <ol className="space-y-3">
            {logRaekker.map((l) => (
              <li key={l.id} className="border-l-2 border-admin-kant pl-3 text-sm">
                <p className="font-medium text-tekst">{handlingNavn(l.handling)}</p>
                <p className="text-xs text-tekst-svag">
                  {tid(l.oprettet_kl)} · {l.medarbejder_id ? (staffNavn.get(l.medarbejder_id) ?? "ukendt") : "system"}
                </p>
                {l.aarsag && <p className="mt-1 whitespace-pre-wrap break-words text-tekst-daempet">{visAarsag(l.handling, l.aarsag)}</p>}
              </li>
            ))}
          </ol>
        )}
      </Kort>
    </AdminSide>
  );
}
