import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { paaAdminVaert } from "@/lib/supabase/server";

// Login og to-trins-login til admin (kun admin-hosten, ADMIN_VAERT -
// docs/ADMIN-VAERT.md). Uden admin-layoutet: ingen menu, før man er inde.
export const metadata: Metadata = {
  title: "Log ind i admin",
  robots: { index: false, follow: false },
};

export default async function AdgangLayout({ children }: { children: React.ReactNode }) {
  // Proxyen giver 404 på /adgang uden for admin-hosten - dette er et ekstra værn.
  if (!(await paaAdminVaert())) notFound();
  return (
    <main className="flex flex-1 items-start justify-center bg-admin-bg px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <Image src="/brand/bidhamr-logo.svg" alt="BidHamr" width={160} height={42} unoptimized className="h-8 w-auto" />
          <span className="rounded-full bg-groen-lys px-2.5 py-1 text-xs font-semibold text-groen-mork">Admin</span>
        </div>
        {children}
      </div>
    </main>
  );
}
