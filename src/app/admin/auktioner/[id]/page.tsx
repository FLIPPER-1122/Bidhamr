import Link from "next/link";
import { notFound } from "next/navigation";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { harMindstRolle, kraevSideRolle } from "@/lib/adminAuth";
import { hovedsiteUrl } from "@/lib/adminVaert";
import { erPaaPause, formatVarighed, intervalTilMs } from "@/lib/auctionTid";
import { standNavn } from "@/lib/stand";

// Auktionen, som staff ser den - også når den er skjult, arkiveret eller
// afventer kunst-kontrol. Med migration B (20261027020000_staff_rls_aal2.sql)
// ser staff kun disse auktioner på bidhamr.dk med to-trins-login, og admin og
// hovedsitet har hver sin session. Derfor linker admin hertil i stedet for til
// auktionssiden, og auktionssiden sender staff hertil, når en auktion ikke kan
// vises. Hentes med service role efter kraevSideRolle.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Auktion = {
  id: string;
  bruger_id: string;
  titel: string | null;
  beskrivelse: string | null;
  billeder: unknown;
  startpris: number | null;
  "nuværende_bud": number | null;
  antal_bud: number | null;
  status: string;
  slutter_kl: string | null;
  oprettet: string | null;
  kategori: string | null;
  stand: string | null;
  maerke: string | null;
  lokation: string | null;
  postnummer: string | null;
  skjult: boolean | null;
  arkiveret_kl: string | null;
  kunst_kontrol: string | null;
  pauset_kl: string | null;
  pause_resterende: string | null;
};

const KOLONNER =
  "id, bruger_id, titel, beskrivelse, billeder, startpris, nuværende_bud, antal_bud, status, slutter_kl, oprettet, " +
  "kategori, stand, maerke, lokation, postnummer, skjult, arkiveret_kl, kunst_kontrol, pauset_kl, pause_resterende";

const STATUS: Record<string, string> = { aktiv: "Aktiv", afsluttet: "Afsluttet", annulleret: "Annulleret" };

function tid(iso: string | null) {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const kr = (n: number | null) => (n == null ? "–" : `${Number(n).toLocaleString("da-DK")} kr.`);

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-tekst-svag">{navn}</dt>
      <dd className="mt-0.5 break-words text-sm text-tekst">{children}</dd>
    </div>
  );
}

function Maerke({ children, farve }: { children: React.ReactNode; farve: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${farve}`}>{children}</span>;
}

export default async function AdminAuktion({ params }: { params: Promise<{ id: string }> }) {
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const { data: a } = await admin.from("auctions").select(KOLONNER).eq("id", id).maybeSingle<Auktion>();
  if (!a) notFound();
  const [{ data: saelger }, { count: antalSpoergsmaal }] = await Promise.all([
    admin.from("users").select("navn, email").eq("id", a.bruger_id).maybeSingle<{ navn: string | null; email: string | null }>(),
    admin.from("auction_questions").select("id", { count: "exact", head: true }).eq("auction_id", id),
  ]);

  const billeder = Array.isArray(a.billeder)
    ? (a.billeder as unknown[]).filter((b): b is string => typeof b === "string" && /^https?:\/\//.test(b))
    : [];
  const pauset = erPaaPause(a);
  const kunstAfventer = a.kunst_kontrol === "afventer";
  // Kan en almindelig bruger se den på bidhamr.dk? (Samme regel som RLS for anon.)
  const offentlig = !a.skjult && !a.arkiveret_kl && !kunstAfventer;

  return (
    <AdminSide detalje>
      <AdminSideHoved
        titel={a.titel ?? "Auktion"}
        forklaring={
          offentlig
            ? "Auktionen er synlig for alle på bidhamr.dk."
            : "Auktionen kan ikke ses af andre end sælgeren, deltagerne og BidHamr."
        }
        tilbage={
          harMindstRolle(rolle, "admin")
            ? { href: `/admin/auktioner?q=${a.id}`, label: "Auktioner" }
            : { href: "/admin", label: "Admin" }
        }
        badges={
          <>
            <Maerke farve="bg-neutral-100 text-tekst-daempet">{STATUS[a.status] ?? a.status}</Maerke>
            {a.skjult && <Maerke farve="bg-neutral-200 text-tekst-daempet">Skjult</Maerke>}
            {a.arkiveret_kl && <Maerke farve="bg-neutral-200 text-tekst-daempet">Arkiveret</Maerke>}
            {kunstAfventer && <Maerke farve="bg-fejl-bg text-fejl-tekst">Afventer kunst-kontrol</Maerke>}
            {pauset && <Maerke farve="bg-amber-100 text-amber-700">På pause</Maerke>}
          </>
        }
        hoejre={
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
            <Link href={`/admin/auktioner/${a.id}/spoergsmaal`} className="inline-flex min-h-11 items-center text-groen hover:underline sm:min-h-9">
              Spørgsmål til sælger ({antalSpoergsmaal ?? 0})
            </Link>
            {harMindstRolle(rolle, "admin") && (
              <Link href={`/admin/auktioner?q=${a.id}`} className="inline-flex min-h-11 items-center text-groen hover:underline sm:min-h-9">
                Skjul, vis eller annullér
              </Link>
            )}
            {offentlig && (
              <a href={hovedsiteUrl(`/auktion/${a.id}`)} className="inline-flex min-h-11 items-center text-groen hover:underline sm:min-h-9">
                Se på bidhamr.dk
              </a>
            )}
          </div>
        }
      />

      {billeder.length > 0 && (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Billeder">
          {billeder.map((b, i) => (
            <li key={b} className="shrink-0">
              <a href={b} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b}
                  alt={`${a.titel ?? "Auktion"} – billede ${i + 1}`}
                  className="h-32 w-32 rounded-xl border border-admin-kant object-cover sm:h-40 sm:w-40"
                />
              </a>
            </li>
          ))}
        </ul>
      )}

      <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Felt navn="Sælger">
            <Link href={`/admin/brugere/${a.bruger_id}`} className="font-medium text-groen hover:underline">
              {saelger?.navn ?? "Uden navn"}
            </Link>
            {saelger?.email && <span className="block text-xs text-tekst-daempet">{saelger.email}</span>}
          </Felt>
          <Felt navn="Startpris">{kr(a.startpris)}</Felt>
          <Felt navn="Højeste bud">
            {a["nuværende_bud"] != null ? `${kr(a["nuværende_bud"])} (${a.antal_bud ?? 0} bud)` : "Ingen bud"}
          </Felt>
          <Felt navn={pauset ? "Tid tilbage (på pause)" : "Slutter"}>
            {pauset ? formatVarighed(intervalTilMs(a.pause_resterende)) : tid(a.slutter_kl)}
          </Felt>
          <Felt navn="Oprettet">{tid(a.oprettet)}</Felt>
          <Felt navn="Varenummer">{a.id.slice(-6).toUpperCase()}</Felt>
          <Felt navn="Kategori">{a.kategori ?? "–"}</Felt>
          <Felt navn="Stand">{a.stand ? standNavn(a.stand) : "–"}</Felt>
          <Felt navn="Mærke">{a.maerke ?? "–"}</Felt>
          <Felt navn="Lokation">{[a.postnummer, a.lokation].filter(Boolean).join(" ") || "–"}</Felt>
        </dl>
      </section>

      <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
        <h2 className="mb-2 text-base font-semibold text-tekst">Beskrivelse</h2>
        <p className="whitespace-pre-line break-words text-[15px] text-tekst">{a.beskrivelse?.trim() || "Ingen beskrivelse."}</p>
      </section>
    </AdminSide>
  );
}
