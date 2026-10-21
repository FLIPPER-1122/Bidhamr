import Link from "next/link";
import { notFound } from "next/navigation";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminBadge from "@/components/admin/AdminBadge";
import { SagBilleder, type VistSagBillede } from "@/components/sager/visning";
import ReklamationStaffHandlinger, { ReklamationNote } from "@/components/admin/reklamation/ReklamationStaffHandlinger";
import {
  REKLAMATION_LOG_HANDLINGER,
  REKLAMATION_LOG_NAVN,
  ReklamationStatusBadge,
  dageSiden,
  erSagAendret,
  erStille,
  reklamationTid,
} from "@/components/admin/reklamation/visning";
import KopierKnap from "@/components/reklamation/KopierKnap";
import { kraevSideRolle } from "@/lib/adminAuth";
import { erInhabil } from "@/lib/admin/sagTaget";
import { erSystem } from "@/lib/moderationLog";
import { adminSagSti } from "@/lib/sager";
import { hentReklamationspakke, type PakkeBillede, type PakkePart } from "@/lib/reklamation/pakke";
import { kroner } from "@/lib/reklamation/typer";

// Én reklamation hos fragtfirmaet: hele pakken (som sælgeren ser den - plus
// købers kontaktoplysninger), billeder, tidslinje, intern note og knapperne.
// Kun staff (kraevSideRolle). Ingen ændringer ved visning.

