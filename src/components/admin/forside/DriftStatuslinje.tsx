import Link from "next/link";
import type { Status } from "@/lib/admin/statuslinje";

// Den brede linje øverst på forsiden: farve + ikon + kort tekst + link til
// det, der er galt. Ikonet er altid med, så farven aldrig er eneste signal.
const STIL: Record<Status["tone"], { flade: string; ikon: string; tegn: string }> = {
  groen: { flade: "border-succes-kant bg-succes-bg text-succes-tekst", ikon: "bg-status-groen", tegn: "✓" },
  gul: { flade: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst", ikon: "bg-status-gul", tegn: "!" },
  roed: { flade: "border-fejl-kant bg-fejl-bg text-fejl-tekst", ikon: "bg-status-roed", tegn: "✕" },
};

export default function DriftStatuslinje({ status }: { status: Status }) {
  const s = STIL[status.tone];
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-[14px] border px-[18px] py-4 ${s.flade}`}>
      <span aria-hidden="true" className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-bold text-white ${s.ikon}`}>
        {s.tegn}
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%-50px)] sm:basis-0">
        <b className="block text-[17px] font-bold">{status.titel}</b>
        <span className="text-[13.5px] opacity-90">{status.tekst}</span>
      </div>
      {status.href && status.knap && (
        <Link
          href={status.href}
          className="ml-[50px] inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-current px-3 font-semibold hover:bg-white/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:ml-auto"
        >
          {status.knap}
        </Link>
      )}
    </div>
  );
}
