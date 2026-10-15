import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { sendVinderBesked, traekNyVinder, traekVinder } from "@/app/actions/adminKonkurrence";
import { vinderMailStatus, vinderSamtale } from "@/lib/konkurrence/vinderBesked";
import { denneMaaned, erMaaned, forrigeMaaned } from "@/lib/konkurrence/regler";
import { KONKURRENCE_ADMIN, maanedNavn } from "@/lib/tekster/konkurrence";

// Admin → Konkurrence (KUN chef): den månedlige lodtrækning om et gavekort.
// Viser deltagerne for en valgt måned med antal lod, de udelukkede sælgere
// med grund, CSV med kun de nødvendige felter, "Træk vinder" (vægtet efter
// antal lod, kryptografisk seed på serveren) og loggen over trækninger med
// "Træk ny vinder" (kræver begrundelse). Alt regnes i databasen
// (20261023020000_badge_konkurrence.sql).

export const dynamic = "force-dynamic";

export const metadata = { title: "Konkurrence", robots: { index: false, follow: false } };

type Deltager = { bruger_id: string; navn: string | null; antal_lod: number };
type Udelukket = { bruger_id: string; navn: string | null; antal_salg: number; grund: string };
type Traekning = {
  id: string;
  nr: number;
  trukket_kl: string;
  trukket_af_navn: string | null;
  antal_deltagere: number;
  antal_lod: number;
  liste_hash: string;
  seed: string;
  vinder_lod: number;
  vinder_id: string;
  vinder_navn: string | null;
  vinder_email: string | null;
  grund: string | null;
  begrundelse: string | null;
  svarfrist: string;
  erstattet_kl: string | null;
  erstattet_af_navn: string | null;
};
type Oversigt = {
  kode: string;
  maaned: string;
  denne_maaned: string;
  maaned_slut: boolean;
  deltagere: Deltager[];
  udelukkede: Udelukket[];
  traekninger: Traekning[];
  gaeldende_id: string | null;
  start_maaned: string | null;
  max_nye_vindere: number;
  svarfrist_dage: number;
};
type ListeRaekke = {
  bruger_id: string;
  navn: string | null;
  antal_lod: number;
  foerste_lod: number | null;
  sidste_lod: number | null;
  fastfrosset: boolean;
};

const tidspunkt = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Copenhagen",
  });

const LINK = "font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

