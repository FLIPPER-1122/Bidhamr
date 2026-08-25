import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Footer() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  let erAdmin = false;
  if (authData.user) {
    const { data } = await supabase
      .from("users")
      .select("rolle")
      .eq("id", authData.user.id)
      .single();
    erAdmin =
      data?.rolle === "chef" ||
      data?.rolle === "admin" ||
      data?.rolle === "medarbejder";
  }

  return (
    <footer className="border-t border-neutral-200 bg-[#F3F4F6] px-4 py-6 text-sm text-[#6B7280] sm:px-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-bold text-brand">BidHamr</span>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <span>+45 70 12 34 56</span>
          <span>support@bidhamr.dk</span>
          {erAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-1.5 font-medium text-brand hover:underline"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Admin
            </Link>
          )}
        </div>
      </div>
    </footer>
  );
}
