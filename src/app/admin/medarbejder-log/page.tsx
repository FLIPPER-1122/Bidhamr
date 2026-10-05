import Link from "next/link";
import type { ReactNode } from "react";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import {
  HANDLING_NAVNE,
  UUID_RE,
  erSystem,
  handelChatSti,
  handlingNavn,
  maalLink,
  maalNavn,
  visAarsag,
} from "@/lib/moderationLog";

// Medarbejder-log: alt fra moderation_log. Admin og chef ser alle; en
// medarbejder ser kun sin egen log (håndhæves her på serveren – filteret
// tvinges til medarbejderens eget id). Data via admin_medarbejder_log
// (service_role). Fritekst om gamle saldo-handlinger (kan indeholde beløb)
// vises kun for chef.

const PR_SIDE = 50;
const TZ = "Europe/Copenhagen";
const DATO_RE = /^\d{4}-\d{2}-\d{2}$/;

type LogRaekke = {
  id: string;
  oprettet_kl: string;
  medarbejder_id: string;
  medarbejder_navn: string | null;
  er_system: boolean;
  handling: string;
  maal_type: string;
  maal_id: string;
  bruger_id: string | null;
  bruger_navn: string | null;
  bruger_email: string | null;
  aarsag: string | null;
  total_antal: number;
};

type Person = { id: string; navn: string | null; rolle: string | null; er_system: boolean };

// Midnat dansk tid for en dato (YYYY-MM-DD) som ISO-tidspunkt med offset.
function koebenhavnMidnat(dato: string, plusDage = 0): string | null {
  if (!DATO_RE.test(dato)) return null;
  const [y, m, d] = dato.split("-").map(Number);
  // 00:00 UTC ligger altid før sommertidsskiftet (kl. 2/3 dansk tid), så
  // offset'et her er det, der gælder ved dansk midnat samme dag.
  const utc = new Date(Date.UTC(y, m - 1, d + plusDage));
  if (Number.isNaN(utc.getTime())) return null;
  const del = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(utc)
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = del?.replace("GMT", "") || "+00:00";
  return `${utc.toISOString().slice(0, 10)}T00:00:00${offset}`;
}

// Tekniske id'er (uuid) i fritekst vises små og forkortede, så teksten er
// til at læse. Hele id'et står i tooltip.
const UUID_I_TEKST = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function laesbarTekst(tekst: string): ReactNode[] {
  const dele: ReactNode[] = [];
  let sidst = 0;
  for (const m of tekst.matchAll(UUID_I_TEKST)) {
    const start = m.index ?? 0;
    if (start > sidst) dele.push(tekst.slice(sidst, start));
    dele.push(
      <span key={start} title={m[0]} className="font-mono text-[11px] text-neutral-400">
        #{m[0].slice(0, 8)}
      </span>,
    );
    sidst = start + m[0].length;
  }
  if (sidst < tekst.length) dele.push(tekst.slice(sidst));
  return dele;
}

// "Gav advarsel" -> "gav advarsel", så det kan stå efter et navn.
function smaatForrest(t: string): string {
  return t ? t.charAt(0).toLocaleLowerCase("da-DK") + t.slice(1) : t;
}

