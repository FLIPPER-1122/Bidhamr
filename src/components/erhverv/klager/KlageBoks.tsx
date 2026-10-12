import { createClient } from "@/lib/supabase/server";
import { KLAGE_BUCKET, type KlagerPaaHandel } from "@/lib/erhverv/klager";
import {
  KLAGE_AFGOERELSE_NAVN,
  KLAGE_KATEGORI_NAVN,
  KLAGE_KOEBER as T,
  KLAGE_STATUS_NAVN,
} from "@/lib/tekster/erhvervKlager";
import OpretKlageForm from "./OpretKlageForm";
import TraekKlageTilbage from "./TraekKlageTilbage";
import { KlageStatusMaerke, klageDato } from "./visning";

// "Klag over firmaet" på handelssiden (kun køberen på en handel med en
// erhvervssælger). erhverv_klager_handel tjekker auth.uid() i databasen og
// returnerer null, hvis handlen ikke er købers, eller sælgeren ikke er et
// firma - så vises intet.
export default async function KlageBoks({ tradeId, koeberId }: { tradeId: string; koeberId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("erhverv_klager_handel", { p_trade: tradeId });
  // Migrationen er ikke kørt endnu, eller opslaget fejlede: vis ingenting
  // (kontaktoplysningerne står stadig over boksen).
  if (error || !data) return null;
  const info = data as KlagerPaaHandel;

  // Køberens egne billeder (storage-policyen tillader kun egen mappe).
  const stier = info.klager.flatMap((k) => k.billeder);
  const urls = new Map<string, string>();
  if (stier.length > 0) {
    const { data: signerede } = await supabase.storage.from(KLAGE_BUCKET).createSignedUrls(stier, 3600);
    for (const s of signerede ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  return (
    <section
      id="klage"
      aria-labelledby="klage-titel"
      className="scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6"
    >
      <h2 id="klage-titel" className="text-[20px] leading-tight">
        {T.titel}
      </h2>
      <p className="mt-1 text-[16px] text-tekst-daempet">{T.intro}</p>
      <p className="mt-3 rounded-xl border border-info-kant bg-info-bg p-3 text-[15px] text-info-tekst">{T.bemaerk}</p>

      {info.klager.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[17px] font-semibold text-tekst">{T.dineKlager}</h3>
          <ul className="mt-3 space-y-3">
            {info.klager.map((k) => (
              <li key={k.id} className="rounded-xl border border-kant p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[16px] font-semibold text-tekst">{T.klageNr(k.nummer)}</span>
                  <KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />
                </div>
                <p className="mt-1 text-[15px] text-tekst-daempet">
                  {KLAGE_KATEGORI_NAVN[k.kategori]} · {T.oprettet} {klageDato(k.oprettet_kl)}
                  {k.afgjort_kl && (
                    <>
                      {" "}
                      · {T.afgjort} {klageDato(k.afgjort_kl)}
                    </>
                  )}
                </p>
                <p className="mt-2 text-[16px] break-words whitespace-pre-line text-tekst">{k.beskrivelse}</p>
                {k.billeder.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {k.billeder.map((sti) => {
                      const url = urls.get(sti);
                      return (
                        <li key={sti}>
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                              {/* eslint-disable-next-line @next/next/no-img-element -- signeret, kortlivet link */}
                              <img src={url} alt="" className="h-20 w-20 rounded-lg border border-kant object-cover" />
                            </a>
                          ) : (
                            <span className="block h-20 w-20 rounded-lg border border-kant bg-neutral-100" />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {k.status === "afsluttet" && k.afgoerelse && k.afgoerelse !== "trukket_tilbage" && (
                  <div className="mt-3 rounded-lg bg-groen-lys p-3">
                    <p className="text-[15px] font-semibold text-tekst">{KLAGE_AFGOERELSE_NAVN[k.afgoerelse]}</p>
                    {k.begrundelse && (
                      <p className="mt-1 text-[15px] break-words whitespace-pre-line text-tekst">
                        <span className="font-semibold">{T.begrundelse}:</span> {k.begrundelse}
                      </p>
                    )}
                  </div>
                )}
                {k.status !== "afsluttet" && (
                  <div className="mt-3">
                    <p className="sr-only">{KLAGE_STATUS_NAVN[k.status]}</p>
                    <TraekKlageTilbage klageId={k.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5">
        {info.annulleret_afvist ? (
          <p className="text-[16px] text-tekst-daempet">{T.annulleret}</p>
        ) : info.kan_klage ? (
          <OpretKlageForm tradeId={tradeId} koeberId={koeberId} />
        ) : (
          info.grund && <p className="text-[16px] text-tekst-daempet">{T.grund[info.grund]}</p>
        )}
      </div>
    </section>
  );
}
