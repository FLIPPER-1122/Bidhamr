import { assertRole } from "@/lib/adminAuth";
import { kroner } from "@/lib/kroner";

// Admin -> Penge (kun chef): boost-salget i perioden, delt på bidhamr.dk
// (Stripe - BidHamrs egen omsætning med moms og faktura) og køb i appen via
// Apple og Google (Apple/Google er sælger, opkræver moms og udsteder
// kvitteringen; BidHamr får beløbet efter deres gebyr og laver ingen
// faktura). Bruttoprisen for køb i appen er kun kendt, når Apple oplyser den
// i DKK - Google oplyser ikke prisen på købet; "listepris" er hjemmesidens
// pris for samme pakke. Bogføring: docs/IAP.md.

type Platform = {
  antal: number;
  point: number;
  brutto_oere: number;
  ukendt_pris: number;
  listepris_oere: number;
  refunderet_antal: number;
  refunderet_point: number;
  refunderet_oere: number;
  test_antal: number;
};
type Oversigt = {
  stripe: { antal: number; brutto_oere: number; refunderet_antal: number; refunderet_oere: number };
  apple: Platform;
  google: Platform;
  i_minus: number;
};

function Linje({ navn, vaerdi }: { navn: string; vaerdi: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-neutral-600">{navn}</dt>
      <dd className="tabular-nums font-medium text-neutral-900">{vaerdi}</dd>
    </div>
  );
}

function AppKolonne({ titel, p, prisKendt }: { titel: string; p: Platform; prisKendt: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-neutral-100 p-3">
      <h3 className="text-sm font-semibold text-neutral-800">{titel}</h3>
      <dl className="mt-1 text-sm">
        <Linje navn="Køb" vaerdi={`${p.antal} (${p.point.toLocaleString("da-DK")} point)`} />
        {prisKendt && <Linje navn="Bruttopris (DKK)" vaerdi={kroner(Number(p.brutto_oere))} />}
        {prisKendt && p.ukendt_pris > 0 && <Linje navn="Køb i anden valuta" vaerdi={String(p.ukendt_pris)} />}
        <Linje navn="Listepris på bidhamr.dk" vaerdi={kroner(Number(p.listepris_oere))} />
        <Linje navn="Refunderet" vaerdi={`${p.refunderet_antal} (${p.refunderet_point.toLocaleString("da-DK")} point)`} />
        {prisKendt && p.refunderet_oere > 0 && <Linje navn="Refunderet (DKK)" vaerdi={kroner(Number(p.refunderet_oere))} />}
        {p.test_antal > 0 && <Linje navn="Testkøb (tæller ikke med)" vaerdi={String(p.test_antal)} />}
      </dl>
    </div>
  );
}

export default async function BoostSalg({ fra, til }: { fra: string | null; til: string }) {
  const { userId, admin } = await assertRole("chef");
  const { data, error } = await admin.rpc("boost_salg_oversigt", { p_staff: userId, p_fra: fra, p_til: til });
  if (error || !data) return null; // migrationen er ikke kørt
  const o = data as Oversigt;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-neutral-900">Boost-salg</h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Køb på bidhamr.dk er BidHamrs egen omsætning (faktura med moms). Køb i appen sælger Apple og Google selv – de
          opkræver moms, udsteder kvitteringen og udbetaler beløbet efter deres gebyr. BidHamr laver ingen faktura for dem.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:px-5 lg:grid-cols-3">
        <div className="min-w-0 rounded-lg border border-neutral-100 p-3">
          <h3 className="text-sm font-semibold text-neutral-800">bidhamr.dk (Stripe)</h3>
          <dl className="mt-1 text-sm">
            <Linje navn="Køb" vaerdi={String(o.stripe.antal)} />
            <Linje navn="Bruttopris (DKK)" vaerdi={kroner(Number(o.stripe.brutto_oere))} />
            <Linje navn="Refunderet" vaerdi={`${o.stripe.refunderet_antal} (${kroner(Number(o.stripe.refunderet_oere))})`} />
          </dl>
        </div>
        <AppKolonne titel="App Store (Apple)" p={o.apple} prisKendt />
        <AppKolonne titel="Google Play" p={o.google} prisKendt={false} />
      </div>
      {o.i_minus > 0 && (
        <p className="px-4 pb-3 text-sm text-red-700 sm:px-5">
          {o.i_minus === 1 ? "1 bruger har" : `${o.i_minus} brugere har`} en negativ saldo efter en refusion i appen (nu, uanset periode).
        </p>
      )}
    </section>
  );
}
