import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminSideskift, { adminHref, laesSide } from "@/components/admin/AdminSideskift";
import { HenvendelserFaner } from "@/components/admin/OmraadeFaner";
import { botAktiv, botModel } from "@/lib/bot/konfig";

// BidHamr-bot i admin: samtalerne (medarbejder og op) og det samlede
// forbrug og den samlede pris (kun chef). Samtaler, hvor brugeren bad om en
// rigtig medarbejder, ligger også som henvendelse under Kontaktformular.

export const dynamic = "force-dynamic";

const PR_SIDE = 25;
const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

type Periode = {
  samtaler: number;
  beskeder: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  pris_usd: number;
  overdraget: number;
};

const PERIODER: [keyof Oversigt, string][] = [
  ["doegn", "Seneste døgn"],
  ["uge", "7 dage"],
  ["maaned", "30 dage"],
  ["alt", "I alt"],
];
type Oversigt = { doegn: Periode; uge: Periode; maaned: Periode; alt: Periode };

const usd = (v: number) => `$${Number(v).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const antal = (v: number) => Number(v).toLocaleString("da-DK");

type Samtale = {
  id: string;
  bruger_id: string | null;
  kilde: string;
  email: string | null;
  overdraget_kl: string | null;
  oprettet_kl: string;
  opdateret_kl: string;
};

export default async function AdminBotSide({ searchParams }: { searchParams: Promise<{ side?: string }> }) {
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const side = laesSide((await searchParams).side);
  const erChef = rolle === "chef";

  const [samtalerSvar, oversigtSvar, indstillingerSvar] = await Promise.all([
    admin
      .from("bot_samtaler")
      .select("id, bruger_id, kilde, email, overdraget_kl, oprettet_kl, opdateret_kl", { count: "exact" })
      .order("opdateret_kl", { ascending: false })
      .range((side - 1) * PR_SIDE, side * PR_SIDE - 1),
    erChef ? admin.rpc("bot_forbrug_oversigt") : Promise.resolve({ data: null, error: null }),
    erChef
      ? admin.from("bot_indstillinger").select("doegnloft_usd, doegnloft_anon").maybeSingle<{ doegnloft_usd: number; doegnloft_anon: number }>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const indstillinger = indstillingerSvar.data;
  const samtaler = (samtalerSvar.data ?? []) as Samtale[];
  const i_alt = samtalerSvar.count ?? samtaler.length;
  const oversigt = oversigtSvar.data as Oversigt | null;

  const brugerIds = [...new Set(samtaler.map((s) => s.bruger_id).filter((x): x is string => !!x))];
  const { data: brugere } = brugerIds.length
    ? await admin.from("users").select("id, navn").in("id", brugerIds)
    : { data: [] as { id: string; navn: string | null }[] };
  const navn = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Henvendelser"
        forklaring="Samtaler med BidHamr-bot. Bad brugeren om en rigtig medarbejder, ligger samtalen også under Kontaktformular, hvor du svarer."
      />
      <HenvendelserFaner aktiv="bot" />

      {!botAktiv() && (
        <p className="border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
          {botModel() === null
            ? "BidHamr-bot er slået fra: BIDHAMR_BOT_MODEL er ikke en tilladt model (claude-haiku-5-5, claude-sonnet-5-5 eller claude-opus-5-5). Chatten vises ikke for brugerne."
            : "BidHamr-bot er slået fra (ANTHROPIC_API_KEY er ikke sat). Chatten vises ikke for brugerne."}
        </p>
      )}

      {erChef && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-tekst">Forbrug og pris (model: {botModel() ?? "ukendt"})</h2>
          {indstillinger && (
            <p className="text-xs text-tekst-svag">
              Døgnloft: {usd(indstillinger.doegnloft_usd)} i alt og {antal(indstillinger.doegnloft_anon)} beskeder uden login. Ændres i
              tabellen bot_indstillinger.
            </p>
          )}
          {oversigtSvar.error || !oversigt ? (
            <AdminFejl hvad="Forbruget" />
          ) : (
            <div className="overflow-x-auto border border-admin-kant bg-white">
              <table className="w-full text-sm">
                <thead className="bg-admin-graa text-left text-xs text-tekst-svag">
                  <tr>
                    <th className="px-3 py-2 font-medium">Periode</th>
                    <th className="px-3 py-2 font-medium">Samtaler</th>
                    <th className="px-3 py-2 font-medium">Beskeder</th>
                    <th className="px-3 py-2 font-medium">Til medarbejder</th>
                    <th className="px-3 py-2 font-medium">Tokens ind / ud</th>
                    <th className="px-3 py-2 font-medium">Cache læst / skrevet</th>
                    <th className="px-3 py-2 font-medium">Pris (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODER.map(([k, label]) => {
                    const p = oversigt[k];
                    return (
                      <tr key={k} className="border-t border-admin-kant">
                        <td className="px-3 py-2 font-medium text-tekst">{label}</td>
                        <td className="px-3 py-2">{antal(p.samtaler)}</td>
                        <td className="px-3 py-2">{antal(p.beskeder)}</td>
                        <td className="px-3 py-2">{antal(p.overdraget)}</td>
                        <td className="px-3 py-2">
                          {antal(p.input_tokens)} / {antal(p.output_tokens)}
                        </td>
                        <td className="px-3 py-2">
                          {antal(p.cache_read_tokens)} / {antal(p.cache_write_tokens)}
                        </td>
                        <td className="px-3 py-2 font-semibold">{usd(p.pris_usd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-tekst-svag">
            Prisen er beregnet ud fra Anthropics listepriser for modellen på tidspunktet for hvert svar. Loft: 30 beskeder pr. bruger og pr. IP i døgnet.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-tekst">Samtaler ({antal(i_alt)})</h2>
        {samtalerSvar.error ? (
          <AdminFejl hvad="Samtalerne" />
        ) : samtaler.length === 0 ? (
          <AdminTom tekst="Ingen samtaler med BidHamr-bot endnu." ok={false} />
        ) : (
          <ul className="divide-y divide-admin-kant border border-admin-kant bg-white">
            {samtaler.map((s) => (
              <li key={s.id}>
                <Link href={`/admin/bot/${s.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-admin-graa">
                  <span className="text-sm text-tekst">
                    {s.bruger_id ? (navn.get(s.bruger_id) ?? "Bruger") : (s.email ?? "Ikke logget ind")}
                    <span className="ml-2 text-xs text-tekst-svag">{s.kilde === "app" ? "App" : "Hjemmeside"}</span>
                  </span>
                  <span className="text-xs text-tekst-svag">
                    {s.overdraget_kl && <span className="mr-2 font-medium text-advarsel-tekst">Sendt til medarbejder</span>}
                    {tid(s.opdateret_kl)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AdminSideskift
        side={side}
        harNaeste={side * PR_SIDE < i_alt}
        antalSider={Math.max(1, Math.ceil(i_alt / PR_SIDE))}
        lavHref={(n) => adminHref("/admin/bot", { side: n })}
      />
    </AdminSide>
  );
}
