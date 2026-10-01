import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AdminSidebar from "@/components/admin/AdminSidebar";
import { hentAntalUbetalte } from "@/app/actions/adminActions";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: rolle } = await supabase.rpc("min_rolle");

  if (rolle !== "chef" && rolle !== "admin" && rolle !== "medarbejder") {
    redirect("/");
  }

  // Tallet til menuens badge. En fejl her må ikke vælte hele admin-panelet.
  const ubetalte = await hentAntalUbetalte();
  const antalUbetalte = "antal" in ubetalte ? ubetalte.antal : 0;

  return (
    <div className="flex h-screen bg-neutral-50">
      <AdminSidebar rolle={rolle} taellere={{ ubetalte: antalUbetalte }} />
      <main className="flex-1 overflow-auto bg-neutral-50 lg:ml-0 pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