export default async function AdminKonkurrence({ searchParams }: { searchParams: Promise<{ maaned?: string }> }) {
  const { userId, admin } = await kraevSideRolle("chef");
  const nu = denneMaaned();
  const { maaned: maanedParam } = await searchParams;
  // Standard: sidste måned (den, der skal trækkes).
  const maaned = erMaaned(maanedParam) && maanedParam <= nu ? maanedParam : forrigeMaaned(nu);

  // De seneste 12 måneder fra oktober 2026 (hvor konkurrencen er bygget).
  const maaneder: string[] = [];
  for (let m = nu; maaneder.length < 12 && m >= "2026-10"; m = forrigeMaaned(m)) maaneder.push(m);
  if (!maaneder.includes(maaned)) maaneder.push(maaned);

  const [{ data, error }, { data: listeData, error: listeFejl }] = await Promise.all([
    admin.rpc("konkurrence_admin_oversigt", { p_chef: userId, p_maaned: maaned }),
    admin.rpc("konkurrence_admin_liste", { p_chef: userId, p_maaned: maaned }),
  ]);
  const o = (data ?? null) as Oversigt | null;

  if (error || listeFejl || !o || o.kode !== "ok") {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold text-tekst">{KONKURRENCE_ADMIN.titel}</h1>
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Oversigten kunne ikke hentes (er migrationen 20261023020000_badge_konkurrence.sql kørt?).
        </p>
      </div>
    );
  }

  const liste = (listeData ?? []) as ListeRaekke[];
  const fastfrosset = liste.some((r) => r.fastfrosset);
  const lodIalt = liste.reduce((s, r) => s + r.antal_lod, 0);
  const gaeldende = o.traekninger.find((t) => t.id === o.gaeldende_id) ?? null;
  const foerStart = !o.start_maaned || maaned < o.start_maaned;
  const nyeVindere = gaeldende ? gaeldende.nr - 1 : 0;
  const loftNaaet = nyeVindere >= o.max_nye_vindere;
  const tidligereVindere = new Set(o.traekninger.filter((t) => t.erstattet_kl).map((t) => t.vinder_id));
  // Samtalen med den gældende vinder (åbnes automatisk ved trækningen).
  const samtale = gaeldende ? await vinderSamtale(admin, gaeldende.id) : null;
  // Mailens faktiske status (notifikation_afsendelser), ikke bare om samtalen findes.
  const mailStatus = gaeldende
    ? await vinderMailStatus(admin, gaeldende.id, samtale && samtale !== "fejl" ? samtale : null)
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <AdminSideHoved
        titel={`${KONKURRENCE_ADMIN.titel} – ${maanedNavn(maaned)}`}
        forklaring={KONKURRENCE_ADMIN.forklaring}
        hjaelp={
          <>
            <p>
              Lodtrækningen er vægtet: hver lod har samme chance, så en sælger med 6 lod har seks gange så stor chance
              som en med 1. Når du trækker, fastfryses listen, og databasen laver et tilfældigt seed (32 bytes fra
              en kryptografisk generator) i samme transaktion. Vinderloddet = SHA-256(seed + listens hash) modulo antal lod + 1. Tidspunkt,
              hvem der trak, antal lod, hash, seed og vinder gemmes og kan ikke ændres.
            </p>
            <p>
              Svarer vinderen ikke, eller opfylder vinderen ikke betingelserne, kan du trække en ny vinder med en
              grund. Den trækkes på den samme fastfrosne liste uden de tidligere vindere. &quot;Svarer ikke&quot; kan først
              vælges, når svarfristen er udløbet, og der kan højst trækkes én ny vinder pr. måned.
            </p>
          </>
        }
        hoejre={
          <a href={`/admin/konkurrence/csv?maaned=${maaned}`} className="btn btn-sekundaer btn-lille" download>
            Hent CSV
          </a>
        }
      >
        <nav className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Vælg måned">
          {maaneder
            .sort((a, b) => (a < b ? 1 : -1))
            .map((m) => (
              <Link
                key={m}
                href={`/admin/konkurrence?maaned=${m}`}
                aria-current={m === maaned ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                  m === maaned ? "border-groen bg-groen text-white" : "border-kant-staerk bg-white text-tekst hover:bg-groen-lys"
                }`}
              >
                {maanedNavn(m)}
              </Link>
            ))}
        </nav>
      </AdminSideHoved>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Deltagere", liste.length],
          ["Lod i alt", lodIalt],
          ["Ikke med", o.udelukkede.length],
          [
            "Status",
            gaeldende
              ? "Vinder trukket"
              : foerStart
                ? "Før konkurrencens start"
                : o.maaned_slut
                  ? "Klar til lodtrækning"
                  : "Måneden er i gang",
          ],
        ].map(([t, n]) => (
          <div key={String(t)} className="rounded-xl border border-kant bg-white p-4">
            <dt className="text-[13px] text-tekst-daempet">{t}</dt>
            <dd className="mt-0.5 text-lg leading-tight font-bold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      {/* Lodtrækning */}
      <section className="rounded-[14px] border border-kant bg-white p-4">
        <h2 className="text-base font-semibold">Lodtrækning</h2>
        {gaeldende ? (
          <div className="mt-2 space-y-3 text-sm">
            <p>
              Vinder:{" "}
              <Link href={`/admin/brugere/${gaeldende.vinder_id}`} className={LINK}>
                {gaeldende.vinder_navn ?? "Ukendt"}
              </Link>
              {gaeldende.vinder_email && <span className="text-tekst-daempet"> · {gaeldende.vinder_email}</span>}
              <span className="text-tekst-daempet">
                {" "}
                · lod nr. {gaeldende.vinder_lod} af {gaeldende.antal_lod}
              </span>
            </p>
            <p className="text-tekst-daempet">
              Svarfrist: {tidspunkt(gaeldende.svarfrist)} ({o.svarfrist_dage} dage efter trækningen). Nye vindere:{" "}
              {nyeVindere} af højst {o.max_nye_vindere}.
            </p>
            {mailStatus && (
              <p role={mailStatus === "sendt" ? undefined : "status"} className={mailStatus === "sendt" ? "text-tekst-daempet" : "text-tekst"}>
                {KONKURRENCE_ADMIN.vinderMail[mailStatus]}
              </p>
            )}
            {samtale && samtale !== "fejl" ? (
              <p className="text-tekst-daempet">
                {KONKURRENCE_ADMIN.vinderSamtaleFindes}{" "}
                <Link href={`/admin/chats/${samtale}`} className={LINK}>
                  {KONKURRENCE_ADMIN.vinderSamtale}
                </Link>
              </p>
            ) : samtale === null ? (
              <div className="space-y-2">
                <p role="status" className="text-tekst">
                  {KONKURRENCE_ADMIN.vinderBeskedMangler}
                </p>
                <ConfirmDialog
                  triggerLabel={KONKURRENCE_ADMIN.vinderBeskedKnap}
                  title={KONKURRENCE_ADMIN.vinderBeskedKnap}
                  description={KONKURRENCE_ADMIN.vinderBeskedForklaring}
                  confirmLabel={KONKURRENCE_ADMIN.vinderBeskedKnap}
                  action={sendVinderBesked}
                  hiddenFields={{ traekning: gaeldende.id }}
                  kvittering={KONKURRENCE_ADMIN.vinderBeskedKvittering}
                />
              </div>
            ) : null}
            {loftNaaet ? (
              <p className="text-tekst-daempet">{KONKURRENCE_ADMIN.koder.loft_naaet}</p>
            ) : (
            <ConfirmDialog
              triggerLabel="Træk ny vinder"
              title="Træk en ny vinder"
              description={`${gaeldende.vinder_navn ?? "Vinderen"} tages ud, og der trækkes en ny vinder blandt de øvrige lod på den fastfrosne liste. Grunden gemmes i loggen.`}
              confirmLabel="Træk ny vinder"
              action={traekNyVinder}
              hiddenFields={{ traekning: gaeldende.id }}
              valgField={{
                name: "grund",
                label: "Hvorfor?",
                valg: Object.entries(KONKURRENCE_ADMIN.grundNyVinder).map(([value, label]) => ({ value, label })),
              }}
              aarsagField={{
                name: "begrundelse",
                label: "Uddybning (valgfri)",
                placeholder: "Fx: Skrevet på mail og i beskeder, intet svar.",
                required: false,
              }}
              kvittering="Der er trukket en ny vinder, og vinderen har fået besked."
              kanIkkeFortrydes
            />
            )}
          </div>
        ) : foerStart ? (
          <p className="mt-2 text-sm text-tekst-daempet">{KONKURRENCE_ADMIN.koder.foer_start}</p>
        ) : o.maaned_slut ? (
          liste.length === 0 ? (
            <p className="mt-2 text-sm text-tekst-daempet">{KONKURRENCE_ADMIN.koder.ingen_deltagere}</p>
          ) : (
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-tekst-daempet">
                {liste.length} deltager{liste.length === 1 ? "" : "e"} med {lodIalt} lod i alt. Listen fastfryses,
                når du trækker.
              </p>
              <ConfirmDialog
                triggerLabel="Træk vinder"
                triggerClassName="btn btn-primaer"
                title={`Træk vinderen for ${maanedNavn(maaned)}`}
                description="Listen fastfryses, og serveren trækker en vinder, vægtet efter antal lod. Trækningen logges og kan ikke laves om - kun en ny vinder med begrundelse."
                confirmLabel="Træk vinder"
                action={traekVinder}
                hiddenFields={{ maaned }}
                fakta={[
                  { label: "Deltagere", vaerdi: liste.length },
                  { label: "Lod i alt", vaerdi: lodIalt },
                ]}
                kvittering={KONKURRENCE_ADMIN.kvitteringTrukket}
                kanIkkeFortrydes
              />
            </div>
          )
        ) : (
          <p className="mt-2 text-sm text-tekst-daempet">{KONKURRENCE_ADMIN.koder.maaned_ikke_slut}</p>
        )}
      </section>

      {/* Log */}
      {o.traekninger.length > 0 && (
        <section className="rounded-[14px] border border-kant bg-white">
          <h2 className="border-b border-kant px-4 py-3 text-base font-semibold">Log over trækninger</h2>
          <ol className="divide-y divide-kant">
            {o.traekninger.map((t) => (
              <li key={t.id} className="px-4 py-3 text-sm">
                <p className="font-medium">
                  {t.nr === 1 ? "Første trækning" : `Ny vinder (${t.nr}. trækning)`} · {tidspunkt(t.trukket_kl)} ·{" "}
                  {t.trukket_af_navn ?? "Ukendt"}
                  {t.erstattet_kl ? (
                    <span className="ml-2 text-[12px] text-tekst-svag">
                      erstattet {tidspunkt(t.erstattet_kl)} af {t.erstattet_af_navn ?? "ukendt"}
                    </span>
                  ) : (
                    <span className="ml-2 text-[12px] text-succes-tekst">gældende</span>
                  )}
                </p>
                <p className="mt-0.5">
                  Vinder:{" "}
                  <Link href={`/admin/brugere/${t.vinder_id}`} className={LINK}>
                    {t.vinder_navn ?? "Ukendt"}
                  </Link>{" "}
                  · lod nr. {t.vinder_lod} af {t.antal_lod} · {t.antal_deltagere} deltager
                  {t.antal_deltagere === 1 ? "" : "e"}
                </p>
                {t.grund && (
                  <p className="mt-0.5 text-tekst-daempet">
                    Grund: {KONKURRENCE_ADMIN.grundNyVinder[t.grund] ?? t.grund}
                    {t.begrundelse ? ` – ${t.begrundelse}` : ""}
                  </p>
                )}
                <p className="mt-1 font-mono text-[11.5px] break-all text-tekst-svag">
                  Listens hash: {t.liste_hash}
                  <br />
                  Seed: {t.seed}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Deltagere */}
      <section className="rounded-[14px] border border-kant bg-white">
        <h2 className="border-b border-kant px-4 py-3 text-base font-semibold">
          {fastfrosset ? "Deltagere (fastfrosset ved trækningen)" : "Deltagere lige nu"} ({liste.length})
        </h2>
        {liste.length === 0 ? (
          <p className="px-4 py-3 text-sm text-tekst-daempet">Ingen deltagere i {maanedNavn(maaned)}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[13px] text-tekst-svag">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Sælger</th>
                  <th scope="col" className="px-4 py-2 font-medium">Lod</th>
                  {fastfrosset && <th scope="col" className="px-4 py-2 font-medium">Lod nr.</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-kant">
                {liste.map((r) => (
                  <tr key={r.bruger_id}>
                    <td className="px-4 py-2">
                      <Link href={`/admin/brugere/${r.bruger_id}`} className={LINK}>
                        {r.navn ?? "Ukendt"}
                      </Link>
                      {gaeldende?.vinder_id === r.bruger_id && (
                        <span className="ml-2 text-[12px] font-semibold text-succes-tekst">vinder</span>
                      )}
                      {tidligereVindere.has(r.bruger_id) && (
                        <span className="ml-2 text-[12px] text-tekst-svag">tidligere trukket</span>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{r.antal_lod}</td>
                    {fastfrosset && (
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                        {r.foerste_lod === r.sidste_lod ? r.foerste_lod : `${r.foerste_lod}–${r.sidste_lod}`}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Ikke med */}
      {o.udelukkede.length > 0 && (
        <details className="rounded-[14px] border border-kant bg-white">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 py-3 text-base font-semibold">
            Sælgere med salg, der ikke er med ({o.udelukkede.length})
          </summary>
          <ul className="divide-y divide-kant border-t border-kant">
            {o.udelukkede.map((u) => (
              <li key={u.bruger_id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm">
                <Link href={`/admin/brugere/${u.bruger_id}`} className={LINK}>
                  {u.navn ?? "Ukendt"}
                </Link>
                <span className="text-tekst-daempet">
                  {KONKURRENCE_ADMIN.grund[u.grund] ?? u.grund} · {u.antal_salg} salg
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
