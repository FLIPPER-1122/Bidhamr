import Link from "next/link";
import { notFound } from "next/navigation";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFejl from "@/components/admin/AdminFejl";
import { UUID_RE } from "@/lib/bot/konfig";

// Én samtale med BidHamr-bot (medarbejder og op). Forbruget pr. svar vises
// kun for chefen.

export const dynamic = "force-dynamic";

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });

type Besked = {
  id: string;
  rolle: "bruger" | "bot";
  tekst: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  pris_usd: number;
  vaerktoejer: string[];
  stop_aarsag: string | null;
  oprettet_kl: string;
};

export default async function AdminBotSamtale({ params }: { params: Promise<{ id: string }> }) {
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const erChef = rolle === "chef";

  const [{ data: samtale }, beskederSvar, { data: henvendelse }] = await Promise.all([
    admin
      .from("bot_samtaler")
      .select("id, bruger_id, kilde, email, overdraget_kl, oprettet_kl")
      .eq("id", id)
      .maybeSingle<{ id: string; bruger_id: string | null; kilde: string; email: string | null; overdraget_kl: string | null; oprettet_kl: string }>(),
    admin
      .from("bot_beskeder")
      .select("id, rolle, tekst, input_tokens, output_tokens, cache_read_tokens, pris_usd, vaerktoejer, stop_aarsag, oprettet_kl")
      .eq("samtale_id", id)
      .order("oprettet_kl", { ascending: true })
      .limit(500),
    admin.from("kontakt_henvendelser").select("id, status").eq("bot_samtale_id", id).maybeSingle<{ id: string; status: string }>(),
  ]);
  if (!samtale) notFound();
  const beskeder = (beskederSvar.data ?? []) as Besked[];
  const { data: bruger } = samtale.bruger_id
    ? await admin.from("users").select("navn").eq("id", samtale.bruger_id).maybeSingle<{ navn: string | null }>()
    : { data: null };

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Samtale med BidHamr-bot"
        forklaring={`${samtale.kilde === "app" ? "App" : "Hjemmeside"} · startet ${tid(samtale.oprettet_kl)}`}
      />
      <p className="text-sm text-tekst">
        <Link href="/admin/bot" className="text-groen hover:underline">
          ← Alle samtaler
        </Link>
        {" · "}
        {samtale.bruger_id ? (
          <Link href={`/admin/brugere/${samtale.bruger_id}`} className="text-groen hover:underline">
            {bruger?.navn ?? "Bruger"}
          </Link>
        ) : (
          <span>Ikke logget ind{samtale.email ? ` · ${samtale.email}` : ""}</span>
        )}
        {henvendelse && (
          <>
            {" · "}
            <Link href="/admin/kontakt" className="text-groen hover:underline">
              Henvendelse ({henvendelse.status === "ny" ? "venter på svar" : "besvaret"})
            </Link>
          </>
        )}
      </p>

      {beskederSvar.error ? (
        <AdminFejl hvad="Samtalen" />
      ) : (
        <ol className="space-y-3">
          {beskeder.map((b) => (
            <li
              key={b.id}
              className={`border p-3 text-sm ${b.rolle === "bruger" ? "border-admin-kant bg-white" : "border-admin-kant bg-admin-graa"}`}
            >
              <p className="mb-1 text-xs text-tekst-svag">
                {b.rolle === "bruger" ? "Bruger" : "BidHamr-bot"} · {tid(b.oprettet_kl)}
                {b.rolle === "bot" && b.vaerktoejer.length > 0 && ` · slog op: ${b.vaerktoejer.join(", ")}`}
                {b.rolle === "bot" && b.stop_aarsag && b.stop_aarsag !== "end_turn" && ` · ${b.stop_aarsag}`}
                {erChef && b.rolle === "bot" &&
                  ` · ${b.input_tokens + b.cache_read_tokens} ind / ${b.output_tokens} ud · $${Number(b.pris_usd).toFixed(4)}`}
              </p>
              <p className="whitespace-pre-wrap break-words text-tekst">{b.tekst}</p>
            </li>
          ))}
        </ol>
      )}
    </AdminSide>
  );
}
