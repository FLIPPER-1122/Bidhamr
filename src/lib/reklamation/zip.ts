// Lille ZIP-skriver uden komprimering ("stored"). Billeder er allerede
// komprimerede (JPEG/PNG/WebP), så komprimering ville kun koste CPU. Ingen
// afhængigheder; filnavne gemmes som UTF-8 (flag bit 11).
// Grænser: højst 65.535 filer og 4 GB i alt (ingen ZIP64) - en reklamation
// har højst ca. 25 billeder.

export type ZipFil = { navn: string; data: Uint8Array; tid?: Date };

const CRC_TABEL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABEL[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTid(d: Date): { tid: number; dato: number } {
  const aar = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    tid: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    dato: ((aar - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Fjerner stier og tegn, der ikke hører hjemme i et filnavn i en ZIP
// (ingen "../", ingen absolutte stier).
export function sikkertZipNavn(navn: string): string {
  const ren = navn
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150);
  return ren || "fil";
}

export function lavZip(filer: ZipFil[]): Uint8Array {
  if (filer.length > 0xffff) throw new Error("For mange filer til ZIP");
  const enc = new TextEncoder();
  const lokale: Uint8Array[] = [];
  const centrale: Uint8Array[] = [];
  let offset = 0;
  const brugte = new Set<string>();

  for (const f of filer) {
    // Unikke navne: "billede.jpg", "billede (2).jpg", ...
    let navn = sikkertZipNavn(f.navn);
    if (brugte.has(navn)) {
      const punkt = navn.lastIndexOf(".");
      const [stamme, endelse] = punkt > 0 ? [navn.slice(0, punkt), navn.slice(punkt)] : [navn, ""];
      let i = 2;
      while (brugte.has(`${stamme} (${i})${endelse}`)) i++;
      navn = `${stamme} (${i})${endelse}`;
    }
    brugte.add(navn);

    const navnB = enc.encode(navn);
    const crc = crc32(f.data);
    const str = f.data.length;
    if (offset + 30 + navnB.length + str > 0xffffffff) throw new Error("ZIP-filen bliver for stor");
    const { tid, dato } = dosTid(f.tid ?? new Date());

    const lok = new Uint8Array(30 + navnB.length);
    const lv = new DataView(lok.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, tid, true);
    lv.setUint16(12, dato, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, str, true);
    lv.setUint32(22, str, true);
    lv.setUint16(26, navnB.length, true);
    lv.setUint16(28, 0, true);
    lok.set(navnB, 30);

    const cen = new Uint8Array(46 + navnB.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, tid, true);
    cv.setUint16(14, dato, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, str, true);
    cv.setUint32(24, str, true);
    cv.setUint16(28, navnB.length, true);
    cv.setUint32(42, offset, true);
    cen.set(navnB, 46);

    lokale.push(lok, f.data);
    centrale.push(cen);
    offset += lok.length + str;
  }

  const cenStr = centrale.reduce((s, c) => s + c.length, 0);
  const slut = new Uint8Array(22);
  const sv = new DataView(slut.buffer);
  sv.setUint32(0, 0x06054b50, true);
  sv.setUint16(8, filer.length, true);
  sv.setUint16(10, filer.length, true);
  sv.setUint32(12, cenStr, true);
  sv.setUint32(16, offset, true);

  const ud = new Uint8Array(offset + cenStr + slut.length);
  let p = 0;
  for (const b of [...lokale, ...centrale, slut]) {
    ud.set(b, p);
    p += b.length;
  }
  return ud;
}
