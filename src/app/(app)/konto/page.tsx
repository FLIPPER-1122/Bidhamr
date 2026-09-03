import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import IndbetalForm from "@/components/IndbetalForm";
import { kindLabel, kr } from "@/lib/wallet";

export const dynamic = "force-dynamic";

type Wallet = { balance: number; reserved: number };
type Entry = {
  id: string;
  amount: number;
  kind: string;
  note: string | null;
  balance_after: number;
  created_at: string;
};

export default async function KontoSide({
  searchParams,
}: {
  searchParams: Promise<{ indbetaling?: string }>;
}) {
  const { indbetaling } = await searchParams;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login?redirect=/konto");
  }

  // RLS sørger for, at man kun kan se sin egen konto.
  const { data: walletData } = await supabase
    .from("wallets")
    .select("balance, reserved")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  const wallet: Wallet = walletData
    ? { balance: Number(walletData.balance), reserved: Number(walletData.reserved) }
    : { balance: 0, reserved: 0 };

  const ledig = wallet.balance - wallet.reserved;

  const { data: entriesData } = await supabase
    .from("wallet_entries")
    .select("id, amount, kind, note, balance_after, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const entries = (entriesData ?? []) as Entry[];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-neutral-900">Min konto</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Du byder med penge, der står på din BidHamr-konto. Vinder du en
        auktion, trækkes beløbet automatisk.
      </p>

      {indbetaling === "ok" && (
        <div className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
          Tak for din indbetaling! Beløbet står på kontoen, så snart betalingen
          er bekræftet — det tager normalt få sekunder. Genindlæs siden, hvis
          saldoen ikke er opdateret endnu.
        </div>
      )}
      {indbetaling === "afbrudt" && (
        <div className="mt-4 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-700">
          Indbetalingen blev afbrudt. Der er ikke trukket nogen penge.
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-brand bg-red-50 p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-brand">
            Til rådighed
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{kr(ledig)}</p>
          <p className="mt-1 text-xs text-neutral-600">Kan bruges til nye bud</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Reserveret
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">
            {kr(wallet.reserved)}
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            Bundet i bud, hvor du fører
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Samlet saldo
          </p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">
            {kr(wallet.balance)}
          </p>
          <p className="mt-1 text-xs text-neutral-600">Indestående i alt</p>
        </div>
      </div>

      {wallet.reserved > 0 && (
        <p className="mt-3 text-sm text-neutral-600">
          Når du er højestbydende, reserveres dit bud plus 5% købergebyr. Bliver
          du overbudt, frigives pengene med det samme.
        </p>
      )}

      <section className="mt-8 rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-neutral-900">
          Indbetal til kontoen
        </h2>
        <p className="mb-4 mt-1 text-sm text-neutral-500">
          Betalingen håndteres af Stripe. BidHamr gemmer aldrig dine
          kortoplysninger.
        </p>
        <IndbetalForm />
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-neutral-900">Kontoudtog</h2>

        {entries.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            Der er endnu ingen bevægelser på din konto.
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                  <th className="px-4 py-3 text-left font-medium">Dato</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-right font-medium">Beløb</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {entries.map((e) => {
                  const beløb = Number(e.amount);
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-neutral-500">
                        {new Date(e.created_at).toLocaleDateString("da-DK", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-neutral-800">
                          {kindLabel(e.kind)}
                        </span>
                        {e.note && (
                          <span className="block text-xs text-neutral-500">
                            {e.note}
                          </span>
                        )}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-3 text-right font-medium ${
                          beløb < 0 ? "text-neutral-800" : "text-green-700"
                        }`}
                      >
                        {beløb > 0 ? "+" : ""}
                        {kr(beløb)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-neutral-500">
                        {kr(Number(e.balance_after))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 text-sm text-neutral-500">
        Se dine køb og salg under{" "}
        <Link href="/mine-handler" className="font-medium text-brand hover:underline">
          Mine handler
        </Link>
        .
      </p>
    </main>
  );
}
