// IP-adressen som nøgle til lofter og hash (ren funktion - ingen
// server-afhængigheder, så enhedstestene kan bruge den).
//
// En IPv6-bruger får typisk et helt /64-net (2^64 adresser) og kan skifte
// adresse inden for det frit. Derfor tælles IPv6 pr. /64: de første fire
// grupper + "::/64". IPv4 er uændret. En IPv4-adresse skrevet som IPv6
// (::ffff:1.2.3.4) bliver til IPv4-adressen. Alt andet (fx "ukendt")
// returneres trimmet og med små bogstaver.

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function udvidIpv6(ip: string): number[] | null {
  let s = ip;
  // IPv4 til sidst (::ffff:1.2.3.4 og ::1.2.3.4) -> to grupper.
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!IPV4.test(v4[2])) return null;
    const [a, b, c, d] = v4[2].split(".").map(Number);
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const dele = s.split("::");
  if (dele.length > 2) return null;
  const venstre = dele[0] ? dele[0].split(":") : [];
  const hoejre = dele.length === 2 && dele[1] ? dele[1].split(":") : [];
  const mangler = 8 - venstre.length - hoejre.length;
  if (dele.length === 2 ? mangler < 1 : mangler !== 0) return null;
  const grupper = [...venstre, ...Array(dele.length === 2 ? mangler : 0).fill("0"), ...hoejre];
  if (grupper.length !== 8) return null;
  const tal: number[] = [];
  for (const g of grupper) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    tal.push(parseInt(g, 16));
  }
  return tal;
}

export function ipNoegle(ip: string): string {
  let s = (ip ?? "").trim().toLowerCase();
  // [2001:db8::1] og zone-id (fe80::1%eth0).
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  s = s.replace(/%.*$/, "");
  if (IPV4.test(s)) return s;
  if (!s.includes(":")) return s;
  const g = udvidIpv6(s);
  if (!g) return s;
  // IPv4-mapped (::ffff:a.b.c.d): IPv4-adressen.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
