import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { ERHVERVSSAELGER as T } from "@/lib/tekster/erhverv";
import type { FirmaOffentlig } from "@/lib/erhverv/regler";
import { E_KORT, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";

// Offentlig firmaprofil for en erhvervssælger: firmanavn, CVR, adresse,
// kontakt og en kort tekst om fortrydelsesret. Ét klik fra auktionen
// (mærket "Erhvervssælger"). Data fra firma_offentlig (kan læses af alle).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hentFirma = cache(async (id: string): Promise<FirmaOffentlig | null> => {
  if (!UUID.test(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("firma_offentlig", { p_bruger: id });
  if (error) throw new Error("Firmaet kunne ikke hentes");
  return (data as FirmaOffentlig | null) ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const firma = await hentFirma(id).catch(() => null);
  if (!firma) return { title: T.maerke, robots: { index: false, follow: false } };
  return { title: `${firma.firmanavn} · ${T.maerke}`, alternates: { canonical: `/erhvervssaelger/${id}` } };
}

export default async function ErhvervssaelgerSide({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const firma = await hentFirma(id);
  if (!firma) notFound();

  const raekker: [string, React.ReactNode][] = [
    [T.firmanavn, firma.firmanavn],
    [T.cvr, firma.cvr],
    [T.adresse, `${firma.adresse}, ${firma.postnummer} ${firma.by}`],
    [
      T.telefon,
      <a key="tlf" href={`tel:${firma.telefon.replace(/\s/g, "")}`} className="font-semibold text-groen underline underline-offset-2">
        {firma.telefon}
      </a>,
    ],
    [
      T.email,
      <a key="mail" href={`mailto:${firma.kontakt_email}`} className="font-semibold break-all text-groen underline underline-offset-2">
        {firma.kontakt_email}
      </a>,
    ],
    [
      T.siden,
      new Date(firma.siden).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen", month: "long", year: "numeric" }),
    ],
  ];

  return (
    <main className="flex-1 bg-groen-lys px-4 py-8 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-[720px] space-y-6">
        <div>
          <span className="inline-flex rounded-full border border-groen bg-white px-3 py-1.5 text-[15px] font-semibold text-groen-mork">
            {T.maerke}
          </span>
          <h1 className="mt-3 text-[30px] leading-tight break-words sm:text-[36px]">{firma.firmanavn}</h1>
          <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{T.profilIntro}</p>
        </div>

        {!firma.aktiv && (
          <p className="rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-[17px] text-advarsel-tekst">{T.ikkeAktiv}</p>
        )}

        <section className={E_KORT}>
          <dl className="space-y-4">
            {raekker.map(([k, v]) => (
              <div key={k}>
                <dt className="text-[16px] text-tekst-daempet">{k}</dt>
                <dd className={`${E_TEKST} break-words`}>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={E_KORT} aria-labelledby="fortrydelsesret">
          <h2 id="fortrydelsesret" className="text-[24px] leading-tight">
            {T.fortrydelsesretTitel}
          </h2>
          <div className={`mt-3 space-y-3 ${E_TEKST}`}>
            {T.fortrydelsesret.map((t) => (
              <p key={t}>{t}</p>
            ))}
            <p className="text-tekst-daempet">{T.ingenBeskyttelse}</p>
          </div>
        </section>

        <Link
          href={`/profil/${firma.bruger_id}`}
          className="inline-flex min-h-12 items-center rounded-md text-[18px] font-semibold text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          {T.seAuktioner} →
        </Link>
      </div>
    </main>
  );
}
