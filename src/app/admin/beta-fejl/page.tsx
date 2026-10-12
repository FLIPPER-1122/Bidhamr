import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import BetaFejlRedigering from "@/components/admin/betafejl/BetaFejlRedigering";
import {
  ALVOR_KORT,
  BETA_FEJL_ALVOR,
  BETA_FEJL_BUCKET,
  BETA_FEJL_STATUS,
  STATUS_NAVN,
  erAlvor,
  erBetaFejlStatus,
  type BetaFejlAlvor,
  type BetaFejlStatus,
} from "@/lib/betaFejl";
import AdminSide from "@/components/admin/AdminSide";
import { BetaFaner } from "@/components/admin/OmraadeFaner";

export const metadata: Metadata = { title: "Beta-fejl", robots: { index: false, follow: false } };

// Admin -> Beta-fejl: fejl meldt af beta-testere og staff via "Meld fejl"
// (20261018020000_beta_fejl.sql). Admin og chef. Fejl slettes aldrig - de får
// en status (ny, i gang, løst, afvist) og en intern note.

const PR_SIDE = 25;
const MAKS_SIDER = 20;

type BetaFejl = {
  id: string;
  bruger_id: string | null;
  sti: string | null;
  alvor: BetaFejlAlvor;
  tekst: string;
  forventet: string | null;
  browser: string | null;
  skaerm: string | null;
  billeder: string[];
  status: BetaFejlStatus;
  staff_note: string | null;
  opdateret_kl: string | null;
  oprettet_kl: string;
};

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });

const ALVOR_FARVE: Record<BetaFejlAlvor, string> = {
  blokerer: "border-fejl-kant bg-fejl-bg text-fejl-tekst",
  irriterende: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
  lille: "border-info-kant bg-info-bg text-info-tekst",
};

const STATUS_FARVE: Record<BetaFejlStatus, string> = {
  ny: "bg-orange-lys text-advarsel-tekst",
  i_gang: "bg-info-bg text-info-tekst",
  loest: "bg-succes-bg text-succes-tekst",
  afvist: "bg-neutral-100 text-tekst-daempet",
};

// "aabne" (standard) = ny + i gang.
type StatusFilter = BetaFejlStatus | "aabne" | "alle";

function filterUrl(status: StatusFilter, alvor: BetaFejlAlvor | null, side?: number) {
  const p = new URLSearchParams();
  if (status !== "aabne") p.set("status", status);
  if (alvor) p.set("alvor", alvor);
  if (side && side > 1) p.set("side", String(side));
  const q = p.toString();
  return q ? `/admin/beta-fejl?${q}` : "/admin/beta-fejl";
}

