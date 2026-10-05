import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { hentSag } from "@/app/actions/adminSager";
import { hentSamtalerForSag } from "@/app/actions/staffChat";
import {
  SAG_ANKE_STATUS_NAVN,
  SAG_CHAT_TYPE,
  SAG_KATEGORI_NAVN,
  SAG_STATUS_NAVN,
  SAG_TYPE_NAVN,
} from "@/lib/sager";
import { PAKKE_KATEGORI_NAVN } from "@/lib/pakkebilleder";
import { handelChatSti } from "@/lib/moderationLog";
import { kroner } from "@/lib/kroner";
import { standNavn } from "@/lib/stand";
import HandelStatusBadge, { statusLabel } from "@/components/HandelStatusBadge";
import StaffSamtaleListe from "@/components/admin/staffchat/StaffSamtaleListe";
import FaellesbeskedKnap from "@/components/admin/staffchat/FaellesbeskedKnap";
import SagHandlinger from "@/components/admin/sager/SagHandlinger";
import { BeskyttelseBadge, SagBilleder, SagStatusBadge, sagTid } from "@/components/sager/visning";

// Navne på handlingerne i moderation_log for sager.
const LOG_NAVN: Record<string, string> = {
  sag_afgjort_koeber: "Medhold til køber",
  sag_afgjort_saelger: "Medhold til sælger",
  sag_lukket: "Sagen er lukket",
  sag_retur_afleveret: "Returpakke afleveret",
  sag_genaabnet: "Sagen er genåbnet",
  sag_afviklet: "Pengene er flyttet efter afgørelsen",
  sag_anke_indgivet: "Afgørelsen er anket",
  sag_anke_stadfaestet: "Anken er afgjort – afgørelsen står",
  sag_anke_omgjort: "Anken er afgjort – afgørelsen er ændret",
  konto_lukket: "Konto lukket permanent",
  indpakning_paamindelse: "Påmindelse til sælger: dårlig indpakning",
  advarsel: "Advarsel",
};

const PENGE_HANDLING_NAVN = {
  refunder: "Refusion til køber",
  frigiv: "Udbetaling til sælger",
  ingen: "Frysningen fjernes – handlen fortsætter",
} as const;

function logNavn(h: string) {
  return LOG_NAVN[h] ?? h.replace(/_/g, " ");
}

function Kort({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold text-neutral-900">{titel}</h2>
      {children}
    </section>
  );
}

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-neutral-500">{navn}</dt>
      <dd className="mt-0.5 break-words text-neutral-800">{children}</dd>
    </div>
  );
}

const BETALING_STATUS: Record<string, string> = {
  afventer: "Afventer betaling",
  behandles: "Behandles",
  betalt: "Betalt",
  annulleret: "Annulleret",
  refunderet: "Refunderet",
};

const jaNej = (v: boolean) => (v ? "Ja" : "Nej");