export const metadata = { title: "Reklamation" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Kort({ titel, hoejre, children }: { titel: string; hoejre?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900">{titel}</h2>
        {hoejre}
      </div>
      {children}
    </section>
  );
}

function partTekst(p: PakkePart): string | null {
  const by = [p.postnummer, p.by].filter(Boolean).join(" ");
  return [p.navn, p.adresse, by, p.telefon, p.email].filter(Boolean).join(", ") || null;
}

function Felt({ navn, vaerdi, lang = false, kopier = true }: { navn: string; vaerdi: string | null; lang?: boolean; kopier?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-t border-admin-kant py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <dt className="text-xs uppercase text-neutral-500">{navn}</dt>
        <dd className={`mt-0.5 break-words text-sm text-neutral-800 ${lang ? "whitespace-pre-wrap" : ""}`}>{vaerdi ?? "–"}</dd>
      </div>
      {kopier && vaerdi && <KopierKnap tekst={vaerdi} label={navn.toLowerCase()} />}
    </div>
  );
}

function somVist(b: PakkeBillede): VistSagBillede {
  return { id: b.id, kategori: b.kategori as VistSagBillede["kategori"], url: b.url, oprettetKl: b.oprettetKl };
}

export default async function AdminReklamation({ params }: { params: Promise<{ id: string }> }) {
  const { admin, userId } = await kraevSideRolle("medarbejder");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const res = await hentReklamationspakke(admin, id.toLowerCase(), "staff");
  if (!res || !res.pakke.staff) notFound();
  const p = res.pakke;
  const r = p.staff!;

  const [{ data: handel }, { data: log }] = await Promise.all([
    admin
      .from("trades")
      .select("buyer_id, seller_id")
      .eq("id", r.trade_id)
      .maybeSingle<{ buyer_id: string | null; seller_id: string | null }>(),
    admin
      .from("moderation_log")
      .select("medarbejder_id, handling, aarsag, oprettet_kl")
      .eq("maal_type", "sag")
      .eq("maal_id", r.sag_id)
      .in("handling", REKLAMATION_LOG_HANDLINGER)
      .order("oprettet_kl", { ascending: true })
      .limit(100),
  ]);
  const logRaekker = (log ?? []) as { medarbejder_id: string | null; handling: string; aarsag: string | null; oprettet_kl: string }[];
  const personIds = [
    ...new Set(
      [r.saelger_id, handel?.buyer_id, ...logRaekker.map((l) => l.medarbejder_id)].filter(
        (x): x is string => !!x && !erSystem(x),
      ),
    ),
  ];
  const [{ data: personer }, inhabil] = await Promise.all([
    personIds.length ? admin.from("users").select("id, navn").in("id", personIds) : Promise.resolve({ data: [] }),
    erInhabil(admin, userId, handel?.buyer_id ?? null, handel?.seller_id ?? null),
  ]);
  const navn = new Map(((personer ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]));
  const hvem = (id: string | null) =>
    !id ? "ukendt" : erSystem(id) ? "BidHamr (automatisk)" : (navn.get(id) ?? "ukendt");

  const nu = new Date().getTime();
  const stille = erStille(r.status, r.fremdrift_kl, nu);
  const aendret = erSagAendret(r.status, r.sag_aendret_kl);
  const saelgerBilleder = p.billeder.filter((b) => b.kilde === "saelger_pakke");
  const koeberBilleder = p.billeder.filter((b) => b.kilde === "koeber_skade");

  return (
    <AdminSide detalje>
      <AdminSideHoved
        tilbage={{ href: "/admin/reklamationer", label: "Reklamationer" }}
        badges={
          <>
            <ReklamationStatusBadge status={r.status} lang />
            {aendret && <AdminBadge tone="roed">Sagen er ændret efter anmeldelsen</AdminBadge>}
            {stille && <AdminBadge tone="roed">Stille i {dageSiden(r.fremdrift_kl, nu)} dage</AdminBadge>}
            <AdminBadge tone="graa">{p.transportoerNavn}</AdminBadge>
          </>
        }
        titel={p.varetitel ?? "(slettet auktion)"}
        forklaring={
          <>
            Sælger: {navn.get(r.saelger_id) ?? "Uden navn"} · Krav {kroner(p.kravbeloebOere)}
            {r.godkendt_beloeb_oere != null && <> · Godkendt {kroner(r.godkendt_beloeb_oere)}</>}
            {r.transportoerens_sagsnummer && <> · {p.transportoerNavn}s sagsnummer {r.transportoerens_sagsnummer}</>}
          </>
        }
      />

      {aendret && (
        <p role="note" className="rounded-[14px] border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          Sagen er ændret {reklamationTid(r.sag_aendret_kl)}, efter sælgeren anmeldte skaden. Tjek sagen, og ret
          reklamationens status, hvis det er nødvendigt.
        </p>
      )}

      <section className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
        <ReklamationStaffHandlinger
          reklamationId={r.id}
          sagId={r.sag_id}
          status={r.status}
          kravbeloebOere={r.kravbeloeb_oere}
          sagsnummer={r.transportoerens_sagsnummer}
          inhabil={inhabil}
        />
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-admin-kant pt-4 text-sm">
          <Link href={adminSagSti(r.sag_id)} className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
            Se sagen →
          </Link>
          <Link href={`/admin/handler/${r.trade_id}`} className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
            Se handlen →
          </Link>
          <a href={`/admin/reklamationer/${r.id}/billeder`} download className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
            Hent alle billeder (ZIP)
          </a>
          {p.anmeldUrl && (
            <a href={p.anmeldUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline sm:min-h-0">
              Åbn {p.transportoerNavn}s anmeldelse ↗
            </a>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Oplysninger til anmeldelsen" hoejre={<KopierKnap tekst={p.tekst} label="alle oplysninger" />}>
          <dl>
            <Felt navn="Trackingnummer" vaerdi={p.trackingnummer} />
            {p.forsendelsesId && <Felt navn="Forsendelses-id" vaerdi={p.forsendelsesId} />}
            <Felt navn="Afsender" vaerdi={partTekst(p.afsender)} />
            <Felt navn="Modtager" vaerdi={partTekst(p.modtager)} />
            <Felt navn="Afsendt" vaerdi={p.afsendtKl ? reklamationTid(p.afsendtKl) : null} />
            <Felt navn="Leveret" vaerdi={p.leveretKl ? reklamationTid(p.leveretKl) : null} />
            <Felt navn="Varens værdi" vaerdi={kroner(p.varensVaerdiOere)} />
            <Felt navn="Kravbeløb" vaerdi={kroner(p.kravbeloebOere)} />
            {p.maksErstatningOere != null && <Felt navn={`${p.transportoerNavn}s maks. erstatning`} vaerdi={kroner(p.maksErstatningOere)} kopier={false} />}
            {p.pakkestoerrelse && <Felt navn="Pakkestørrelse" vaerdi={p.pakkestoerrelse} kopier={false} />}
            {p.vaegtGram != null && <Felt navn="Vægt" vaerdi={`${(p.vaegtGram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 2 })} kg`} kopier={false} />}
          </dl>
        </Kort>

        <div className="space-y-5">
          <Kort titel="Skaden og varen">
            <dl>
              <Felt navn="Skadebeskrivelse (fra køberen)" vaerdi={p.skadebeskrivelse} lang />
              <Felt navn="Varebeskrivelse" vaerdi={p.varebeskrivelse} lang kopier={false} />
            </dl>
          </Kort>
          <Kort titel="Intern note">
            <ReklamationNote reklamationId={r.id} sagId={r.sag_id} note={r.intern_note} inhabil={inhabil} />
          </Kort>
        </div>
      </div>

      <Kort titel={`Sælgerens billeder af indpakningen (${saelgerBilleder.length})`}>
        {saelgerBilleder.length > 0 ? (
          <SagBilleder billeder={saelgerBilleder.map(somVist)} stor />
        ) : (
          <p className="text-sm text-neutral-500">Ingen pakkebilleder.</p>
        )}
      </Kort>

      <Kort titel={`Køberens billeder af skaden (${koeberBilleder.length})`}>
        {koeberBilleder.length > 0 ? (
          <SagBilleder billeder={koeberBilleder.map(somVist)} stor />
        ) : (
          <p className="text-sm text-neutral-500">Køberen har ikke tilføjet billeder.</p>
        )}
        {p.billeder.length > 0 && (
          <p className="mt-3 text-xs text-neutral-500">Linkene udløber efter en time – genindlæs siden for nye.</p>
        )}
      </Kort>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Tidslinje">
          {logRaekker.length === 0 ? (
            <p className="text-sm text-neutral-500">Oprettet {reklamationTid(r.oprettet_kl)}.</p>
          ) : (
            <ol className="space-y-3">
              {logRaekker.map((l, i) => (
                <li key={`${l.oprettet_kl}-${i}`} className="border-l-2 border-admin-kant pl-3 text-sm">
                  <p className="font-medium text-neutral-800">{REKLAMATION_LOG_NAVN[l.handling] ?? l.handling}</p>
                  <p className="text-xs text-neutral-500">
                    {reklamationTid(l.oprettet_kl)} · {l.handling.startsWith("reklamation_saelger_") ? "Sælgeren" : hvem(l.medarbejder_id)}
                  </p>
                  {l.aarsag && <p className="mt-1 whitespace-pre-wrap break-words text-neutral-700">{l.aarsag}</p>}
                </li>
              ))}
            </ol>
          )}
        </Kort>

        <Kort titel={`Sporing (${p.sporingshistorik.length})`}>
          {p.sporingshistorik.length === 0 ? (
            <p className="text-sm text-neutral-500">Ingen sporingshændelser.</p>
          ) : (
            <ol className="space-y-2">
              {p.sporingshistorik.map((h, i) => (
                <li key={`${h.tidspunkt}-${i}`} className="text-sm">
                  <span className="text-xs text-neutral-500">{reklamationTid(h.tidspunkt)}</span>
                  <span className="block text-neutral-800">{h.beskrivelse ?? h.type}</span>
                </li>
              ))}
            </ol>
          )}
        </Kort>
      </div>
    </AdminSide>
  );
}
