import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentMitTilbud } from "@/app/actions/andenchance";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import SvarKnapper from "@/components/andenchance/SvarKnapper";
import { dato, kroner } from "@/components/andenchance/format";

export const dynamic = "force-dynamic";

function Besked({ titel, tekst, children }: { titel: string; tekst: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-kant bg-white p-6">
      <h2 className="font-serif text-xl font-semibold text-tekst">{titel}</h2>
      <p className="mt-1 text-sm text-tekst-daempet">{tekst}</p>
      {children}
    </div>
  );
}

export const metadata: Metadata = { title: "Tilbud om at købe varen", robots: { index: false, follow: false } };

export default async function AndenchancePage({ params }: { params: Promise<{ tilbudId: string }> }) {
  const { tilbudId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=/andenchance/${tilbudId}`);

  const svar = await hentMitTilbud(tilbudId);

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-xl space-y-6">
        <Link
          href="/mine-handler"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Mine handler
        </Link>

        {"fejl" in svar ? (
          <Besked
            titel={svar.fejl === "Tilbuddet findes ikke." ? "Tilbuddet findes ikke" : "Noget gik galt"}
            tekst={
              svar.fejl === "Tilbuddet findes ikke."
                ? "Linket er forkert, eller tilbuddet er ikke til dig."
                : svar.fejl
            }
          />
        ) : (
          <TilbudVisning t={svar.tilbud} />
        )}
      </div>
    </main>
  );
}

function TilbudVisning({ t }: { t: Extract<Awaited<ReturnType<typeof hentMitTilbud>>, { ok: true }>["tilbud"] }) {
  const vare = (
    <div className="flex items-center gap-4">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-skelet">
        {t.billede ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.billede} alt="" width={80} height={80} className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-tekst-svag">Andet tilbud</p>
        <h1 className="font-serif text-xl font-semibold text-tekst">{t.titel || "Vare"}</h1>
      </div>
    </div>
  );

  if (t.status === "accepteret") {
    return (
      <div className="space-y-6">
        {vare}
        <Besked titel="Du har sagt ja" tekst="Betal inden for 48 timer for at få varen.">
          {t.nyTradeId && (
            <Link href={`/mine-handler/${t.nyTradeId}`} className="btn btn-primaer mt-4 w-full sm:w-auto">
              Gå til betaling
            </Link>
          )}
        </Besked>
      </div>
    );
  }
  if (t.status === "afvist") {
    return (
      <div className="space-y-6">
        {vare}
        <Besked
          titel="Du har sagt nej tak"
          tekst={t.besvaretKl ? `Du svarede ${dato(t.besvaretKl)}.` : "Tilbuddet er besvaret."}
        />
      </div>
    );
  }
  if (t.status === "udloebet") {
    return (
      <div className="space-y-6">
        {vare}
        <Besked titel="Tilbuddet er udløbet" tekst="Fristen på 24 timer er gået, og tilbuddet gælder ikke længere." />
      </div>
    );
  }
  if (t.status === "annulleret") {
    return (
      <div className="space-y-6">
        {vare}
        {t.annulleretAarsag === "genopsat" ? (
          <Besked
            titel="Tilbuddet gælder ikke længere"
            tekst="Sælgeren har sat varen op på auktion igen. Du kan byde på den nye auktion."
          />
        ) : t.annulleretAarsag === "solgt" ? (
          <Besked titel="Varen er solgt" tekst="Varen er solgt til en anden byder, og tilbuddet gælder ikke længere." />
        ) : (
          <Besked titel="Tilbuddet gælder ikke længere" tekst="Sælgeren har trukket tilbuddet tilbage." />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {vare}

      <div className="rounded-2xl border border-[#F5D9B0] bg-[#FEF3E2] p-4 text-sm text-[#8A4210]">
        <p className="font-semibold">Vinderen betalte ikke. Du kan købe varen for dit eget bud.</p>
        <p className="mt-1">
          Svar senest {dato(t.udloeber)} ·{" "}
          <span className="font-semibold">
            <Nedtaelling til={t.udloeber} />
          </span>
        </p>
      </div>

      <section className="rounded-2xl border border-kant bg-white p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-tekst">Det skal du betale</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Linje label="Dit bud" vaerdi={kroner(t.budOere)} />
          <Linje label="Købergebyr" vaerdi={kroner(t.koebergebyrOere)} />
          <Linje label="Fragt" vaerdi={t.fragtOere > 0 ? kroner(t.fragtOere) : "Afhentning"} />
          {t.beskyttelse && <Linje label="BidHamr Beskyttelse" vaerdi={kroner(t.beskyttelseOere)} />}
          <div className="flex justify-between border-t border-kant pt-3 text-base font-semibold text-tekst">
            <dt>I alt</dt>
            <dd className="tabular-nums">{kroner(t.totalOere)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-tekst-svag">Siger du ja, har du 48 timer til at betale.</p>

        <SvarKnapper tilbudId={t.id} total={kroner(t.totalOere)} />
      </section>
    </div>
  );
}

function Linje({ label, vaerdi }: { label: string; vaerdi: string }) {
  return (
    <div className="flex justify-between text-tekst-daempet">
      <dt>{label}</dt>
      <dd className="tabular-nums text-tekst">{vaerdi}</dd>
    </div>
  );
}