export default async function AdminSag({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [res, samtalerRes, rolle] = await Promise.all([
    hentSag(id),
    hentSamtalerForSag(SAG_CHAT_TYPE, id),
    getStaffRole(),
  ]);
  if ("fejl" in res) {
    if (res.fejl === "Sagen findes ikke.") notFound();
    throw new Error(res.fejl);
  }
  const { sag } = res;
  const b = sag.betaling;
  const kanSkriveFaelles = rolle ? harMindstRolle(rolle, "admin") : false;
  const koeberNavn = sag.koeber.navn ?? "Uden navn";
  const saelgerNavn = sag.saelger.navn ?? "Uden navn";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link
        href="/admin/sager"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Alle sager
      </Link>

      {/* Overblik og handlinger */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <SagStatusBadge status={sag.status} />
          {sag.beskyttelse && <BeskyttelseBadge />}
          {sag.genaabnetAntal > 0 && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
              Genåbnet {sag.genaabnetAntal} {sag.genaabnetAntal === 1 ? "gang" : "gange"}
            </span>
          )}
        </div>
        <h1 className="mt-2 break-words text-xl font-bold text-neutral-900 sm:text-2xl">
          {sag.auktionTitel ?? "(slettet auktion)"}
        </h1>
        <p className="mt-1 text-sm text-neutral-700">{SAG_TYPE_NAVN[sag.type]}</p>
        <p className="mt-1 text-sm text-neutral-500">
          {SAG_STATUS_NAVN[sag.status]} · Oprettet {sagTid(sag.oprettetKl)}
        </p>

        {sag.tjekSporing && (
          <div className="mt-3 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
            <p className="font-semibold">Tjek sporingen hos GLS før afgørelse</p>
            <p className="mt-0.5">
              Sagen er oprettet, før køberen markerede pakken som modtaget (
              {sag.type === "svindel" ? "varen er aldrig sendt / falsk sporing" : "pakken er ikke kommet frem"}
              ). Der kræves ingen billeder.
            </p>
            <p className="mt-1">
              Sporingsnummer:{" "}
              <span className="select-all font-mono text-base font-semibold">{sag.trackingNumber ?? "mangler"}</span>
              {sag.sendtKl && <> · Sendt {sagTid(sag.sendtKl)}</>}
            </p>
          </div>
        )}
        {b?.indsigelse && (
          <p className="mt-3 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
            Køberen har en åben indsigelse hos sin bank. Pengene kan ikke flyttes, før den er afgjort.
          </p>
        )}
        {b?.kraeverOpmaerksomhed && (
          <p className="mt-3 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
            Betalingen kræver opmærksomhed. Se{" "}
            <Link href="/admin/betalinger" className="font-semibold underline">
              Betalinger
            </Link>
            .
          </p>
        )}

        <div className="mt-4">
          <SagHandlinger
            sagId={sag.id}
            type={sag.type}
            indsigelse={!!b?.indsigelse}
            kan={sag.kan}
            koeber={{ id: sag.koeber.id, navn: koeberNavn, lukket: sag.koeberLukket }}
            saelger={{ id: sag.saelger.id, navn: saelgerNavn, lukket: sag.saelgerLukket }}
            indpakning={sag.indpakning}
            anke={
              sag.anke && sag.anke.status === "afventer"
                ? { id: sag.anke.id, part: sag.anke.part, ankedeStatus: sag.anke.ankedeStatus, type: sag.type }
                : null
            }
            ankeIkkeTilladt={sag.ankeIkkeTilladt}
            ankeEndelig={sag.ankeEndelig}
            afventerRetur={sag.status === "afventer_retur"}
            returIkkeTilladt={sag.returIkkeTilladt}
            returFristTekst={sag.returFristTekst}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Køberens beskrivelse">
          <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">{sag.beskrivelse}</p>
        </Kort>
        <Kort titel="Varen i auktionen">
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-tekst-daempet">Stand:</dt>
              <dd className="font-semibold text-tekst">{standNavn(sag.auktionStand)}</dd>
            </div>
            <div>
              <dt className="text-tekst-daempet">Sælgerens beskrivelse:</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-neutral-800">
                {sag.auktionBeskrivelse || "(ingen beskrivelse)"}
              </dd>
            </div>
            {sag.auktionSpoergsmaal.length > 0 && (
              <div>
                <dt className="text-tekst-daempet">Spørgsmål og svar ({sag.auktionSpoergsmaal.length}):</dt>
                <dd>
                  <ul className="mt-1 space-y-2">
                    {sag.auktionSpoergsmaal.map((q, i) => (
                      <li key={i} className="rounded-lg bg-neutral-50 px-3 py-2">
                        <p className="break-words text-neutral-800">
                          <span className="font-medium">Spørgsmål:</span> {q.question}
                          {q.hidden && <span className="text-tekst-svag"> (skjult)</span>}
                        </p>
                        <p className="mt-0.5 break-words text-neutral-800">
                          <span className="font-medium">Svar:</span> {q.answer ?? "(ikke besvaret)"}
                        </p>
                        <p className="mt-0.5 text-xs text-tekst-svag">{sagTid(q.askedKl)}</p>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </Kort>

        <Kort titel="Afgørelse">
          {sag.begrundelse || sag.internNote || sag.afgjortKl ? (
            <dl className="space-y-3 text-sm">
              {sag.afgjortKl && (
                <Felt navn="Afgjort">
                  {sagTid(sag.afgjortKl)} af {sag.afgjortAfNavn ?? "ukendt"}
                </Felt>
              )}
              {sag.begrundelse && (
                <Felt navn="Begrundelse (til køber og sælger)">
                  <span className="whitespace-pre-wrap">{sag.begrundelse}</span>
                </Felt>
              )}
              {sag.internNote && (
                <Felt navn="Intern note">
                  <span className="whitespace-pre-wrap">{sag.internNote}</span>
                </Felt>
              )}
              {sag.pengeHandling && sag.pengeFlyttesEfterKl && (
                <Felt navn="Ankefrist (4 dage)">
                  {PENGE_HANDLING_NAVN[sag.pengeHandling]}
                  {sag.afvikletKl
                    ? ` · gennemført ${sagTid(sag.afvikletKl)}`
                    : ` · tidligst ${sagTid(sag.pengeFlyttesEfterKl)}, medmindre sagen genåbnes`}
                  {!sag.afvikletKl && sag.status === "afventer_retur" && " (og først når returpakken er afleveret)"}
                  {sag.pengeFejl && (
                    <span className="mt-1 block text-fejl-tekst">Kan ikke gennemføres: {sag.pengeFejl}.</span>
                  )}
                </Felt>
              )}
              {sag.returKraeves && (
                <Felt navn="Retur">
                  {sag.returAfleveretKl
                    ? `Returpakke afleveret ${sagTid(sag.returAfleveretKl)}`
                    : "Køberen skal sende varen retur"}
                  {sag.returfragtBetaler === "koeber" && " · Køberen betaler selv returfragten"}
                  {/* Sager afgjort før 3. oktober 2026, hvor BidHamr betalte. */}
                  {sag.returfragtBetaler === "bidhamr" && " · BidHamr betaler returfragten"}
                </Felt>
              )}
            </dl>
          ) : (
            <p className="text-sm text-neutral-500">Sagen er ikke afgjort endnu.</p>
          )}
        </Kort>
      </div>

      {sag.anke && (
        <Kort titel={`Anke fra ${sag.anke.part === "koeber" ? "køberen" : "sælgeren"} – ${SAG_ANKE_STATUS_NAVN[sag.anke.status].toLowerCase()}`}>
          <dl className="space-y-3 text-sm">
            <Felt navn="Indgivet">{sagTid(sag.anke.indgivetKl)}</Felt>
            <Felt navn="Begrundelse fra den, der anker">
              <span className="whitespace-pre-wrap">{sag.anke.begrundelse}</span>
            </Felt>
            <Felt navn="Den ankede afgørelse">
              {SAG_STATUS_NAVN[sag.anke.ankedeStatus]} · {sagTid(sag.anke.ankedeAfgjortKl)} af{" "}
              {sag.anke.ankedeAfgjortAfNavn ?? "ukendt"}
              <span className="mt-1 block whitespace-pre-wrap text-neutral-700">{sag.anke.ankedeBegrundelse}</span>
            </Felt>
            {sag.anke.behandletKl && (
              <Felt navn="Afgjort">
                {sagTid(sag.anke.behandletKl)} af {sag.anke.behandletAfNavn ?? "ukendt"}
              </Felt>
            )}
            {sag.anke.afgoerelseBegrundelse && (
              <Felt navn="Begrundelse for afgørelsen på anken (til køber og sælger)">
                <span className="whitespace-pre-wrap">{sag.anke.afgoerelseBegrundelse}</span>
              </Felt>
            )}
            {sag.anke.internNote && (
              <Felt navn="Intern note">
                <span className="whitespace-pre-wrap">{sag.anke.internNote}</span>
              </Felt>
            )}
          </dl>
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium text-neutral-700">
              Ny dokumentation ({sag.anke.billeder.length})
            </h3>
            {sag.anke.billeder.length > 0 ? (
              <SagBilleder billeder={sag.anke.billeder} stor />
            ) : (
              <p className="text-sm text-neutral-500">Ingen billeder med anken.</p>
            )}
          </div>
        </Kort>
      )}

      <Kort titel={`Billeder (${sag.billeder.length})`}>
        {(["pakke", "label", "indhold", "andet"] as const).map((k) => {
          const egne = sag.billeder.filter((x) => x.kategori === k);
          if (egne.length === 0) return null;
          return (
            <div key={k} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-sm font-medium text-neutral-700">
                {SAG_KATEGORI_NAVN[k]} ({egne.length})
              </h3>
              <SagBilleder billeder={egne} stor />
            </div>
          );
        })}
        {sag.billeder.length === 0 && <p className="text-sm text-neutral-500">Køberen har ikke tilføjet billeder.</p>}
        {sag.billeder.length > 0 && (
          <p className="mt-3 text-xs text-neutral-500">
            Klik på et billede for at se det i fuld størrelse. Linkene udløber efter en time – genindlæs siden for nye.
          </p>
        )}
      </Kort>

      <Kort titel={`Sælgerens pakkebilleder (${sag.pakkebilleder.length})`}>
        {sag.pakkebilleder.length > 0 ? (
          <>
            <p className="mb-3 text-sm text-neutral-600">
              Taget af sælgeren ved &quot;Send pakke&quot;. Brug dem til at vurdere indpakningen – de
              beviser ikke, at varen blev i kassen.
            </p>
            {(["aaben_kasse", "lukket_kasse"] as const).map((k) => {
              const egne = sag.pakkebilleder.filter((x) => x.kategori === k);
              if (egne.length === 0) return null;
              return (
                <div key={k} className="mb-5 last:mb-0">
                  <h3 className="mb-2 text-sm font-medium text-neutral-700">
                    {PAKKE_KATEGORI_NAVN[k]} ({egne.length})
                  </h3>
                  <SagBilleder billeder={egne} stor />
                </div>
              );
            })}
          </>
        ) : (
          <p className="text-sm text-neutral-500">
            Ingen pakkebilleder (afhentning, eller pakken blev sendt, før billeder blev krævet).
          </p>
        )}
      </Kort>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Handlen">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Felt navn="Auktion">
              {sag.auktionId ? (
                <Link href={`/auktion/${sag.auktionId}`} className="font-medium hover:underline">
                  {sag.auktionTitel ?? "(slettet auktion)"}
                </Link>
              ) : (
                "(slettet auktion)"
              )}
            </Felt>
            <Felt navn="Status nu">
              <HandelStatusBadge status={sag.handelStatus} />
            </Felt>
            <Felt navn="Køber">
              <Link href={`/admin/brugere/${sag.koeber.id}`} className="font-medium hover:underline">
                {koeberNavn}
              </Link>
              {sag.koeberLukket && <span className="ml-1 text-xs text-fejl-tekst">(lukket)</span>}
            </Felt>
            <Felt navn="Sælger">
              <Link href={`/admin/brugere/${sag.saelger.id}`} className="font-medium hover:underline">
                {saelgerNavn}
              </Link>
              {sag.saelgerLukket && <span className="ml-1 text-xs text-fejl-tekst">(lukket)</span>}
            </Felt>
            <Felt navn="Status da sagen blev oprettet">{statusLabel(sag.handelStatusVedOprettelse)}</Felt>
            <Felt navn="Sporingsnummer">
              <span className="select-all font-mono">{sag.trackingNumber ?? "–"}</span>
              {sag.tjekSporing && (
                <span className="mt-0.5 block text-xs font-semibold text-advarsel-tekst">
                  Tjek sporingen hos GLS før afgørelse
                </span>
              )}
            </Felt>
            <Felt navn="Sendt">{sag.sendtKl ? sagTid(sag.sendtKl) : "–"}</Felt>
            <Felt navn="Modtaget">{sag.modtagetKl ? sagTid(sag.modtagetKl) : "–"}</Felt>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4">
            {/* prefetch slået fra: chatsiden logger læsningen. */}
            <Link
              href={handelChatSti(sag.tradeId)}
              prefetch={false}
              className="inline-flex min-h-10 items-center rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Se chat mellem køber og sælger
            </Link>
            {kanSkriveFaelles && <FaellesbeskedKnap tradeId={sag.tradeId} />}
          </div>
        </Kort>

        <Kort titel="Betaling">
          {b ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Felt navn="Status">{BETALING_STATUS[b.status] ?? b.status}</Felt>
              <Felt navn="BidHamr Beskyttelse">{jaNej(b.beskyttelse)}</Felt>
              <Felt navn="Frigivet til sælger">{jaNej(b.frigivet)}</Felt>
              <Felt navn="Overført til sælger">{jaNej(b.overfoert)}</Felt>
              <Felt navn="Refusion anmodet">{jaNej(b.refusionAnmodet)}</Felt>
              <Felt navn="Refunderet">{jaNej(b.refunderet)}</Felt>
              {sag.kan.seBeloeb && (
                <>
                  {b.totalOere !== null && <Felt navn="Betalt i alt">{kroner(b.totalOere)}</Felt>}
                  {b.beskyttelseOere !== null && (
                    <Felt navn="Heraf BidHamr Beskyttelse">{kroner(b.beskyttelseOere)}</Felt>
                  )}
                  {b.refusionOere !== null && <Felt navn="Refusion">{kroner(b.refusionOere)}</Felt>}
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-neutral-500">Ingen betaling fundet.</p>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            BidHamr holder aldrig pengene. Betalingen håndteres af vores betalingspartner Stripe.
          </p>
        </Kort>
      </div>

      <Kort titel="Samtaler om sagen">
        {"fejl" in samtalerRes ? (
          <p role="alert" className="text-sm text-fejl-tekst">
            Samtalerne kunne ikke hentes: {samtalerRes.fejl}
          </p>
        ) : (
          <StaffSamtaleListe
            samtaler={samtalerRes.samtaler}
            tom="Ingen samtaler om sagen endnu. Brug knapperne øverst for at skrive til køber eller sælger."
          />
        )}
      </Kort>

      <Kort titel="Log">
        {sag.log.length === 0 ? (
          <p className="text-sm text-neutral-500">Ingen handlinger endnu.</p>
        ) : (
          <ol className="space-y-3">
            {sag.log.map((l, i) => (
              <li key={`${l.oprettetKl}-${i}`} className="border-l-2 border-neutral-200 pl-3 text-sm">
                <p className="font-medium text-neutral-800">{logNavn(l.handling)}</p>
                <p className="text-xs text-neutral-500">
                  {sagTid(l.oprettetKl)} · {l.medarbejderNavn ?? "ukendt"}
                </p>
                {l.aarsag && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-neutral-700">{l.aarsag}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Kort>
    </div>
  );
}
