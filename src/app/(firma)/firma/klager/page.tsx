import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { createClient } from "@/lib/supabase/server";
import type { FirmaKlager } from "@/lib/erhverv/klager";
import { KLAGE_AFGOERELSE_NAVN, KLAGE_FIRMA as T, KLAGE_KATEGORI_NAVN } from "@/lib/tekster/erhvervKlager";
import { KlageStatusMaerke, klageDato } from "@/components/erhverv/klager/visning";

// Firma oversigt → Klager: købernes klager over firmaet med status og
// afgørelse (firma_klager - kun firmaets egne, tjekket med auth.uid() i
// databasen). Ingen købers beskrivelse, billeder eller kontaktoplysninger.
// Ingen server actions (firmaer kalder ingen før lancering).

export const metadata = { title: T.titel };

export default async function FirmaKlagerSide() {
  await kraevFirma("/firma/klager");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("firma_klager");
  const info = (error ? null : (data as FirmaKlager | null)) ?? { berettigede_12_mdr: 0, klager: [] };

  return (
    <FirmaSide titel={T.titel} intro={T.intro}>
      <Kort id="klager-regel">
        <p className={E_TEKST}>{T.berettigede(info.berettigede_12_mdr)}</p>
        <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{T.regel}</p>
      </Kort>

      <Kort id="klager">
        {info.klager.length === 0 ? (
          <p className={E_TEKST}>{T.tom}</p>
        ) : (
          <ul className="divide-y divide-kant rounded-none border border-kant">
            {info.klager.map((k) => (
              <li key={k.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[19px] font-semibold text-tekst">{T.klageNr(k.nummer)}</span>
                  <KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />
                </div>
                <p className={E_TEKST}>{KLAGE_KATEGORI_NAVN[k.kategori]}</p>
                <p className={E_TEKST_DAEMPET}>
                  {T.salg}: {k.titel ?? "–"} · {T.modtaget} {klageDato(k.oprettet_kl)}
                  {k.afgjort_kl && (
                    <>
                      {" "}
                      · {T.afgjort} {klageDato(k.afgjort_kl)}
                    </>
                  )}
                </p>
                {k.status === "afsluttet" && k.afgoerelse && k.afgoerelse !== "trukket_tilbage" && k.begrundelse && (
                  <p className="rounded-xl bg-groen-lys p-3 text-[17px] break-words whitespace-pre-line text-tekst">
                    <span className="font-semibold">
                      {KLAGE_AFGOERELSE_NAVN[k.afgoerelse]}. {T.begrundelse}:
                    </span>{" "}
                    {k.begrundelse}
                  </p>
                )}
                <Link
                  href={`/firma/salg/${k.trade_id}`}
                  className="inline-flex min-h-12 items-center text-[17px] font-semibold text-groen underline underline-offset-2"
                >
                  {T.seSalg}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
