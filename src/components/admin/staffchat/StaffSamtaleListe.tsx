import Link from "next/link";
import type { StaffSamtaleAdmin } from "@/app/actions/staffChat";
import { beskedTid, forkort } from "@/components/staffchat/visning";

// Liste over samtaler mellem BidHamr og brugere (admin). Bruges på
// /admin/chats og på brugersiden.
export default function StaffSamtaleListe({
  samtaler,
  tom,
  visBruger = true,
}: {
  samtaler: StaffSamtaleAdmin[];
  tom: string;
  visBruger?: boolean;
}) {
  if (samtaler.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-400">
        {tom}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      {samtaler.map((s) => {
        const sidst = s.sidste_besked;
        return (
          <li key={s.id}>
            <Link
              href={`/admin/chats/${s.id}`}
              className={`block px-4 py-4 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen sm:px-5 ${
                s.venter_paa_svar ? "bg-red-50/40" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {s.venter_paa_svar && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                    Venter på svar
                  </span>
                )}
                {s.lukket_kl ? (
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                    Afsluttet
                  </span>
                ) : (
                  !s.venter_paa_svar && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                      Åben
                    </span>
                  )
                )}
                <span className="min-w-0 break-words font-semibold text-neutral-900">{s.emne}</span>
              </div>
              <p className="mt-1 text-sm text-neutral-500">
                {visBruger && (
                  <>
                    <span className="font-medium text-neutral-700">{s.bruger.navn ?? "Uden navn"}</span>
                    {" · "}
                  </>
                )}
                Åbnet af {s.aabnet_af_navn ?? "ukendt"} {beskedTid(s.aabnet_kl)}
                {s.lukket_kl && ` · Afsluttet af ${s.lukket_af_navn ?? "ukendt"} ${beskedTid(s.lukket_kl)}`}
                {s.auktion_titel && ` · Handel: ${s.auktion_titel}`}
              </p>
              {sidst && (
                <p className="mt-1 break-words text-sm text-neutral-600">
                  <span className="font-medium">{sidst.fra_staff ? "BidHamr: " : "Bruger: "}</span>
                  {forkort(sidst.tekst, 140)}
                  <span className="ml-2 text-xs text-neutral-400">{beskedTid(sidst.oprettet_kl)}</span>
                </p>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
