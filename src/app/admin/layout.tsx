import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AdminSidebar from "@/components/admin/AdminSidebar";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: profile } = await supabase
    .from("users")
    .select("rolle")
    .eq("id", user.id)
    .single();

  if (!profile || profile.rolle !== "admin") {
    redirect("/");
  }

  return (
    <div className="flex h-screen bg-neutral-50">
      <AdminSidebar />
      <main className="flex-1 overflow-auto bg-neutral-50 lg:ml-0 pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
