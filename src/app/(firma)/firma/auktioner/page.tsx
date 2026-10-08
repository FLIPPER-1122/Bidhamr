import Link from "next/link";
import { hentFirmaAuktioner, kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import { opretStatus } from "@/lib/erhverv/firmaStatus";
import { AUKTION_GRUPPER, erAuktionGruppe, type AuktionGruppe } from "@/lib/erhverv/regler";
import { FirmaSide, Kort, LukketBoks, OpretKnap, VareBillede } from "@/components/firma/dele";
import { E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D, ERHVERV_MOMS as M } from "@/lib/tekster/erhverv";
import { kr, ugedagDato } from "@/lib/erhverv/visning";

// Auktioner: firmaets auktioner i fanerne Aktive / Solgte / Usolgte /
// Annullerede (firma_auktioner - visninger fra auction_views). Fanerne er
// almindelige links (?vis=...), så de virker uden JavaScript. "Opret
// auktion" og "Redigér" sker inde i dashboardet.

export const metadata = { title: D.auktioner.titel };

const A = D.auktioner;

export default async function FirmaAuktionerSide({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; oprettet?: string; gemt?: string }>;
}) {
  const { oversigt: o } = await kraevFirma("/firma/auktioner");
  const sp = await searchParams;
  const gruppe: AuktionGruppe = erAuktionGruppe(sp.vis) ? sp.vis : "aktive";
  const data = await hentFirmaAuktioner(gruppe);
  const lukket = foerLancering();
  const k = o.ugekvote;
  const auktioner = data?.auktioner ?? [];

  return (
    <FirmaSide titel={A.titel} intro={A.intro}>
      {lukket && <LukketBoks />}

      {(sp.oprettet === "1" || sp.gemt === "1") && (
        <p role="status" className="rounded-[14px] border-2 border-succes-kant bg-succes-bg p-4 text-[18px] font-semibold text-succes-tekst">
          {sp.oprettet === "1" ? A.oprettet : A.gemt}
        </p>
      )}

      <Kort id="opret">
        {k && <p className={`mb-4 ${E_TEKST}`}>{A.ugeKvote(k.brugt, k.max)}</p>}
        <OpretKnap status={opretStatus(o, lukket)} />
      </Kort>

      <nav aria-label={A.fanerLabel}>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {AUKTION_GRUPPER.map((g) => {
            const aktiv = g === gruppe;
            return (
              <li key={g}>
                <Link
                  href={g === "aktive" ? "/firma/auktioner" : `/firma/auktioner?vis=${g}`}
                  aria-current={aktiv ? "page" : undefined}
                  className={`flex min-h-14 w-full items-center justify-center rounded-xl border-2 px-3 py-2 text-center text-[18px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                    aktiv ? "border-groen bg-groen text-white" : "border-kant-staerk bg-white text-tekst hover:bg-groen-lys"
                  }`}
                >
                  {A.faner[g]} ({data?.antal[g] ?? 0})
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Kort id="liste">
        {auktioner.length === 0 ? (
          <p className={E_TEKST}>{A.tom[gruppe]}</p>
        ) : (
          <ul className="space-y-4">
            {auktioner.map((a) => {
              // Auktioner afsluttes af cron (højst et minut efter slut).
              const koerer = a.status === "aktiv";
              const harBud = a.nuvaerende_bud != null || a.antal_bud > 0;
              return (
                <li key={a.id} className="rounded-[14px] border-2 border-kant p-4">
                  <div className="flex gap-4">
                    <VareBillede url={a.billede} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[19px] leading-snug font-semibold break-words text-tekst">{a.titel}</p>
                      <p className={E_TEKST}>
                        {gruppe === "solgte" && a.solgt_for != null
                          ? `${A.solgtFor}: ${kr(Number(a.solgt_for))}`
                          : harBud
                            ? `${A.nuvaerendeBud}: ${kr(Number(a.nuvaerende_bud ?? a.startpris))}`
                            : `${A.startpris}: ${kr(Number(a.startpris))}`}{" "}
                        {/* Firmaets auktioner er erhvervsauktioner: prisen er inkl. moms. */}
                        <span className="whitespace-nowrap text-[17px] text-tekst-daempet">{M.inklMoms}</span>
                        {!(gruppe === "solgte" && a.solgt_for != null) && !harBud && <> · {A.ingenBud}</>}
                      </p>
                      <p className={E_TEKST_DAEMPET}>
                        {koerer ? A.slutter : A.sluttede} {ugedagDato(a.slutter_kl)} · {A.bud(a.antal_bud)} ·{" "}
                        {A.visninger(a.visninger)}
                      </p>
                      {a.skjult && <p className="mt-1 text-[17px] font-semibold text-advarsel-tekst">{A.skjult}</p>}
                    </div>
                  </div>
                  {!lukket && (
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      {koerer && !a.skjult && (
                        <Link href={`/firma/auktioner/${a.id}/rediger`} className={E_KNAP_SEKUNDAER}>
                          {A.knapRediger}
                        </Link>
                      )}
                      {a.trade_id ? (
                        <Link href={`/firma/salg/${a.trade_id}`} className={E_KNAP_SEKUNDAER}>
                          {A.knapSeHandel}
                        </Link>
                      ) : (
                        !a.skjult && (
                          <Link href={`/auktion/${a.id}`} className={E_KNAP_SEKUNDAER}>
                            {A.knapSeAuktion}
                          </Link>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
