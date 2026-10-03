import Link from "next/link";
import { assertRole } from "@/lib/adminAuth";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { advarselFelter } from "@/components/admin/advarselFelter";
import {
  hentBetalingerTilHandling,
  markerBetalingLøstForm,
  givAdvarselBetalingForm,
  markerUdbetalingskontoLøstForm,
  nulstilUdbetalingskontoForm,
  type BetalingBeloeb,
  type Person,
} from "@/app/actions/adminBetalinger";
import { prøvOverfoerselIgenForm } from "@/app/actions/adminActions";

// Betalinger, der kræver handling: markeret af webhook/cron (kraever_opmaerksomhed)
// eller modtaget med forkert beløb (betaling_afvigelser). Beløb vises kun for chef.

const FANER = [
  { key: "aaben", label: "Kræver handling" },
  { key: "loest", label: "Løste" },
] as const;

const STATUS: Record<string, string> = {
  afventer: "Afventer betaling",
  behandles: "Behandles",
  betalt: "Betalt",
  annulleret: "Annulleret",
  refunderet: "Refunderet",
};

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" });

const kr = (oere: number) =>
  (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

// sidste_fejl skrives i databasen uden æøå (oe/aa/ae). Ret de kendte ord.
function fejlPaaDansk(tekst: string | null): string {
  if (!tekst) return "Ingen fejlbeskrivelse.";
  return tekst
    .replace(/\bkoeber(en)?\b/g, "køber$1")
    .replace(/\bsaelger(en)?\b/g, "sælger$1")
    .replace(/\boverfoersel\b/g, "overførsel")
    .replace(/\bfejlet\b/g, "fejlede");
}

function PersonLink({ label, p }: { label: string; p: Person | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase text-neutral-500">{label}</p>
      {p ? (
        <Link
          href={`/admin/brugere/${p.id}`}
          className="block truncate font-medium text-neutral-800 hover:underline"
        >
          {p.navn ?? "Uden navn"}
        </Link>
      ) : (
        <span className="text-neutral-500">—</span>
      )}
    </div>
  );
}

function AuktionLink({ id, titel, tradeId }: { id: string | null; titel: string | null; tradeId: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase text-neutral-500">Auktion</p>
      {id ? (
        <Link href={`/auktion/${id}`} className="block truncate font-medium text-neutral-800 hover:underline">
          {titel ?? "(slettet auktion)"}
        </Link>
      ) : (
        <span className="text-neutral-500">—</span>
      )}
      <span className="block truncate font-mono text-xs text-neutral-400" title={tradeId}>
        Handel {tradeId.slice(0, 8)}
      </span>
    </div>
  );
}

function Beloeb({ b, annulleret }: { b: BetalingBeloeb; annulleret: boolean }) {
  const linjer: [string, number, string?][] = [
    ["Total", b.total_oere],
    ["Udbetaling", b.udbetaling_oere],
    ["Fragt", b.fragt_oere, annulleret && b.fragt_oere > 0 ? " (refunderes ved annullering)" : undefined],
    ["Købergebyr", b.koebergebyr_oere],
    ["Sælgergebyr", b.saelgergebyr_oere],
  ];
  if (b.beskyttelse_oere > 0) linjer.push(["BidHamr Beskyttelse", b.beskyttelse_oere]);
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-neutral-50 px-3 py-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
      {linjer.map(([l, v, note]) => (
        <div key={l}>
          <dt className="text-neutral-500">{l}</dt>
          <dd className="font-medium text-neutral-800">
            {kr(v)}
            {note}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AdminBetalinger({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  await assertRole("medarbejder");
  const { vis, side } = await searchParams;
  const fane = vis === "loest" ? "loest" : "aaben";
  const res = await hentBetalingerTilHandling(Number(side) || 1, fane);
  if ("fejl" in res) throw new Error(res.fejl);

  const { betalinger, afvigelser, udenHandel, udbetalingskonti, antalSider, side: s, kanLoese, antalAabne } = res;
  const tom =
    betalinger.length === 0 &&
    afvigelser.length === 0 &&
    udenHandel.length === 0 &&
    udbetalingskonti.length === 0;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Betalinger</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Betalinger, hvor noget gik galt og en medarbejder skal kigge på det.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          return (
            <Link
              key={f.key}
              href={`/admin/betalinger?vis=${f.key}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                aktiv
                  ? "bg-orange-knap text-white"
                  : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {f.label}
              {f.key === "aaben" && (
                <span className={`ml-1.5 text-xs ${aktiv ? "text-white/80" : "text-neutral-400"}`}>
                  {antalAabne}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {tom ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
          {fane === "aaben" ? "Ingen betalinger kræver handling." : "Ingen løste betalinger endnu."}
        </p>
      ) : (
        <>
          {afvigelser.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-neutral-700">Forkert beløb – venter på refusion</h2>
              <ul className="space-y-3">
                {afvigelser.map((a) => (
                  <li key={a.id} className="rounded-xl border border-amber-200 bg-white p-4 sm:p-5">
                    <span className="mb-3 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Afvigelse
                    </span>
                    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <AuktionLink id={a.auction_id} titel={a.auktion_titel} tradeId={a.trade_id} />
                      <PersonLink label="Køber" p={a.koeber} />
                      <PersonLink label="Sælger" p={a.saelger} />
                      <div>
                        <p className="text-xs uppercase text-neutral-500">Modtaget</p>
                        <p className="text-neutral-800">{dato(a.dato)}</p>
                        <p className="text-xs text-neutral-500">Refusionsforsøg: {a.refusion_forsoeg}</p>
                      </div>
                    </div>
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                      {fejlPaaDansk(a.sidste_fejl ?? "Refunderes automatisk.")}
                    </p>
                    {a.beloeb && (
                      <p className="mt-2 text-xs text-neutral-600">
                        Modtaget {kr(a.beloeb.modtaget_oere)} · forventet {kr(a.beloeb.forventet_oere)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {udbetalingskonti.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-neutral-700">Udbetalingskonti hos Stripe</h2>
              <p className="text-xs text-neutral-500">
                Sælgere, hvor en udbetaling til banken fejlede, eller hvor kontoen er lukket eller afvist hos Stripe.
              </p>
              <ul className="space-y-3">
                {udbetalingskonti.map((k) => (
                  <li key={k.saelger.id} className="rounded-xl border border-amber-200 bg-white p-4 sm:p-5">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Udbetalingskonto
                      </span>
                      {k.frakoblet && (
                        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                          Lukket hos Stripe
                        </span>
                      )}
                    </div>
                    <div className="grid gap-3 text-sm sm:grid-cols-2">
                      <PersonLink label="Sælger" p={k.saelger} />
                      <div>
                        <p className="text-xs uppercase text-neutral-500">Markeret</p>
                        <p className="text-neutral-800">{k.dato ? dato(k.dato) : "—"}</p>
                      </div>
                    </div>
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                      {k.aarsag ?? "Ingen beskrivelse."}
                    </p>
                    {kanLoese && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <ConfirmDialog
                          triggerLabel="Markér som løst"
                          triggerClassName="rounded-lg bg-orange-knap px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork"
                          title="Markér udbetalingskontoen som løst?"
                          description="Kontoen forsvinder fra listen. Skriv, hvad der er gjort."
                          confirmLabel="Markér som løst"
                          action={markerUdbetalingskontoLøstForm}
                          hiddenFields={{ brugerId: k.saelger.id }}
                          aarsagField={{
                            name: "note",
                            label: "Note",
                            placeholder: "Fx: Sælger har rettet sin bankkonto hos Stripe",
                            required: true,
                          }}
                        />
                        {k.frakoblet && (
                          <ConfirmDialog
                            triggerLabel="Nulstil udbetalingskonto"
                            triggerClassName="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-50"
                            title="Nulstil udbetalingskontoen?"
                            description="Den lukkede konto fjernes fra sælgeren, så sælgeren kan oprette en ny udbetalingskonto hos Stripe. Frigivne beløb, der venter, overføres til den nye konto, når Stripe har godkendt den. Sælgeren får besked. Handlingen logges."
                            confirmLabel="Nulstil udbetalingskonto"
                            action={nulstilUdbetalingskontoForm}
                            hiddenFields={{ brugerId: k.saelger.id }}
                            aarsagField={{
                              name: "begrundelse",
                              label: "Begrundelse",
                              placeholder: "Fx: Sælger har skrevet til support og vil oprette en ny konto",
                              required: true,
                            }}
                          />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {udenHandel.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-neutral-700">Auktioner uden handel</h2>
              <p className="text-xs text-neutral-500">
                Afsluttede auktioner med en vinder, hvor der ikke er oprettet en handel.
              </p>
              <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
                {udenHandel.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                    <Link
                      href={`/auktion/${a.id}`}
                      className="min-w-0 flex-1 truncate font-medium text-neutral-800 hover:underline"
                    >
                      {a.titel ?? "(uden titel)"}
                    </Link>
                    <span className="text-xs text-neutral-500">Sluttede {dato(a.slutter_kl)}</span>
                    {a.for_gammel_til_automatik && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        for gammel til automatik
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {betalinger.length > 0 && (
            <ul className="space-y-3">
              {betalinger.map((b) => (
                <li key={b.id} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                      {STATUS[b.status] ?? b.status}
                    </span>
                    {b.indsigelse_kl && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                        Indsigelse {dato(b.indsigelse_kl)}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <AuktionLink id={b.auction_id} titel={b.auktion_titel} tradeId={b.trade_id} />
                    <PersonLink label="Køber" p={b.koeber} />
                    <PersonLink label="Sælger" p={b.saelger} />
                    <div>
                      <p className="text-xs uppercase text-neutral-500">Senest ændret</p>
                      <p className="text-neutral-800">{dato(b.dato)}</p>
                    </div>
                  </div>

                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                    {fejlPaaDansk(b.sidste_fejl)}
                  </p>

                  {b.beloeb && <Beloeb b={b.beloeb} annulleret={b.handel_status === "annulleret"} />}

                  {b.loest ? (
                    <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                      <span className="mr-2 inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        Løst
                      </span>
                      <span className="text-xs text-neutral-500">
                        {dato(b.loest.kl)}
                        {b.loest.af ? ` af ${b.loest.af}` : ""}
                      </span>
                      <p className="mt-1 whitespace-pre-line">{b.loest.note}</p>
                    </div>
                  ) : (
                    kanLoese &&
                    fane === "aaben" && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {b.kanProeveOverfoersel && (
                          <ConfirmDialog
                            triggerLabel="Prøv overførsel igen"
                            triggerClassName="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-100"
                            title="Prøv overførslen til sælger igen?"
                            description="Overførslen får nye forsøg og prøves med det samme. Betalingen forbliver markeret, indtil pengene faktisk er overført."
                            confirmLabel="Prøv igen"
                            action={prøvOverfoerselIgenForm}
                            hiddenFields={{ tradeId: b.trade_id }}
                          />
                        )}
                        <ConfirmDialog
                          triggerLabel="Markér som løst"
                          triggerClassName="rounded-lg bg-orange-knap px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork"
                          title="Markér betalingen som løst?"
                          description="Betalingen forsvinder fra listen. Skriv, hvad der er gjort."
                          confirmLabel="Markér som løst"
                          action={markerBetalingLøstForm}
                          hiddenFields={{ betalingId: b.id }}
                          aarsagField={{
                            name: "note",
                            label: "Note",
                            placeholder: "Fx: Refunderet manuelt i Stripe",
                            required: true,
                          }}
                        />
                        <ConfirmDialog
                          triggerLabel="Giv advarsel"
                          triggerClassName="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-100"
                          title="Giv advarsel og luk sagen?"
                          description="Advarslen tæller med i reglen om 3 advarsler. Betalingen markeres som løst."
                          confirmLabel="Giv advarsel"
                          action={givAdvarselBetalingForm}
                          hiddenFields={{ betalingId: b.id }}
                          valgField={{
                            name: "modtager",
                            label: "Hvem får advarslen?",
                            valg: [
                              { value: "koeber", label: b.koeber.navn ? `Køber (${b.koeber.navn})` : "Køber" },
                              { value: "saelger", label: b.saelger.navn ? `Sælger (${b.saelger.navn})` : "Sælger" },
                            ],
                          }}
                          tekstFelter={advarselFelter({
                            internNavn: "begrundelse",
                            brugerPlaceholder: "Fx: Du sendte ikke varen, selvom køberen havde betalt.",
                            internPlaceholder: "Fx: Sendte ikke varen trods flere påmindelser",
                          })}
                        />
                      </div>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {antalSider > 1 && (
        <div className="flex items-center justify-between text-sm">
          {s > 1 ? (
            <Link href={`/admin/betalinger?vis=${fane}&side=${s - 1}`} className="text-neutral-700 hover:underline">
              ← Forrige
            </Link>
          ) : (
            <span />
          )}
          <span className="text-neutral-500">
            Side {s} af {antalSider}
          </span>
          {s < antalSider ? (
            <Link href={`/admin/betalinger?vis=${fane}&side=${s + 1}`} className="text-neutral-700 hover:underline">
              Næste →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
