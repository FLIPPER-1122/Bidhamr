// Testside for fragt: opret en testforsendelse, se labelen og ryk pakken
// frem (afleveret -> i_transit -> leveret/returneret), så hele flowet kan
// prøves uden GLS. Kun i udvikling mod testdatabasen - i produktion 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { erTestdatabase } from "@/lib/miljoe";
import { fragtErSatOp, fragtLabelsAktiv, hentFragtfirma } from "@/lib/fragt";
import { PAKKESTOERRELSER, PAKKESTOERRELSE_NAVN, SPORINGS_NAVN, SPORINGS_TYPER, erSporingsType } from "@/lib/fragt/types";
import { FRAGT_LABEL_BUCKET } from "@/lib/fragt/server";
import { koerFragtCronNu, opretTestforsendelse, rykPakke } from "./actions";

export const metadata: Metadata = { title: "Fragt-test", robots: { index: false } };
export const dynamic = "force-dynamic";

type Forsendelse = {
  id: string;
  trade_id: string;
  type: string;
  fragtfirma: string;
  status: string;
  pakkestoerrelse: string;
  sporingsnummer: string | null;
  label_sti: string | null;
  oprettet_kl: string;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
  fejl: string | null;
};

type Haendelse = { forsendelse_id: string; type: string; tidspunkt: string; kilde: string };

const KNAP = "rounded-full border border-kant px-3 py-1 text-xs font-medium text-groen hover:bg-groen-lys";

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" });
}

