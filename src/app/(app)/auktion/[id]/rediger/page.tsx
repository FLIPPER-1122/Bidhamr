import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RedigerAuktionIndhold from "@/components/opret/RedigerAuktionIndhold";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Redigér auktion",
  robots: { index: false, follow: false },
};

// Tjek og formular: src/components/opret/RedigerAuktionIndhold.tsx (deles med
// firma-dashboardet, /firma/auktioner/[id]/rediger - gaten sender firmaer dertil).
export default async function RedigerAuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login");

  return (
    <main className="flex flex-1 justify-center px-4 py-8 sm:px-6 lg:py-10">
      <div className="w-full max-w-2xl">
        <Link href={`/auktion/${id}`} className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
          ← Tilbage til auktionen
        </Link>
        <h1 className="mt-1 text-[26px] leading-tight sm:text-[32px]">Redigér auktion</h1>

        <div className="mt-6">
          <RedigerAuktionIndhold auktionId={id} brugerId={authData.user.id} />
        </div>
      </div>
    </main>
  );
}
