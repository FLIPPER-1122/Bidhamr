import type { Metadata } from "next";
import Link from "next/link";
import { sikkerSti } from "@/lib/sikkerSti";
import { erLinkType } from "@/lib/authLink";

// Mellemside for engangslinks i mails (velkomst til firmakonti, nulstil
// adgangskode). Mail-scannere (fx Microsoft Safe Links) åbner links i mails,
// før modtageren gør - derfor indløser denne side INTET ved visning. Først
// knappen (POST til /auth/callback) bruger linket. Se
// src/app/auth/callback/route.ts.
//
// Siden må ikke have server actions: den er offentlig (kun GET/HEAD, se
// OFFENTLIGE_LAESESIDER i src/lib/supabase/middleware.ts), og formularen
// poster til route handleren.
export const metadata: Metadata = {
  title: "Fortsæt",
  robots: { index: false, follow: false },
  // Tokenet står i adressen - send det aldrig videre til fremmede sider.
  // ("no-referrer" ville give Origin: null på knappens POST.)
  referrer: "same-origin",
};

type Params = { token_hash?: string | string[]; type?: string | string[]; next?: string | string[] };

function en(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 2000 ? v : null;
}

export default async function BekraeftSide({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const tokenHash = en(sp.token_hash);
  const type = en(sp.type);
  const naeste = sikkerSti(en(sp.next), type === "recovery" ? "/reset-password" : "/auktioner");
  const gyldig = !!tokenHash && erLinkType(type);
  const adgangskode = type === "recovery" || type === "invite" || naeste.startsWith("/reset-password");

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
        {gyldig ? (
          <>
            <h1 className="text-[26px] leading-tight sm:text-[32px]">
              {adgangskode ? "Vælg din adgangskode" : "Fortsæt til BidHamr"}
            </h1>
            <p className="mt-3 text-[17px] text-tekst-daempet">Tryk på knappen for at fortsætte.</p>
            <form method="post" action="/auth/callback" className="mt-6">
              <input type="hidden" name="token_hash" value={tokenHash} />
              <input type="hidden" name="type" value={type} />
              <input type="hidden" name="next" value={naeste} />
              <button type="submit" className="btn btn-primaer btn-stor w-full">
                {adgangskode ? "Vælg din adgangskode" : "Fortsæt"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-[26px] leading-tight sm:text-[32px]">Linket virker ikke</h1>
            <p className="mt-3 text-[17px] text-tekst-daempet">
              Linket er ikke helt. Prøv at trykke på linket i mailen igen, eller log ind.
            </p>
            <Link href="/login" className="btn btn-primaer btn-stor mt-6 w-full">
              Log ind
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