export default async function FragtTestSide({
  searchParams,
}: {
  searchParams: Promise<{ besked?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { besked } = await searchParams;

  if (!erTestdatabase()) {
    return (
      <main className="mx-auto w-full max-w-[1280px] px-4 py-8">
        <h1 className="font-serif text-[26px] font-semibold text-tekst">Fragt-test</h1>
        <p className="mt-2 text-tekst-daempet">Siden virker kun mod testdatabasen.</p>
      </main>
    );
  }

  const admin = createAdminClient();
  const [{ data: forsendelser }, { data: handler }] = await Promise.all([
    admin
      .from("forsendelser")
      .select("id, trade_id, type, fragtfirma, status, pakkestoerrelse, sporingsnummer, label_sti, oprettet_kl, kraever_opmaerksomhed, opmaerksomhed_tekst, fejl")
      .order("oprettet_kl", { ascending: false })
      .limit(20)
      .overrideTypes<Forsendelse[], { merge: false }>(),
    admin
      .from("trades")
      .select("id, created_at")
      .eq("status", "betaling_modtaget")
      .eq("afhentning", false)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const ids = (forsendelser ?? []).map((f) => f.id);
  const { data: haendelser } = ids.length
    ? await admin
        .from("forsendelse_haendelser")
        .select("forsendelse_id, type, tidspunkt, kilde")
        .in("forsendelse_id", ids)
        .order("tidspunkt", { ascending: true })
        .overrideTypes<Haendelse[], { merge: false }>()
    : { data: [] as Haendelse[] };

  const labelLinks = new Map<string, string>();
  await Promise.all(
    (forsendelser ?? [])
      .filter((f) => f.label_sti)
      .map(async (f) => {
        const { data } = await admin.storage.from(FRAGT_LABEL_BUCKET).createSignedUrl(f.label_sti!, 600);
        if (data?.signedUrl) labelLinks.set(f.id, data.signedUrl);
      }),
  );

  const firma = fragtErSatOp() ? hentFragtfirma().visningsnavn : "Ikke sat op";
  const webhookKlar = (process.env.FRAGT_TEST_WEBHOOK_SECRET ?? "").length >= 16;

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-serif text-[26px] font-semibold leading-tight text-tekst sm:text-[32px]">Fragt-test</h1>
      <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
        Opret en testforsendelse, se labelen, og ryk pakken frem uden GLS. Siden findes kun i
        udviklingsmiljøet mod testdatabasen.
      </p>
      <ul className="mt-3 text-sm text-tekst-daempet">
        <li>Fragtfirma: <span className="font-medium text-tekst">{firma}</span></li>
        <li>FRAGT_LABELS_AKTIV: <span className="font-medium text-tekst">{fragtLabelsAktiv() ? "ja" : "nej"}</span> (knappen på handelssiden)</li>
        <li>Testwebhook: <span className="font-medium text-tekst">{webhookKlar ? "klar" : "mangler FRAGT_TEST_WEBHOOK_SECRET"}</span></li>
      </ul>

      {besked && (
        <p role="status" className="mt-4 rounded-lg border border-kant bg-groen-lys px-4 py-3 text-sm text-groen-mork">
          {besked}
        </p>
      )}

      <section className="mt-8 rounded-xl border border-kant bg-white p-6">
        <h2 className="font-serif text-xl font-semibold text-tekst">Opret testforsendelse</h2>
        <form action={opretTestforsendelse} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-tekst-daempet">Handels-id (betalt, med forsendelse)</span>
            <input name="trade_id" list="handler" required className="mt-1 w-[340px] rounded-lg border border-kant px-3 py-2 font-mono text-xs" />
            <datalist id="handler">
              {(handler ?? []).map((h) => (
                <option key={h.id as string} value={h.id as string} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="block text-tekst-daempet">Størrelse</span>
            <select name="pakkestoerrelse" className="mt-1 rounded-lg border border-kant px-3 py-2">
              {PAKKESTOERRELSER.map((s) => (
                <option key={s} value={s}>{PAKKESTOERRELSE_NAVN[s]}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-lg bg-groen px-4 py-2 text-sm font-semibold text-white">
            Opret
          </button>
        </form>
        <form action={koerFragtCronNu} className="mt-4">
          <button type="submit" className={KNAP}>Kør fragt-cron nu</button>
        </form>
      </section>

      <section className="mt-8 space-y-4">
        <h2 className="font-serif text-xl font-semibold text-tekst">Seneste forsendelser</h2>
        {(forsendelser ?? []).length === 0 && <p className="text-sm text-tekst-daempet">Ingen endnu.</p>}
        {(forsendelser ?? []).map((f) => (
          <article key={f.id} className="rounded-xl border border-kant bg-white p-5 text-sm">
            <p className="font-mono text-xs text-tekst-daempet">
              {f.id} · handel <a className="underline" href={`/mine-handler/${f.trade_id}`}>{f.trade_id}</a>
            </p>
            <p className="mt-1">
              <span className="font-medium">{f.sporingsnummer ?? "-"}</span> · {f.fragtfirma} · {f.type} ·{" "}
              {f.pakkestoerrelse} · status <span className="font-semibold">{f.status}</span> · {tid(f.oprettet_kl)}
            </p>
            {f.fejl && <p className="mt-1 text-fejl-tekst">Fejl: {f.fejl}</p>}
            {f.kraever_opmaerksomhed && (
              <p className="mt-1 text-[#8A4210]">Til staff: {f.opmaerksomhed_tekst}</p>
            )}
            {labelLinks.get(f.id) && (
              <p className="mt-2">
                <a href={labelLinks.get(f.id)} target="_blank" rel="noreferrer" className="font-medium text-groen underline">
                  Åbn label (PDF)
                </a>
              </p>
            )}
            <ol className="mt-2 list-decimal pl-5 text-tekst-daempet">
              {(haendelser ?? [])
                .filter((h) => h.forsendelse_id === f.id)
                .map((h, i) => (
                  <li key={i}>
                    {erSporingsType(h.type) ? SPORINGS_NAVN[h.type] : h.type} · {tid(h.tidspunkt)} · {h.kilde}
                  </li>
                ))}
            </ol>
            {f.fragtfirma === "test" && f.sporingsnummer && (
              <div className="mt-3 space-y-2">
                {(["webhook", "sporing"] as const).map((via) => (
                  <div key={via} className="flex flex-wrap items-center gap-2">
                    <span className="w-28 text-xs text-tekst-daempet">Via {via}:</span>
                    {SPORINGS_TYPER.filter((t) => t !== "oprettet").map((t) => (
                      <form key={t} action={rykPakke}>
                        <input type="hidden" name="forsendelse_id" value={f.id} />
                        <input type="hidden" name="type" value={t} />
                        <input type="hidden" name="via" value={via} />
                        <button type="submit" className={KNAP}>{t}</button>
                      </form>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
