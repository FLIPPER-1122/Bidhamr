import Link from "next/link";
import { assertRole } from "@/lib/adminAuth";
import {
  hentAabneStaffSamtaler,
  hentLukkedeStaffSamtaler,
} from "@/app/actions/staffChat";
import StaffSamtaleListe from "@/components/admin/staffchat/StaffSamtaleListe";

// Samtaler mellem BidHamr og brugere. Åbne øverst (dem, der venter på svar,
// først), derefter afsluttede med "Vis flere".

const SIDE = 20;

export default async function AdminChats({
  searchParams,
}: {
  searchParams: Promise<{ lukkede?: string }>;
}) {
  await assertRole("medarbejder");
  const { lukkede } = await searchParams;
  const antalLukkede = Math.min(Math.max(Number(lukkede) || SIDE, SIDE), 200);

  const [aabne, lukket] = await Promise.all([
    hentAabneStaffSamtaler(),
    hentLukkedeStaffSamtaler(antalLukkede),
  ]);
  if ("fejl" in aabne) throw new Error(aabne.fejl);
  if ("fejl" in lukket) throw new Error(lukket.fejl);

  const venter = aabne.samtaler.filter((s) => s.venter_paa_svar).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Chats</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Samtaler mellem BidHamr og brugere. Åbn en ny chat fra brugerens side.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-800">
          Åbne ({aabne.samtaler.length})
          {venter > 0 && <span className="ml-2 font-normal text-red-700">{venter} venter på svar</span>}
        </h2>
        <StaffSamtaleListe samtaler={aabne.samtaler} tom="Ingen åbne chats" />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-800">Afsluttede</h2>
        <StaffSamtaleListe samtaler={lukket.samtaler} tom="Ingen afsluttede chats" />
        {lukket.flere && (
          <div className="text-center">
            <Link
              href={`/admin/chats?lukkede=${antalLukkede + SIDE}`}
              scroll={false}
              className="inline-flex min-h-11 items-center rounded-lg border border-neutral-200 bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              Vis flere
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
