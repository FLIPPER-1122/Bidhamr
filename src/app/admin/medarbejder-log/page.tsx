import Link from "next/link";
import { assertRole, harMindstRolle } from "@/lib/adminAuth";
import {
  HANDLING_NAVNE,
  UUID_RE,
  erSystem,
  handlingNavn,
  maalLink,
  maalNavn,
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

  const sideHref = (n: number) => {
    const p = new URLSearchParams();
    if (kanSeAlle && medarbejder) p.set("medarbejder", medarbejder);
    if (handlingGyldig) p.set("handling", handlingGyldig);
    if (fraIso) p.set("fra", fra);
    if (tilIso) p.set("til", til);
    if (bruger) p.set("bruger", bruger);
    if (n > 1) p.set("side", String(n));
    return `/admin/medarbejder-log${p.size ? `?${p}` : ""}`;
  };

  const handlinger = Object.entries(HANDLING_NAVNE).sort((a, b) => a[1].localeCompare(b[1], "da"));
  const feltKlasse =
    "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Medarbejder-log</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {kanSeAlle
            ? "Alt, hvad staff og systemet har gjort i admin – nyeste først."
            : "Alt, hvad du har gjort i admin – nyeste først."}
        </p>
      </div>

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
        <label className="text-xs font-medium text-neutral-600">
          Bruger (navn, e-mail eller id)
          <input name="bruger" type="search" defaultValue={bruger} className={`mt-1 ${feltKlasse}`} />
        </label>
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
          const link = maalLink(r.maal_type, r.maal_id, r.bruger_id);
          const visBruger = r.bruger_id && !erSystem(r.bruger_id);
          return (
            <li key={r.id} className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-neutral-900">{handlingNavn(r.handling)}</span>
                <time dateTime={r.oprettet_kl} className="text-xs text-neutral-400">
                  {new Date(r.oprettet_kl).toLocaleString("da-DK", { timeZone: TZ })}
                </time>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Af{" "}
                <span className="font-medium text-neutral-700">
                  {r.er_system ? "System" : r.medarbejder_navn ?? "Ukendt"}
                </span>
                {visBruger && (
                  <>
                    {" · Bruger: "}
                    <Link href={`/admin/brugere/${r.bruger_id}`} className="font-medium text-neutral-700 hover:underline">
                      {r.bruger_navn ?? r.bruger_email ?? "Ukendt"}
                    </Link>
                  </>
                )}
                {" · "}
                {maalNavn(r.maal_type)}
                {link && (
                  <>
                    {" – "}
                    <Link href={link.href} className="font-medium text-neutral-700 hover:underline">
                      {link.label}
                    </Link>
                  </>
                )}
              </p>
              {r.aarsag && (
                <p className="mt-2 whitespace-pre-line break-words text-sm text-neutral-700">{r.aarsag}</p>
              )}
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
