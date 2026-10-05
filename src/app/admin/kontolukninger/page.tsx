import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import KontoLukningKort, {
  type KontoLukningAdvarsel,
  type KontoLukningForslag,
} from "@/components/admin/KontoLukningKort";
import AdminSideHoved from "@/components/admin/AdminSideHoved";

// "3 advarsler – skal kontoen lukkes?" Forslagene oprettes af databasen, når
// en bruger når 3 advarsler (påmindelser tæller ikke). Kontoen lukkes aldrig
// automatisk: admin/chef godkender eller afviser med begrundelse.

const PR_SIDE = 25;

const FANER = [
  { key: "afventer", label: "Afventer" },
  { key: "behandlet", label: "Behandlede" },
] as const;

type Forslag = KontoLukningForslag;
type Advarsel = KontoLukningAdvarsel;

export default async function AdminKontolukninger({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; side?: string }>;
}) {
  const { admin } = await kraevSideRolle("admin");
  const { vis, side: sideParam } = await searchParams;
  const fane = vis === "behandlet" ? "behandlet" : "afventer";
  const side = Math.max(1, Math.floor(Number(sideParam)) || 1);

  let q = admin
    .from("konto_lukning_forslag")
    .select("id, bruger_id, advarsler_antal, status, oprettet_kl, behandlet_af, behandlet_kl, begrundelse", {
      count: "exact",
    });
  q =
    fane === "afventer"
      ? q.eq("status", "afventer").order("oprettet_kl", { ascending: true })
      : q.neq("status", "afventer").order("behandlet_kl", { ascending: false });
  const [{ data, count, error }, { count: antalAfventer }] = await Promise.all([
    q.range((side - 1) * PR_SIDE, side * PR_SIDE - 1),
    admin.from("konto_lukning_forslag").select("id", { count: "exact", head: true }).eq("status", "afventer"),
  ]);
  if (error) throw new Error(error.message);

  const forslag = (data ?? []) as Forslag[];
  const brugerIds = [...new Set(forslag.map((f) => f.bruger_id))];
  const staffIds = [...new Set(forslag.map((f) => f.behandlet_af).filter(Boolean))] as string[];
  const alleIds = [...new Set([...brugerIds, ...staffIds])];

  const [{ data: brugere }, { data: advarsler }, { data: paamindelser }] = await Promise.all([
    alleIds.length
      ? admin.from("users").select("id, navn, email, rolle, konto_lukket_kl").in("id", alleIds)
      : Promise.resolve({ data: [] }),
    brugerIds.length
      ? admin
          .from("advarsler")
          .select("id, bruger_id, begrundelse_bruger, aarsag, grund, oprettet_kl")
          .in("bruger_id", brugerIds)
          .order("oprettet_kl", { ascending: true })
      : Promise.resolve({ data: [] }),
    brugerIds.length
      ? admin.from("paamindelser").select("bruger_id").in("bruger_id", brugerIds)
      : Promise.resolve({ data: [] }),
  ]);

  const brugerMap = new Map(
    ((brugere ?? []) as {
      id: string;
      navn: string | null;
      email: string | null;
      rolle: string | null;
      konto_lukket_kl: string | null;
    }[]).map((u) => [u.id, u]),
  );
  const advarselMap = new Map<string, Advarsel[]>();
  for (const a of (advarsler ?? []) as Advarsel[]) {
    const l = advarselMap.get(a.bruger_id) ?? [];
    l.push(a);
    advarselMap.set(a.bruger_id, l);
  }
  const paamindelseAntal = new Map<string, number>();
  for (const p of (paamindelser ?? []) as { bruger_id: string }[]) {
    paamindelseAntal.set(p.bruger_id, (paamindelseAntal.get(p.bruger_id) ?? 0) + 1);
  }

  const antalSider = Math.max(1, Math.ceil((count ?? 0) / PR_SIDE));

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Kontolukninger"
        forklaring="Brugere med 3 advarsler. Godkend lukningen af kontoen, eller afvis med en begrundelse."
      >
        <p className="mt-1 max-w-3xl text-xs text-neutral-500">
          Kontoen lukkes aldrig automatisk, og brugeren får først besked, når lukningen er godkendt.
          Påmindelser tæller ikke med.
        </p>
      </AdminSideHoved>

      <div className="flex flex-wrap gap-2">
        {FANER.map((f) => {
          const aktiv = f.key === fane;
          return (
            <Link
              key={f.key}
              href={`/admin/kontolukninger?vis=${f.key}`}
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

      {forslag.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
          {fane === "afventer" ? "Ingen konti venter på en afgørelse." : "Ingen behandlede forslag endnu."}
        </p>
      ) : (
        <ul className="space-y-3">
          {forslag.map((f) => (
            <li key={f.id}>
              <KontoLukningKort
                f={f}
                bruger={brugerMap.get(f.bruger_id)}
                behandletAf={f.behandlet_af ? (brugerMap.get(f.behandlet_af)?.navn ?? "ukendt") : null}
                advarsler={advarselMap.get(f.bruger_id) ?? []}
                paamindelser={paamindelseAntal.get(f.bruger_id) ?? 0}
              />
            </li>
          ))}
        </ul>
      )}

      {antalSider > 1 && (
        <div className="flex items-center justify-between text-sm">
          {side > 1 ? (
            <Link href={`/admin/kontolukninger?vis=${fane}&side=${side - 1}`} className="text-neutral-700 hover:underline">
              ← Forrige
            </Link>
          ) : (
            <span />
          )}
          <span className="text-neutral-500">
            Side {side} af {antalSider}
          </span>
          {side < antalSider ? (
            <Link href={`/admin/kontolukninger?vis=${fane}&side=${side + 1}`} className="text-neutral-700 hover:underline">
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
