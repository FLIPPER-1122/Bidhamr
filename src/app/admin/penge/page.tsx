import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffRole } from "@/lib/adminAuth";
import {
  HOLDT_GRAENSE,
  PERIODER,
  hentPengeOversigt,
  somPeriode,
  type HoldtGrund,
  type HoldtRaekke,
  type PengeHoldes,
  type PengeTal,
  type Resultat,
  type StripeBalance,
  type StripeBevaegelser,
} from "@/lib/admin/penge";

// Penge - KUN for rollen chef (ROADMAP fase 1B). Admin og medarbejder får 404,
// også ved direkte URL. Rollen tjekkes her OG igen i hentPengeOversigt.
// BidHamr har ingen saldo/wallet: pengene ligger hos Stripe, til de frigives.

const kr = (oere: number) =>
  (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  " kr";

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    dateStyle: "short",
    timeStyle: "short",
  });

const GRUND: Record<HoldtGrund, string> = {
  indsigelse: "Indsigelse hos købers bank",
  refusion_i_gang: "Refusion i gang",
  overfoersel_i_gang: "Overførsel i gang",
  afventer_overfoersel: "Frigivet – overføres til sælger",
  afventer_udbetaling: "Frigivet – venter på udbetaling til bank",
  udbetaling_paa_vej: "Udbetaling til sælgers bank i gang",
  venter_paa_bank: "Udbetaling fejlede – venter på sælgers bank",
  afventer_anke: "Afventer anke",
  afventer_sag: "Afventer sag",
  afventer_retur: "Afventer returpakke",
  ankefrist: "Ankefrist",
  frosset: "Frosset af staff",
  afhentning: "Afventer afhentning",
  afventer_afsendelse: "Afventer afsendelse",
  auto_frigivelse: "Automatisk frigivelse",
  kraever_tjek: "Kræver tjek",
};

const HANDEL_STATUS: Record<string, string> = {
  afventer_betaling: "Afventer betaling",
  betaling_modtaget: "Betalt",
  pakke_sendt: "Pakke sendt",
  modtaget: "Modtaget",
  leveret: "Leveret",
  afsluttet: "Afsluttet",
  annulleret: "Annulleret",
};

// Hvad der sker med pengene, og hvornår.
function forventet(r: HoldtRaekke): string {
  const tid = r.forventet_kl ? dato(r.forventet_kl) : null;
  switch (r.grund) {
    case "indsigelse":
      return "Afventer bankens afgørelse";
    case "refusion_i_gang":
      return "Refunderes til køber (venter på Stripe)";
    case "overfoersel_i_gang":
      return "Overføres til sælger (venter på Stripe)";
    case "afventer_overfoersel":
      return "Overføres til sælger, når udbetalingskontoen er klar";
    case "afventer_udbetaling":
      return tid
        ? `Udbetales fra sælgers Stripe-konto til banken (tidligst ${tid})`
        : "Udbetales fra sælgers Stripe-konto til banken";
    case "udbetaling_paa_vej":
      return "Sendt til sælgers bank (venter på Stripe)";
    case "venter_paa_bank":
      return "Sælger skal rette sin bankkonto hos Stripe – eller tryk Prøv igen under Betalinger";
    case "afventer_anke":
      return "Afventer anke – pengene flyttes efter ankeafgørelsen";
    case "afventer_sag":
      return "Afventer sag – frosset til sagen er afgjort";
    case "afventer_retur":
      return tid
        ? `Refunderes, når returpakken er afleveret (tidligst ${tid})`
        : "Refunderes, når returpakken er afleveret";
    case "ankefrist":
      if (r.handling === "refunder") return `Refunderes til køber ${tid ?? ""} (efter ankefrist)`;
      if (r.handling === "frigiv") return `Frigives til sælger ${tid ?? ""} (efter ankefrist)`;
      return `Frysningen ophæves ${tid ?? ""} (efter ankefrist)`;
    case "frosset":
      return "Frosset – staff skal tage stilling";
    case "afhentning":
      return "Frigives, når sælger indtaster købers afhentningskode";
    case "afventer_afsendelse":
      return `Refunderes ${tid ?? ""}, hvis pakken ikke er sendt`;
    case "auto_frigivelse":
      return `Frigives automatisk ${tid ?? ""}, hvis der ikke kommer en sag`;
    case "kraever_tjek":
      return "Ingen automatisk regel – tjek handlen";
  }
}