function enkelt(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

export default async function MedarbejderLog({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId, rolle, admin } = await assertRole("medarbejder");
  const kanSeAlle = harMindstRolle(rolle, "admin");

  const sp = await searchParams;
  const medarbejderParam = enkelt(sp.medarbejder);
  const handling = enkelt(sp.handling);
  const fra = enkelt(sp.fra);
  const til = enkelt(sp.til);
  const bruger = enkelt(sp.bruger).slice(0, 200);
  const side = Math.max(1, Math.floor(Number(enkelt(sp.side))) || 1);

  // Medarbejdere ser kun deres egen log, uanset hvad der står i URL'en.
  const medarbejder = kanSeAlle
    ? UUID_RE.test(medarbejderParam)
      ? medarbejderParam.toLowerCase()
      : ""
    : userId;
  const handlingGyldig = handling && handling in HANDLING_NAVNE ? handling : "";
  const fraIso = fra ? koebenhavnMidnat(fra) : null;
  const tilIso = til ? koebenhavnMidnat(til, 1) : null;

  const [logRes, personerRes] = await Promise.all([
    admin.rpc("admin_medarbejder_log", {
      p_medarbejder: medarbejder || null,
      p_handling: handlingGyldig || null,
      p_fra: fraIso,
      p_til: tilIso,
      p_bruger: bruger || null,
      p_graense: PR_SIDE,
      p_offset: (side - 1) * PR_SIDE,
      p_vis_saldo: rolle === "chef",
    }),
    kanSeAlle
      ? admin.rpc("admin_medarbejder_log_personer")
      : Promise.resolve({ data: [] as Person[], error: null }),
  ]);
  if (logRes.error) console.error("admin_medarbejder_log fejlede:", logRes.error);
  if (personerRes.error) console.error("admin_medarbejder_log_personer fejlede:", personerRes.error);

  const raekker = (logRes.data ?? []) as LogRaekke[];
  const personer = (personerRes.data ?? []) as Person[];
  const total = raekker[0] ? Number(raekker[0].total_antal) : 0;
  const sider = Math.max(1, Math.ceil(total / PR_SIDE));

  const brugerErId = UUID_RE.test(bruger);
  const filterBrugerRaekke = brugerErId
    ? raekker.find((r) => (r.bruger_id ?? "").toLowerCase() === bruger.toLowerCase())
    : undefined;
  const filterBrugerNavn = filterBrugerRaekke
    ? filterBrugerRaekke.bruger_navn ?? filterBrugerRaekke.bruger_email ?? null
    : null;

  const sideHref = (n: number, valg: { udenBruger?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (kanSeAlle && medarbejder) p.set("medarbejder", medarbejder);
    if (handlingGyldig) p.set("handling", handlingGyldig);
    if (fraIso) p.set("fra", fra);
    if (tilIso) p.set("til", til);
    if (bruger && !valg.udenBruger) p.set("bruger", bruger);
    if (n > 1) p.set("side", String(n));
    return `/admin/medarbejder-log${p.size ? `?${p}` : ""}`;
  };

  const handlinger = Object.entries(HANDLING_NAVNE).sort((a, b) => a[1].localeCompare(b[1], "da"));
  const feltKlasse =
    "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Medarbejder-log"
        forklaring={
          kanSeAlle
            ? "Alt, hvad medarbejdere og systemet har gjort i admin – nyeste først. Brug den, når du vil se, hvem der gjorde hvad."
            : "Alt, hvad du har gjort i admin – nyeste først."
        }
      />

      <form
        method="get"
        action="/admin/medarbejder-log"
        className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {kanSeAlle && (
          <label className="text-xs font-medium text-neutral-600">
            Medarbejder
            <select name="medarbejder" defaultValue={medarbejder} className={`mt-1 ${feltKlasse}`}>
              <option value="">Alle</option>
              {personer.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.er_system ? "System" : p.navn ?? "Uden navn"}
                  {!p.er_system && p.rolle && p.rolle !== "bruger" ? ` (${p.rolle})` : ""}
                  {!p.er_system && (!p.rolle || p.rolle === "bruger") ? " (tidligere staff)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-xs font-medium text-neutral-600">
          Handling
          <select name="handling" defaultValue={handlingGyldig} className={`mt-1 ${feltKlasse}`}>
            <option value="">Alle handlinger</option>
            {handlinger.map(([vaerdi, navn]) => (
              <option key={vaerdi} value={vaerdi}>
                {navn}
              </option>
            ))}
          </select>
        </label>
        {brugerErId ? (
          // Kommer man fra en brugers side, filtreres der på brugerens id. Vis
          // navnet i stedet for id'et.
          <div className="text-xs font-medium text-neutral-600">
            Bruger
            <input type="hidden" name="bruger" value={bruger} />
            <p className="mt-1 flex min-h-10 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-normal text-neutral-800">
              <span className="truncate">{filterBrugerNavn ?? "Én bestemt bruger"}</span>
              <Link href={sideHref(1, { udenBruger: true })} className="shrink-0 text-xs font-medium text-groen hover:underline">
                Fjern
              </Link>
            </p>
          </div>
        ) : (
          <label className="text-xs font-medium text-neutral-600">
            Bruger (navn eller e-mail)
            <input name="bruger" type="search" defaultValue={bruger} className={`mt-1 ${feltKlasse}`} />
          </label>
        )}
        <label className="text-xs font-medium text-neutral-600">
          Fra dato
          <input name="fra" type="date" defaultValue={fraIso ? fra : ""} className={`mt-1 ${feltKlasse}`} />
        </label>
        <label className="text-xs font-medium text-neutral-600">
          Til og med dato
          <input name="til" type="date" defaultValue={tilIso ? til : ""} className={`mt-1 ${feltKlasse}`} />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="min-h-10 flex-1 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
          >
            Filtrér
          </button>
          <Link
            href="/admin/medarbejder-log"
            className="inline-flex min-h-10 items-center rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Nulstil
          </Link>
        </div>
      </form>

      {logRes.error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          Loggen kunne ikke hentes. Prøv igen om lidt.
        </p>
      )}

      {!logRes.error && (
        <p className="text-sm text-neutral-500">
          {total === 0
            ? side > 1
              ? "Ingen poster på denne side."
              : "Ingen poster med de valgte filtre."
            : `${total.toLocaleString("da-DK")} ${total === 1 ? "post" : "poster"} · side ${side} af ${sider}`}
        </p>
      )}

      <ul className="space-y-2">
        {raekker.map((r) => {
          const link = maalLink(r.maal_type, r.maal_id, r.bruger_id, {
            handling: r.handling,
            kanSeAdminAuktioner: kanSeAlle,
          });
          const visBruger = r.bruger_id && !erSystem(r.bruger_id);
          return (
            <li key={r.id} className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 text-sm text-neutral-900">
                  <span className="font-semibold">
                    {r.er_system ? "Systemet" : r.medarbejder_navn ?? "Ukendt medarbejder"}
                  </span>{" "}
                  {smaatForrest(handlingNavn(r.handling))}
                  {visBruger && (
                    <>
                      {" – "}
                      <Link href={`/admin/brugere/${r.bruger_id}`} className="font-medium text-neutral-900 hover:underline">
                        {r.bruger_navn ?? r.bruger_email ?? "ukendt bruger"}
                      </Link>
                    </>
                  )}
                </p>
                <time dateTime={r.oprettet_kl} className="text-xs text-neutral-500">
                  {new Date(r.oprettet_kl).toLocaleString("da-DK", { timeZone: TZ })}
                </time>
              </div>
              {r.aarsag && (
                <p className="mt-2 whitespace-pre-line break-words text-sm text-neutral-700">{laesbarTekst(visAarsag(r.handling, r.aarsag))}</p>
              )}
              <p className="mt-2 text-xs text-neutral-500">
                {maalNavn(r.maal_type)}
                {link && (
                  <>
                    {" · "}
                    <Link href={link.href} className="font-medium text-groen hover:underline">
                      {link.label}
                    </Link>
                  </>
                )}
                {r.maal_type === "handel" && UUID_RE.test(r.maal_id) && (
                  <>
                    {" · "}
                    {/* prefetch slået fra: siden logger læsningen af chatten. */}
                    <Link
                      href={handelChatSti(r.maal_id)}
                      prefetch={false}
                      className="font-medium text-neutral-700 hover:underline"
                    >
                      Se chat
                    </Link>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {(side > 1 || side < sider) && (
        <nav aria-label="Sider" className="flex items-center justify-between gap-3">
          {side > 1 ? (
            <Link
              href={sideHref(side - 1)}
              className="inline-flex min-h-10 items-center rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Forrige
            </Link>
          ) : (
            <span />
          )}
          {side < sider && (
            <Link
              href={sideHref(side + 1)}
              className="inline-flex min-h-10 items-center rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Næste
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
