import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Hertil sendes man, når e-mailen er bekræftet (auth/callback).
export const metadata: Metadata = { title: "Velkommen", robots: { index: false, follow: false } };

export default async function VelkommenSide() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-succes-bg">
          <svg viewBox="0 0 24 24" className="h-7 w-7 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-4 text-[26px] leading-tight sm:text-[32px]">Velkommen til BidHamr</h1>
        <p className="mt-2 text-[15px] text-tekst-daempet">
          Din e-mail er bekræftet, og du er logget ind. Nu kan du byde på auktioner og følge med i dine handler.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/auktioner" className="btn btn-primaer btn-stor w-full sm:w-auto">
            Find auktioner
          </Link>
          <Link href="/konto" className="btn btn-sekundaer btn-stor w-full sm:w-auto">
            Gå til Min konto
          </Link>
        </div>
      </div>
    </main>
  );
}