function Kort({
  titel,
  vaerdi,
  under,
  tone = "neutral",
}: {
  titel: string;
  vaerdi: string;
  under?: string;
  tone?: "neutral" | "groen" | "roed" | "orange";
}) {
  const farve = {
    neutral: "text-neutral-900",
    groen: "text-green-700",
    roed: "text-red-700",
    orange: "text-orange-700",
  }[tone];
  return (
    <div className="min-w-0 rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{titel}</p>
      <p className={`mt-1 break-words text-xl font-bold sm:text-2xl ${farve}`}>{vaerdi}</p>
      {under && <p className="mt-1 text-xs text-neutral-500">{under}</p>}
    </div>
  );
}

function Sektion({ titel, children, note }: { titel: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-neutral-900">{titel}</h2>
        {note && <p className="mt-0.5 text-xs text-neutral-500">{note}</p>}
      </div>
      <div className="px-4 py-3 sm:px-5">{children}</div>
    </section>
  );
}

function Linje({
  label,
  vaerdi,
  antal,
  fremhaev,
  tone,
}: {
  label: React.ReactNode;
  vaerdi: string;
  antal?: number;
  fremhaev?: boolean;
  tone?: "roed" | "groen";
}) {
  const farve = tone === "roed" ? "text-red-700" : tone === "groen" ? "text-green-700" : "text-neutral-900";
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-2 text-sm ${
        fremhaev ? "border-t border-neutral-200 font-semibold" : ""
      }`}
    >
      <span className="min-w-0 text-neutral-700">
        {label}
        {antal !== undefined && <span className="ml-1 text-xs text-neutral-400">({antal})</span>}
      </span>
      <span className={`shrink-0 tabular-nums ${farve}`}>{vaerdi}</span>
    </div>
  );
}

function Fejlboks({ tekst }: { tekst: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      {tekst}
    </div>
  );
}

// ------------------------------------------------------------ sektioner

function Indtjening({ t }: { t: PengeTal }) {
  const i = t.indtjening;
  return (
    <Sektion
      titel="BidHamrs indtjening"
      note="Gebyrer på handler betalt i perioden, som ikke er refunderet eller tabt ved indsigelse."
    >
      <Linje label="Købergebyr (5 %)" vaerdi={kr(i.koebergebyr)} />
      <Linje label="Sælgergebyr (5 % af bud)" vaerdi={kr(i.saelgergebyr)} />
      <Linje label="BidHamr Beskyttelse" antal={i.antal_beskyttelse} vaerdi={kr(i.beskyttelse)} />
      {i.oevrigt > 0 && <Linje label="Øvrigt beholdt ved delvis refusion" vaerdi={kr(i.oevrigt)} />}
      <Linje label="Indtjening i alt" vaerdi={kr(i.i_alt)} fremhaev />
      {i.heraf_ikke_frigivet > 0 && (
        <p className="pb-1 text-xs text-neutral-500">
          Heraf {kr(i.heraf_ikke_frigivet)} på handler, hvor pengene ikke er overført til sælger endnu – de kan stadig
          blive refunderet.
        </p>
      )}
      <div className="mt-2 rounded-lg bg-neutral-50 px-3 py-2">
        <Linje
          label="Fragt (går videre til fragtfirmaet – ikke indtjening)"
          antal={t.fragt.antal}
          vaerdi={kr(t.fragt.beloeb)}
        />
      </div>
    </Sektion>
  );
}

function Pengestroem({ t }: { t: PengeTal }) {
  const r = t.refusioner;
  const ind = t.indsigelser;
  return (
    <Sektion titel="Pengestrøm i perioden" note="Som databasen har registreret det fra Stripe.">
      <Linje label="Betalinger modtaget" antal={t.betalinger_modtaget.antal} vaerdi={kr(t.betalinger_modtaget.beloeb)} />
      {t.forkerte_beloeb_modtaget.antal > 0 && (
        <Linje
          label="Betalinger med forkert beløb (refunderes automatisk)"
          antal={t.forkerte_beloeb_modtaget.antal}
          vaerdi={kr(t.forkerte_beloeb_modtaget.beloeb)}
        />
      )}
      <Linje label="Overført til sælgere" antal={t.udbetalinger.antal} vaerdi={kr(t.udbetalinger.beloeb)} />

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Refusioner</p>
      <Linje label="Fulde refusioner" antal={r.fulde.antal} vaerdi={kr(r.fulde.beloeb)} />
      <Linje label="Delvise refusioner" antal={r.delvise.antal} vaerdi={kr(r.delvise.beloeb)} />
      {r.forkerte_beloeb.antal > 0 && (
        <Linje label="Refunderet forkert beløb" antal={r.forkerte_beloeb.antal} vaerdi={kr(r.forkerte_beloeb.beloeb)} />
      )}
      {r.i_gang.antal > 0 && (
        <Linje label="Refusioner i gang (venter på Stripe)" antal={r.i_gang.antal} vaerdi={kr(r.i_gang.beloeb)} />
      )}
      {r.efter_udbetaling.antal > 0 && (
        <Linje
          label="Refunderet EFTER overførsel til sælger – tjek hos Stripe"
          antal={r.efter_udbetaling.antal}
          vaerdi={kr(r.efter_udbetaling.udbetalt)}
          tone="roed"
        />
      )}

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Indsigelser</p>
      <Linje label="Indsigelser i alt" antal={ind.antal} vaerdi={kr(ind.beloeb)} />
      <div className="flex flex-wrap gap-2 py-1 text-xs">
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-800">Åbne: {ind.aabne}</span>
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">Vundet: {ind.vundet}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-700">Lukket: {ind.lukket}</span>
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">
          Tabt: {ind.tabt_foer_udbetaling.antal + ind.tabt_efter_udbetaling.antal}
        </span>
      </div>
      <Linje
        label="Tabt før udbetaling (trukket tilbage – sælger fik intet)"
        antal={ind.tabt_foer_udbetaling.antal}
        vaerdi={kr(ind.tabt_foer_udbetaling.beloeb)}
      />
      <Linje
        label="Tabt efter udbetaling (trukket tilbage)"
        antal={ind.tabt_efter_udbetaling.antal}
        vaerdi={kr(ind.tabt_efter_udbetaling.beloeb)}
      />
      <Linje
        label="BidHamrs tab ved indsigelse efter udbetaling"
        vaerdi={kr(ind.tabt_efter_udbetaling.tab)}
        tone={ind.tabt_efter_udbetaling.tab > 0 ? "roed" : undefined}
        fremhaev
      />
      <p className="pb-1 text-xs text-neutral-500">
        Udbetalingen trækkes aldrig tilbage fra sælgeren. Tabet er udbetalingen til sælgeren plus
        fragten. Stripes indsigelsesgebyr kommer oveni og ses i afstemningen.
      </p>
    </Sektion>
  );
}

function Afstemning({
  tal,
  holdes,
  balance,
  bevaegelser,
}: {
  tal: Resultat<PengeTal>;
  holdes: Resultat<PengeHoldes>;
  balance: Resultat<StripeBalance>;
  bevaegelser: Resultat<StripeBevaegelser>;
}) {
  // Dækning: beløb hos Stripe skal mindst dække de penge, der holdes for
  // handler. Ved en åben indsigelse har Stripe allerede trukket beløbet.
  let daekning: React.ReactNode = null;
  if (balance.ok && holdes.ok) {
    const stripeIAlt = balance.data.tilgaengelig + balance.data.afventer;
    const indsigelse = holdes.data.efter_grund.find((g) => g.grund === "indsigelse")?.beloeb ?? 0;
    const skalDaekkes = holdes.data.beloeb - indsigelse + holdes.data.forkerte_beloeb.beloeb;
    const forskel = stripeIAlt - skalDaekkes;
    daekning = (
      <div className="space-y-1">
        <Linje label="Beløb hos Stripe i alt (tilgængeligt + afventer)" vaerdi={kr(stripeIAlt)} />
        <Linje label="Penge der holdes for handler (databasen)" vaerdi={kr(holdes.data.beloeb)} />
        {indsigelse > 0 && (
          <Linje label="– heraf midlertidigt trukket af banken (åbne indsigelser)" vaerdi={`−${kr(indsigelse)}`} />
        )}
        {holdes.data.forkerte_beloeb.beloeb > 0 && (
          <Linje label="+ forkerte beløb, der skal refunderes" vaerdi={kr(holdes.data.forkerte_beloeb.beloeb)} />
        )}
        <Linje label="Skal være hos Stripe" vaerdi={kr(skalDaekkes)} fremhaev />
        {forskel < 0 ? (
          <div className="mt-2 rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800" role="alert">
            Afvigelse: Stripe har {kr(-forskel)} mindre, end der holdes for handler. Tjek Stripe
            Dashboard med det samme.
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            Dækket. De resterende {kr(forskel)} hos Stripe er BidHamrs egne gebyrer og fragt, der
            endnu ikke er udbetalt til BidHamrs bankkonto.
          </div>
        )}
      </div>
    );
  }

  // Periodens bevægelser: databasen mod Stripes balance transactions.
  let sammenligning: React.ReactNode = null;
  if (bevaegelser.ok && tal.ok) {
    const k = bevaegelser.data.kategorier;
    const s = (navn: string) => k[navn]?.beloeb ?? 0;
    const t = tal.data;
    const kendte = new Set([
      "charge", "refund", "refund_failure", "transfer", "transfer_reversal",
      "dispute", "dispute_reversal", "fee", "payout", "payout_reversal",
    ]);
    const oevrigt = Object.entries(k)
      .filter(([navn]) => !kendte.has(navn))
      .reduce((sum, [, v]) => sum + v.beloeb, 0);
    const raekker: { label: string; db: number | null; stripe: number }[] = [
      {
        label: "Betalinger modtaget",
        db: t.betalinger_modtaget.beloeb + t.forkerte_beloeb_modtaget.beloeb,
        stripe: s("charge"),
      },
      {
        label: "Refusioner",
        db: t.refusioner.fulde.beloeb + t.refusioner.delvise.beloeb + t.refusioner.forkerte_beloeb.beloeb,
        stripe: -(s("refund") + s("refund_failure")),
      },
      {
        label: "Overførsler til sælgere",
        db: t.udbetalinger.beloeb,
        stripe: -(s("transfer") + s("transfer_reversal")),
      },
      { label: "Indsigelser (netto trukket)", db: null, stripe: -(s("dispute") + s("dispute_reversal")) },
      { label: "Stripe-gebyrer", db: null, stripe: bevaegelser.data.gebyrer },
      { label: "Udbetalt til BidHamrs bankkonto", db: null, stripe: -(s("payout") + s("payout_reversal")) },
    ];
    if (oevrigt !== 0) raekker.push({ label: "Øvrige bevægelser (netto)", db: null, stripe: oevrigt });

    sammenligning = (
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Periodens bevægelser: databasen mod Stripe
        </p>
        {bevaegelser.data.ufuldstaendig && (
          <p className="mt-1 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800">
            Perioden har flere end {bevaegelser.data.antal} bevægelser hos Stripe – kun de nyeste er
            talt med. Vælg en kortere periode for en præcis afstemning.
          </p>
        )}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3 font-medium">Bevægelse</th>
                <th className="py-2 pr-3 text-right font-medium">Databasen</th>
                <th className="py-2 pr-3 text-right font-medium">Stripe</th>
                <th className="py-2 text-right font-medium">Afvigelse</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {raekker.map((r) => {
                const afv = r.db === null ? null : r.stripe - r.db;
                return (
                  <tr key={r.label}>
                    <td className="py-2 pr-3 text-neutral-700">{r.label}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-700">
                      {r.db === null ? <span className="text-neutral-400">kun hos Stripe</span> : kr(r.db)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-900">{kr(r.stripe)}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        afv === null ? "text-neutral-400" : afv === 0 ? "text-green-700" : "font-bold text-red-700"
                      }`}
                    >
                      {afv === null ? "–" : afv === 0 ? "0 kr" : kr(afv)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Små afvigelser lige ved periodens start eller slut kan skyldes, at Stripe og databasen
          registrerer samme betaling med få sekunders forskel. Stripes tal hentet{" "}
          {dato(bevaegelser.data.hentetKl)} (opdateres højst hvert minut).
        </p>
      </div>
    );
  }

  return (
    <Sektion
      titel="Afstemning mod Stripe"
      note="Stripe er sandheden om penge. Databasen spejler kun Stripe."
    >
      {balance.ok ? (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Kort titel="Tilgængeligt hos Stripe" vaerdi={kr(balance.data.tilgaengelig)} />
          <Kort titel="Afventer hos Stripe" vaerdi={kr(balance.data.afventer)} under="Betalinger, Stripe endnu ikke har frigivet" />
          {balance.data.andreValutaer.length > 0 && (
            <p className="text-xs text-neutral-500 sm:col-span-2">
              Stripe har også beløb i {balance.data.andreValutaer.join(", ")}. De er ikke talt med.
            </p>
          )}
        </div>
      ) : (
        <div className="mb-3">
          <Fejlboks tekst={`Stripe-balancen kunne ikke hentes: ${balance.fejl} Resten af siden virker.`} />
        </div>
      )}
      {daekning}
      {!bevaegelser.ok && (
        <div className="mt-4">
          <Fejlboks tekst={`Stripes bevægelser kunne ikke hentes: ${bevaegelser.fejl}`} />
        </div>
      )}
      {sammenligning}
    </Sektion>
  );
}

