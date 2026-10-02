import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentMinStaffSamtale } from "@/app/actions/staffChat";
import StaffChatBruger from "@/components/staffchat/StaffChatBruger";
import { AfsluttetMaerke, BidhamrMaerke, dato } from "@/components/staffchat/visning";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Besked fra BidHamr · BidHamr",
};

// Svaret fra hentMinStaffSamtale, når samtalen ikke findes eller er en andens.
const FINDES_IKKE = "Samtalen findes ikke.";

export default async function StaffSamtalePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=/beskeder/bidhamr/${encodeURIComponent(id)}`);

  // Henter kun brugerens egne samtaler (filtreret på bruger_id) og markerer læst.
  const svar = await hentMinStaffSamtale(id);
  if ("fejl" in svar) {
    if (svar.fejl === FINDES_IKKE) notFound();
    throw new Error("Samtalen kunne ikke hentes.");
  }
  const { samtale, beskeder } = svar;

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <Link href="/beskeder" className="text-sm font-medium text-groen hover:underline">
          ← Beskeder
        </Link>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <BidhamrMaerke />
          {samtale.lukket_kl && <AfsluttetMaerke />}
        </div>
        <h1 className="mt-3 break-words font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
          {samtale.emne}
        </h1>
        <p className="mt-1 text-[13px] text-tekst-svag">Startet {dato(samtale.aabnet_kl)}</p>
        {samtale.trade_id && (
          <Link
            href={`/mine-handler/${samtale.trade_id}`}
            className="mt-2 inline-block text-sm font-medium text-groen hover:underline"
          >
            Se handlen →
          </Link>
        )}

        <div className="mt-6">
          <StaffChatBruger
            samtaleId={samtale.id}
            startBeskeder={beskeder}
            lukket={!!samtale.lukket_kl}
          />
        </div>
      </div>
    </main>
  );
}
