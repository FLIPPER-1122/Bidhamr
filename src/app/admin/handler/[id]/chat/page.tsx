import Link from "next/link";
import { notFound } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { UUID_RE, faellesbeskedId } from "@/lib/moderationLog";
import { fjernFaellesPraefiks } from "@/lib/staffChat";
import { BidhamrMaerke } from "@/components/staffchat/visning";
import HandelStatusBadge from "@/components/HandelStatusBadge";

// Staffs læsevisning af chatten mellem køber og sælger på en handel
// (medarbejder og op). Kun læsning – staff skriver til parterne med
// fællesbeskeden. Hver åbning logges i moderation_log som 'chat_laest'
// (højst én post pr. medarbejder pr. handel pr. 10 min, se
// supabase/migrations/20261005070000_admin_se_chat.sql). Kan læsningen ikke
// logges, vises chatten ikke.

type Besked = {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  fra_bidhamr: boolean;
};

const TZ = "Europe/Copenhagen";
// Supabase returnerer højst 1000 rækker pr. kald – hent i bidder.
const BID = 1000;
const MAKS_BESKEDER = 5000;

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Tilbage({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      {children}
    </Link>
  );
}

export default async function AdminHandelChat({ params }: { params: Promise<{ id: string }> }) {
  const { userId, admin } = await assertRole("medarbejder");
  const { id: raa } = await params;
  if (!UUID_RE.test(raa)) notFound();
  const tradeId = raa.toLowerCase();
  const handelHref = `/admin/handler?vis=alle&q=${tradeId}`;

  const { data: handel, error: handelFejl } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id, status, created_at")
    .eq("id", tradeId)
    .maybeSingle();
  if (handelFejl) throw new Error(handelFejl.message);
  if (!handel) notFound();

  // Log læsningen, før noget af chatten hentes og vises.
  const { data: log, error: logFejl } = await admin.rpc("admin_log_chat_laest", {
    p_medarbejder: userId,
    p_trade: tradeId,
  });
  const logKode = (log as { kode?: string } | null)?.kode;
  if (logFejl || (logKode !== "ok" && logKode !== "dedup")) {
    console.error("admin_log_chat_laest fejlede:", logFejl?.message ?? logKode);
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <Tilbage href={handelHref}>Tilbage til handlen</Tilbage>
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          Chatten kan ikke vises lige nu, fordi læsningen ikke kunne registreres i medarbejder-loggen. Prøv igen om lidt.
        </p>
      </div>
    );
  }

  const beskeder: Besked[] = [];
  for (let fra = 0; fra < MAKS_BESKEDER; fra += BID) {
    const { data, error } = await admin
      .from("messages")
      .select("id, sender_id, content, created_at, fra_bidhamr")
      .eq("trade_id", tradeId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(fra, fra + BID - 1);
    if (error) throw new Error(error.message);
    const bid = (data ?? []) as Besked[];
    beskeder.push(...bid.map((b) => ({ ...b, fra_bidhamr: b.fra_bidhamr === true })));
    if (bid.length < BID) break;
  }
  const afkortet = beskeder.length >= MAKS_BESKEDER;

  // Hvem i BidHamr der sendte hver fællesbesked: faellesbesked() logger
  // "Besked <message-id>: <tekst>" i moderation_log.
  const harFaelles = beskeder.some((b) => b.fra_bidhamr);
  const [{ data: auktion }, { data: faellesLog }] = await Promise.all([
    admin.from("auctions").select("titel").eq("id", handel.auction_id).maybeSingle(),
    harFaelles
      ? admin
          .from("moderation_log")
          .select("medarbejder_id, aarsag")
          .eq("handling", "faellesbesked")
          .eq("maal_type", "handel")
          .eq("maal_id", tradeId)
          .limit(1000)
      : Promise.resolve({ data: [] as { medarbejder_id: string; aarsag: string | null }[] }),
  ]);

  const afsenderAf = new Map<string, string>();
  for (const r of (faellesLog ?? []) as { medarbejder_id: string; aarsag: string | null }[]) {
    const beskedId = faellesbeskedId(r.aarsag);
    if (beskedId) afsenderAf.set(beskedId, r.medarbejder_id);
  }

  const brugerIds = [...new Set([handel.buyer_id, handel.seller_id, ...afsenderAf.values()])];
  const { data: brugere } = await admin.from("users").select("id, navn").in("id", brugerIds);
  const navne = new Map(
    ((brugere ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]),
  );
  const koeberNavn = navne.get(handel.buyer_id) ?? "Uden navn";
  const saelgerNavn = navne.get(handel.seller_id) ?? "Uden navn";
  const titel = (auktion?.titel as string | undefined) ?? "(slettet auktion)";

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <Tilbage href={handelHref}>Tilbage til handlen</Tilbage>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
        <p className="text-xs font-medium uppercase text-neutral-500">Chat mellem køber og sælger</p>
        <h1 className="mt-1 break-words text-xl font-bold text-neutral-900">{titel}</h1>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-neutral-500">Køber</dt>
            <dd>
              <Link href={`/admin/brugere/${handel.buyer_id}`} className="font-medium text-neutral-800 hover:underline">
                {koeberNavn}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-neutral-500">Sælger</dt>
            <dd>
              <Link href={`/admin/brugere/${handel.seller_id}`} className="font-medium text-neutral-800 hover:underline">
                {saelgerNavn}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-neutral-500">Status</dt>
            <dd>
              <HandelStatusBadge status={handel.status as string} />
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-neutral-500">
          Kun læsning. Din læsning af chatten er registreret i medarbejder-loggen.
        </p>
      </div>

      <section aria-label="Beskeder" className="rounded-xl border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-neutral-900">
            {beskeder.length === 0
              ? "Beskeder"
              : `${beskeder.length.toLocaleString("da-DK")} ${beskeder.length === 1 ? "besked" : "beskeder"}`}
          </h2>
          <p className="text-xs text-neutral-500">
            <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-neutral-300 align-middle" aria-hidden="true" />
            Køber til venstre
            <span className="mx-1.5 text-neutral-300">·</span>
            <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-orange-knap align-middle" aria-hidden="true" />
            Sælger til højre
          </p>
        </div>

        <div className="space-y-3 px-4 py-4 sm:px-5">
          {beskeder.length === 0 && (
            <p className="py-6 text-center text-sm text-neutral-500">
              Køber og sælger har ikke skrevet sammen endnu.
            </p>
          )}

          {beskeder.map((b) => {
            if (b.fra_bidhamr) {
              // Kun messages.fra_bidhamr afgør markeringen – aldrig teksten.
              const medarbejderId = afsenderAf.get(b.id.toLowerCase());
              const afsender = medarbejderId ? navne.get(medarbejderId) ?? "Ukendt medarbejder" : "BidHamr";
              return (
                <div key={b.id} className="flex flex-col items-center gap-1.5">
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    <BidhamrMaerke lille />
                    <span className="text-xs font-semibold text-neutral-700">Besked fra BidHamr</span>
                  </div>
                  <div className="w-full max-w-[92%] rounded-2xl border border-[#B9D8CC] bg-groen-lys px-4 py-2.5 text-sm text-tekst sm:max-w-[80%]">
                    <p className="whitespace-pre-wrap break-words">
                      {fjernFaellesPraefiks(b.content, b.fra_bidhamr)}
                    </p>
                    <p className="mt-1 text-[12px] text-tekst-svag">
                      {tid(b.created_at)} · sendt af {afsender}
                    </p>
                  </div>
                </div>
              );
            }

            const erKoeber = b.sender_id === handel.buyer_id;
            const erSaelger = b.sender_id === handel.seller_id;
            const maerke = erKoeber ? "Køber" : erSaelger ? "Sælger" : "Ukendt afsender";
            const navn = erKoeber ? koeberNavn : erSaelger ? saelgerNavn : null;
            return (
              <div key={b.id} className={`flex flex-col ${erSaelger ? "items-end" : "items-start"}`}>
                <p className="mb-1 px-1 text-xs text-neutral-500">
                  <span className="font-semibold text-neutral-700">{maerke}</span>
                  {navn && <> · {navn}</>}
                </p>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm sm:max-w-[75%] ${
                    erSaelger
                      ? "rounded-tr-md bg-orange-knap text-white"
                      : erKoeber
                        ? "rounded-tl-md bg-neutral-100 text-neutral-800"
                        : "rounded-tl-md border border-dashed border-neutral-300 bg-white text-neutral-800"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{b.content}</p>
                  <p className={`mt-1 text-[11px] ${erSaelger ? "text-white/70" : "text-neutral-500"}`}>
                    {tid(b.created_at)}
                  </p>
                </div>
              </div>
            );
          })}

          {afkortet && (
            <p className="pt-2 text-center text-xs text-neutral-500">
              Kun de første {MAKS_BESKEDER.toLocaleString("da-DK")} beskeder vises.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
