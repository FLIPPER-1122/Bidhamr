import Header from "@/components/Header";
import Footer from "@/components/Footer";
import FavoritterProvider from "@/components/FavoritterProvider";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <FavoritterProvider>
      <Header />
      {children}
      <Footer />
    </FavoritterProvider>
  );
}
