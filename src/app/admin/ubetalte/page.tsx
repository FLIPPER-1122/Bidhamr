import Link from "next/link";
import { assertRole } from "@/lib/adminAuth";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { advarselFelter } from "@/components/admin/advarselFelter";
import { ubetaltAfvis, ubetaltGivAdvarsel } from "@/app/actions/adminActions";
import AdminSideHoved from "@/components/admin/AdminSideHoved";

// Sager "Ubetalt vinder": oprettes af cron, når vinderen ikke betaler inden
// fristen. En medarbejder giver advarsel eller afviser sagen.

const PR_SIDE = 25;

const FANER = [
  { key: "afventer", label: "Afventer" },
  { key: "behandlet", label: "Behandlede" },
] as const;

type Sag = {
  id: string;
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  oprettet: string;
  status: "afventer" | "advarsel_givet" | "afvist";
  behandlet_kl: string | null;
  begrundelse: string | null;
};

const kr = (v: number | string) =>
  Number(v).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " kr";

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" });

export default async function AdminUbetalte({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { admin } = await assertRole("medarbejder");
  const { vis, side: sideParam } = await searchParams;
  const fane = vis === "behandlet" ? "behandlet" : "afventer";
  const side = Math.max(1, Math.floor(Number(sideParam)) || 1);

  let q = admin
    .from("ubetalte_vindere")
    .select("id, trade_id, auction_id, buyer_id, oprettet, status, behandlet_kl, begrundelse", {
      count: "exact",
    });
  q =
    fane === "afventer"
      ? q.eq("status", "afventer").order("oprettet", { ascending: true })
      : q.neq("status", "afventer").order("behandlet_kl", { ascending: false });
  const [{ data, count, error }, { count: antalAfventer }] = await Promise.all([
    q.range((side - 1) * PR_SIDE, side * PR_SIDE - 1),
    admin.from("ubetalte_vindere").select("id", { count: "exact", head: true }).eq("status", "afventer"),
  ]);
  if (error) throw new Error(error.message);

  const sager = (data ?? []) as Sag[];
  const koeberIds = [...new Set(sager.map((s) => s.buyer_id))];
  const auktionIds = [...new Set(sager.map((s) => s.auction_id))];
  const tradeIds = sager.map((s) => s.trade_id);

  const [{ data: brugere }, { data: auktioner }, { data: handler }, { data: advarsler }] =
    await Promise.all([
      koeberIds.length
        ? admin.from("users").select("id, navn, email").in("id", koeberIds)
        : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string }[] }),
      auktionIds.length
        ? admin.from("auctions").select("id, titel").in("id", auktionIds)
        : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
      tradeIds.length
        ? admin.from("trades").select("id, amount").in("id", tradeIds)
        : Promise.resolve({ data: [] as { id: string; amount: number | string }[] }),
      koeberIds.length
        ? admin.from("advarsler").select("bruger_id").in("bruger_id", koeberIds)
        : Promise.resolve({ data: [] as { bruger_id: string }[] }),
    ]);

  const brugerMap = new Map((brugere ?? []).map((u) => [u.id as string, u]));
  const titelMap = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
  const beloebMap = new Map((handler ?? []).map((h) => [h.id as string, h.amount]));
  const advarselAntal = new Map<string, number>();
  for (const a of advarsler ?? []) {
    advarselAntal.set(a.bruger_id as string, (advarselAntal.get(a.bruger_id as string) ?? 0) + 1);
  }

  const antalSider = Math.max(1, Math.ceil((count ?? 0) / PR_SIDE));

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Ubetalte vindere"
        forklaring="Vindere, der ikke betalte inden fristen. Giv en advarsel, eller afvis, hvis der er en god grund."
      />

      <div className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          return (
            <Link
              key={f.key}
              href={`/admin/ubetalte?vis=${f.key}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                aktiv
                  ? "bg-orange-knap text-white"
                  : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {f.label}
              {f.key === "afventer" && (
                <span className={`ml-1.5 text-xs ${aktiv ? "text-white/80" : "text-neutral-400"}`}>
                  {antalAfventer ?? 0}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {sager.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
          {fane === "afventer" ? "Ingen sager venter." : "Ingen behandlede sager endnu."}
        </p>
      ) : (
        <ul className="space-y-3">
          {sager.map((s) => {
            const k = brugerMap.get(s.buyer_id);
            const tidligere = advarselAntal.get(s.buyer_id) ?? 0;
            const beloeb = beloebMap.get(s.trade_id);
            return (
              <li key={s.id} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
                <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div className="min-w-0">
                    <p className="text-xs uppercase text-neutral-500">Køber</p>
                    <Link href={`/admin/brugere/${s.buyer_id}`} className="block hover:underline">
                      <span className="block truncate font-medium text-neutral-800">
                        {(k?.navn as string | null) ?? "Uden navn"}
                      </span>
                      <span className="block truncate text-xs text-neutral-500">{k?.email as string}</span>
                    </Link>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs uppercase text-neutral-500">Auktion</p>
                    <Link
                      href={`/auktion/${s.auction_id}`}
                      className="block truncate font-medium text-neutral-800 hover:underline"
                    >
                      {titelMap.get(s.auction_id) ?? "(slettet auktion)"}
                    </Link>
                    <span className="text-xs text-neutral-500">
                      {beloeb !== undefined ? kr(beloeb) : "—"}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-neutral-500">Oprettet</p>
                    <p className="text-neutral-800">{dato(s.oprettet)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-neutral-500">Advarsler i alt</p>
                    <p className={tidligere > 0 ? "font-semibold text-red-700" : "text-neutral-800"}>
                      {tidligere}
                    </p>
                  </div>
                </div>

                {s.status === "afventer" ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <ConfirmDialog
                      triggerLabel="Giv advarsel"
                      triggerClassName="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                      title="Giv køberen en advarsel?"
                      description="Advarslen registreres på køberens konto, og køberen får besked med begrundelsen."
                      confirmLabel="Giv advarsel"
                      action={ubetaltGivAdvarsel}
                      hiddenFields={{ sagId: s.id }}
                      tekstFelter={advarselFelter({
                        internNavn: "begrundelse",
                        brugerPlaceholder: "Fx: Du betalte ikke for en auktion, du vandt, inden for fristen.",
                        internPlaceholder: "Betalte ikke for vundet auktion",
                      })}
                    />
                    <ConfirmDialog
                      triggerLabel="Afvis"
                      triggerClassName="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
                      title="Afvis sagen?"
                      description="Køberen får ingen advarsel."
                      confirmLabel="Afvis sagen"
                      action={ubetaltAfvis}
                      hiddenFields={{ sagId: s.id }}
                      aarsagField={{
                        name: "begrundelse",
                        label: "Begrundelse",
                        placeholder: "Hvorfor afvises sagen?",
                        required: true,
                      }}
                    />
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                    <span
                      className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        s.status === "advarsel_givet" ? "bg-red-100 text-red-700" : "bg-neutral-200 text-neutral-700"
                      }`}
                    >
                      {s.status === "advarsel_givet" ? "Advarsel givet" : "Afvist"}
                    </span>
                    {s.behandlet_kl && <span className="text-xs text-neutral-500">{dato(s.behandlet_kl)}</span>}
                    {s.begrundelse && <p className="mt-1">{s.begrundelse}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {antalSider > 1 && (
        <div className="flex items-center justify-between text-sm">
          {side > 1 ? (
            <Link href={`/admin/ubetalte?vis=${fane}&side=${side - 1}`} className="text-neutral-700 hover:underline">
              ← Forrige
            </Link>
          ) : (
            <span />
          )}
          <span className="text-neutral-500">
            Side {side} af {antalSider}
          </span>
          {side < antalSider ? (
            <Link href={`/admin/ubetalte?vis=${fane}&side=${side + 1}`} className="text-neutral-700 hover:underline">
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
