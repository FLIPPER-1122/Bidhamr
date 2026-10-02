import Link from "next/link";
import { notFound } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { hentStaffSamtale } from "@/app/actions/staffChat";
import StaffChatAdmin from "@/components/admin/staffchat/StaffChatAdmin";
import { beskedTid } from "@/components/staffchat/visning";

export default async function AdminChat({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fandtes?: string }>;
}) {
  await assertRole("medarbejder");
  const { id } = await params;
  const { fandtes } = await searchParams;

  const res = await hentStaffSamtale(id);
  if ("fejl" in res) {
    if (res.fejl === "Samtalen findes ikke.") notFound();
    throw new Error(res.fejl);
  }
  const { samtale, beskeder } = res;
  const brugerNavn = samtale.bruger.navn ?? "Uden navn";

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <Link
        href="/admin/chats"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Alle chats
      </Link>

      {fandtes === "1" && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Der var allerede en åben chat med brugeren, så du er sendt til den. Har du skrevet en besked, er den lagt i denne chat.
        </p>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
        <h1 className="break-words text-xl font-bold text-neutral-900">{samtale.emne}</h1>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-neutral-500">Bruger</dt>
            <dd>
              <Link href={`/admin/brugere/${samtale.bruger.id}`} className="font-medium text-neutral-800 hover:underline">
                {brugerNavn}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-neutral-500">Åbnet</dt>
            <dd className="text-neutral-700">
              {beskedTid(samtale.aabnet_kl)} af {samtale.aabnet_af_navn ?? "ukendt"}
            </dd>
          </div>
          {samtale.lukket_kl && (
            <div>
              <dt className="text-xs uppercase text-neutral-500">Afsluttet</dt>
              <dd className="text-neutral-700">
                {beskedTid(samtale.lukket_kl)} af {samtale.lukket_af_navn ?? "ukendt"}
              </dd>
            </div>
          )}
          {samtale.trade_id && (
            <div>
              <dt className="text-xs uppercase text-neutral-500">Handel</dt>
              <dd className="break-words text-neutral-700">
                {samtale.auktion_titel ?? "(slettet auktion)"}{" "}
                <span className="font-mono text-xs text-neutral-400">{samtale.trade_id.slice(0, 8)}</span>
              </dd>
            </div>
          )}
        </dl>
      </div>

      <StaffChatAdmin
        samtaleId={samtale.id}
        brugerNavn={brugerNavn}
        beskeder={beskeder}
        lukket={samtale.lukket_kl !== null}
      />
    </div>
  );
}
