// Minimal ZIP-fil uden komprimering ("stored"), til at samle PDF'er (som
// allerede er komprimerede). Ingen afhængigheder. Filnavne i UTF-8 (bit 11).
// Højst 65.535 filer og 4 GB i alt (ingen ZIP64) - rigeligt til en periodes
// fakturaer.

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
  return {
    tid: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    dato: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export type ZipFil = { navn: string; data: Uint8Array };

export function lavZip(filer: ZipFil[], nu: Date = new Date()): Uint8Array {
  if (filer.length > 0xffff) throw new Error("For mange filer til én ZIP-fil.");
  const enc = new TextEncoder();
  const { tid, dato } = dosTid(nu);
  const lokale: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const brugt = new Set<string>();

  for (const f of filer) {
    // Unikke, sikre navne (ingen mapper eller "..").
    let navn = f.navn.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_") || "fil";
    if (brugt.has(navn)) {
      const p = navn.lastIndexOf(".");
      let i = 2;
      while (brugt.has(`${p > 0 ? navn.slice(0, p) : navn}-${i}${p > 0 ? navn.slice(p) : ""}`)) i++;
      navn = `${p > 0 ? navn.slice(0, p) : navn}-${i}${p > 0 ? navn.slice(p) : ""}`;
    }
    brugt.add(navn);
    const navnB = enc.encode(navn);
    const crc = crc32(f.data);
    const str = f.data.length;

    const lh = new Uint8Array(30 + navnB.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, tid, true);
    lv.setUint16(12, dato, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, str, true);
    lv.setUint32(22, str, true);
    lv.setUint16(26, navnB.length, true);
    lv.setUint16(28, 0, true);
    lh.set(navnB, 30);
    lokale.push(lh, f.data);

    const ch = new Uint8Array(46 + navnB.length);
    const cv = new DataView(ch.buffer);
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
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(navnB, 46);
    central.push(ch);

    offset += lh.length + str;
  }

  const centralStr = central.reduce((s, c) => s + c.length, 0);
  const slut = new Uint8Array(22);
  const sv = new DataView(slut.buffer);
  sv.setUint32(0, 0x06054b50, true);
  sv.setUint16(8, filer.length, true);
  sv.setUint16(10, filer.length, true);
  sv.setUint32(12, centralStr, true);
  sv.setUint32(16, offset, true);

  const ialt = offset + centralStr + slut.length;
  const ud = new Uint8Array(ialt);
  let p = 0;
  for (const del of [...lokale, ...central, slut]) {
    ud.set(del, p);
    p += del.length;
  }
  return ud;
}