function Fane({ href, aktiv, children }: { href: string; aktiv: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={aktiv ? "page" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full px-3 text-sm ${
        aktiv ? "bg-groen text-white" : "bg-neutral-100 text-tekst hover:bg-neutral-200"
      }`}
    >
      {children}
    </Link>
  );
}

export default async function AdminBetaFejlSide({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; alvor?: string; side?: string }>;
}) {
  const { admin } = await kraevSideRolle("admin");
  const sp = await searchParams;
  const status: StatusFilter =
    sp.status === "alle" ? "alle" : erBetaFejlStatus(sp.status) ? sp.status : "aabne";
  const alvor = erAlvor(sp.alvor) ? sp.alvor : null;
  const side = Math.min(MAKS_SIDER, Math.max(1, Number.parseInt(sp.side ?? "1", 10) || 1));
  const antal = side * PR_SIDE;

  let q = admin
    .from("beta_fejl")
    .select(
      "id, bruger_id, sti, alvor, tekst, forventet, browser, skaerm, billeder, status, staff_note, opdateret_kl, oprettet_kl",
    )
    .order("oprettet_kl", { ascending: false })
    .limit(antal + 1);
  if (status === "aabne") q = q.in("status", ["ny", "i_gang"]);
  else if (status !== "alle") q = q.eq("status", status);
  if (alvor) q = q.eq("alvor", alvor);
  const { data, error } = await q;
  const raekker = (data ?? []) as BetaFejl[];
  const flere = raekker.length > antal;
  const fejl = raekker.slice(0, antal);

  // Navne og signerede billedlinks (1 time) - samtidig.
  const brugerIds = [...new Set(fejl.map((f) => f.bruger_id).filter((x): x is string => !!x))];
  const stier = fejl.flatMap((f) => f.billeder ?? []);
  const [brugereSvar, linkSvar] = await Promise.all([
    brugerIds.length
      ? admin.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string | null }[] }),
    stier.length
      ? admin.storage.from(BETA_FEJL_BUCKET).createSignedUrls(stier, 3600)
      : Promise.resolve({ data: [] as { path: string | null; signedUrl: string }[] }),
  ]);
  const navnMap = new Map(
    ((brugereSvar.data ?? []) as { id: string; navn: string | null; email: string | null }[]).map((u) => [
      u.id,
      u.navn || u.email || "Uden navn",
    ]),
  );
  const linkMap = new Map(
    ((linkSvar.data ?? []) as { path: string | null; signedUrl: string }[])
      .filter((l) => l.path && l.signedUrl)
      .map((l) => [l.path as string, l.signedUrl]),
  );

  const statusFaner: [StatusFilter, string][] = [
    ["aabne", "Åbne"],
    ...BETA_FEJL_STATUS.map((s) => [s, STATUS_NAVN[s]] as [StatusFilter, string]),
    ["alle", "Alle"],
  ];

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Beta-test"
        forklaring="Fejl meldt af beta-testerne med knappen Meld fejl. Skift status, når du går i gang, og skriv en note til de andre. Fejl, der blokerer, sender en alarm-mail."
        hoejre={
          error ? undefined : (
            <span className="text-sm text-tekst-svag">
              {fejl.length}
              {flere ? "+" : ""} fejl
            </span>
          )
        }
      />
      <BetaFaner aktiv="fejl" />

      <div className="space-y-2">
        <nav aria-label="Status" className="flex flex-wrap gap-2">
          {statusFaner.map(([s, navn]) => (
            <Fane key={s} href={filterUrl(s, alvor)} aktiv={status === s}>
              {navn}
            </Fane>
          ))}
        </nav>
        <nav aria-label="Alvor" className="flex flex-wrap gap-2">
          <Fane href={filterUrl(status, null)} aktiv={!alvor}>
            Alle grader
          </Fane>
          {BETA_FEJL_ALVOR.map((a) => (
            <Fane key={a} href={filterUrl(status, a)} aktiv={alvor === a}>
              {ALVOR_KORT[a]}
            </Fane>
          ))}
        </nav>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Fejlene kunne ikke hentes. Er migrationen 20261018020000_beta_fejl.sql kørt?
        </p>
      )}

      {!error && fejl.length === 0 && (
        <p className="rounded-[14px] border border-admin-kant bg-white p-6 text-center text-sm text-tekst-daempet">
          Ingen fejl her.
        </p>
      )}

      <ul className="space-y-3">
        {fejl.map((f) => (
          <li key={f.id} className="rounded-[14px] border border-admin-kant bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${ALVOR_FARVE[f.alvor]}`}>
                {ALVOR_KORT[f.alvor]}
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_FARVE[f.status]}`}>
                {STATUS_NAVN[f.status]}
              </span>
              <span className="text-xs text-tekst-svag">
                {tid(f.oprettet_kl)}
                {" · "}
                {f.bruger_id ? (
                  <Link href={`/admin/brugere/${f.bruger_id}`} className="hover:underline">
                    {navnMap.get(f.bruger_id) ?? "Bruger"}
                  </Link>
                ) : (
                  "Slettet bruger"
                )}
              </span>
            </div>

            {f.sti && (
              <p className="mt-2 break-all font-mono text-xs text-tekst-daempet">
                Side: <span className="text-tekst">{f.sti}</span>
              </p>
            )}

            <div className="mt-3 space-y-3 text-sm text-tekst">
              <div>
                <p className="text-xs font-medium text-tekst-svag">Hvad gjorde de, og hvad skete der?</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{f.tekst}</p>
              </div>
              {f.forventet && (
                <div>
                  <p className="text-xs font-medium text-tekst-svag">Hvad havde de forventet?</p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words">{f.forventet}</p>
                </div>
              )}
            </div>

            {(f.billeder ?? []).length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {f.billeder.map((sti, i) => {
                  const url = linkMap.get(sti);
                  return (
                    <li key={sti}>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block h-24 w-24 overflow-hidden rounded-lg border border-admin-kant bg-neutral-100"
                        >
                          {/* Signeret link (1 time) fra den private bucket - vises uden optimering. */}
                          <Image
                            src={url}
                            alt={`Skærmbillede ${i + 1}`}
                            width={96}
                            height={96}
                            unoptimized
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        </a>
                      ) : (
                        <span className="flex h-24 w-24 items-center justify-center rounded-lg border border-admin-kant bg-neutral-100 text-center text-xs text-tekst-svag">
                          Billedet mangler
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <details className="mt-3 text-xs text-tekst-daempet">
              <summary className="cursor-pointer select-none py-1">Browser og skærm</summary>
              <p className="mt-1 break-words">{f.skaerm ?? "Ukendt skærm"}</p>
              <p className="mt-1 break-words font-mono">{f.browser ?? "Ukendt browser"}</p>
            </details>

            <BetaFejlRedigering
              id={f.id}
              status={f.status}
              staffNote={f.staff_note}
              opdateretKl={f.opdateret_kl ? tid(f.opdateret_kl) : null}
            />
          </li>
        ))}
      </ul>

      {flere && side < MAKS_SIDER && (
        <div className="flex justify-center">
          <Link href={filterUrl(status, alvor, side + 1)} scroll={false} className="btn btn-sekundaer">
            Vis flere
          </Link>
        </div>
      )}
    </AdminSide>
  );
}
