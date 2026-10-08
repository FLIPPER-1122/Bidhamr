import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OpretAuktionIndhold from "@/components/opret/OpretAuktionIndhold";

// Opret auktion for private. Firmakonti opretter i firma-dashboardet
// (/firma/auktioner/ny) - gaten sender dem dertil (src/lib/supabase/middleware.ts).
// Tjek og formular: src/components/opret/OpretAuktionIndhold.tsx.
export const metadata: Metadata = { title: "Opret auktion", robots: { index: false, follow: false } };

export default async function OpretAuktionPage({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const { stripe } = await searchParams;

  return (
    <main className="flex flex-1 justify-center px-4 py-8 sm:px-6 lg:py-10">
      <div className="w-full max-w-2xl">
        <h1 className="font-serif text-[26px] font-semibold text-tekst sm:text-[32px]">
          Opret auktion
        </h1>

        <div className="mt-6">
          <OpretAuktionIndhold brugerId={data.user.id} stripe={stripe} />
        </div>
      </div>
    </main>
  );
}