// nu: sidens tidspunkt (fra serveren), så "Forfalden" er stabil.
function Holdes({ h, nu }: { h: PengeHoldes; nu: number }) {
  return (
    <Sektion
      titel="Penge der holdes lige nu"
      note="Betalt, men endnu ikke frigivet, overført eller refunderet. Beløbet ligger hos Stripe."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kort titel="Beløb hos Stripe for handler" vaerdi={kr(h.beloeb)} under={`${h.antal} handler`} />
        <Kort titel="Heraf til sælgere ved frigivelse" vaerdi={kr(h.til_saelgere)} />
        <Kort
          titel="Forkerte beløb til refusion"
          vaerdi={kr(h.forkerte_beloeb.beloeb)}
          under={`${h.forkerte_beloeb.antal} betalinger`}
          tone={h.forkerte_beloeb.antal > 0 ? "orange" : "neutral"}
        />
      </div>

      {h.efter_grund.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {h.efter_grund.map((g) => (
            <span key={g.grund} className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700">
              {GRUND[g.grund] ?? g.grund}: {g.antal} · {kr(g.beloeb)}
            </span>
          ))}
        </div>
      )}

      {h.liste.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">Der holdes ingen penge lige nu.</p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-100">
          {h.liste.map((r) => {
            const forfalden = !!r.forventet_kl && new Date(r.forventet_kl).getTime() < nu;
            const venter = ["afventer_sag", "afventer_anke", "afventer_retur", "ankefrist", "indsigelse"].includes(r.grund);
            return (
              <li key={r.betaling_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  {r.auction_id ? (
                    <Link
                      href={`/auktion/${r.auction_id}`}
                      className="block truncate text-sm font-medium text-neutral-900 hover:underline"
                    >
                      {r.titel ?? "(slettet auktion)"}
                    </Link>
                  ) : (
                    <span className="text-sm text-neutral-500">(ingen auktion)</span>
                  )}
                  <p className="text-xs text-neutral-500">
                    <span className="font-mono" title={r.trade_id}>Handel {r.trade_id.slice(0, 8)}</span>
                    {" · "}
                    {HANDEL_STATUS[r.handel_status] ?? r.handel_status}
                    {r.betalt_kl && <> · betalt {dato(r.betalt_kl)}</>}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        venter ? "bg-orange-100 text-orange-800" : "bg-neutral-100 text-neutral-700"
                      }`}
                    >
                      {GRUND[r.grund] ?? r.grund}
                    </span>
                    {forfalden && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        Forfalden
                      </span>
                    )}
                    {r.kraever_opmaerksomhed && (
                      <Link
                        href="/admin/betalinger"
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 hover:underline"
                      >
                        Kræver handling
                      </Link>
                    )}
                    {r.penge_fejl && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        Fejl: {r.penge_fejl}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-neutral-600">{forventet(r)}</p>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <p className="text-sm font-semibold tabular-nums text-neutral-900">{kr(r.total_oere)}</p>
                  <p className="text-xs tabular-nums text-neutral-500">til sælger {kr(r.udbetaling_oere)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {h.antal > h.liste.length && (
        <p className="pt-2 text-xs text-neutral-500">
          Viser de {HOLDT_GRAENSE} første efter forventet tidspunkt ud af {h.antal}. Totalerne
          ovenfor omfatter alle.
        </p>
      )}
    </Sektion>
  );
}

// ------------------------------------------------------------ side

export default async function AdminPenge({
  searchParams,
}: {
  searchParams: Promise<{ periode?: string }>;
}) {
  const rolle = await getStaffRole();
  if (rolle !== "chef") notFound();

  const { periode: raa } = await searchParams;
  const periode = somPeriode(raa);
  const o = await hentPengeOversigt(periode);
  const t = o.tal.ok ? o.tal.data : null;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-neutral-900">Penge</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Hvad BidHamr har tjent, og hvor pengene er lige nu. Kun synlig for chef.
          </p>
          <p className="text-xs text-neutral-500">
            {o.fra ? `${dato(o.fra)} – ${dato(o.til)}` : `Alt til ${dato(o.til)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {o.testnoegle && (
            <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
              Stripe testmiljø
            </span>
          )}
          <nav aria-label="Periode" className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
            {PERIODER.map((p) => (
              <Link
                key={p.key}
                href={`/admin/penge?periode=${p.key}`}
                aria-current={p.key === periode ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  p.key === periode ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {!o.tal.ok && <Fejlboks tekst={o.tal.fejl} />}

      {t && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kort titel="Omsætning" vaerdi={kr(t.omsaetning.beloeb)} under={`Sum af bud · ${t.omsaetning.antal} betalte handler`} />
          <Kort titel="BidHamrs indtjening" vaerdi={kr(t.indtjening.i_alt)} tone="groen" under="Gebyrer og BidHamr Beskyttelse" />
          <Kort titel="Fragt" vaerdi={kr(t.fragt.beloeb)} under="Går videre til fragtfirmaet" />
          <Kort
            titel="Holdes hos Stripe nu"
            vaerdi={o.holdes.ok ? kr(o.holdes.data.beloeb) : "–"}
            under={o.holdes.ok ? `${o.holdes.data.antal} handler (uanset periode)` : undefined}
            tone="orange"
          />
        </div>
      )}

      {t && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Indtjening t={t} />
          <Pengestroem t={t} />
        </div>
      )}

      <Afstemning tal={o.tal} holdes={o.holdes} balance={o.balance} bevaegelser={o.bevaegelser} />

      {o.holdes.ok ? <Holdes h={o.holdes.data} nu={new Date(o.til).getTime()} /> : <Fejlboks tekst={o.holdes.fejl} />}
    </div>
  );
}
