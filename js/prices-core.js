// أدوات مشتركة لقائمة الأسعار (بتستخدمها لوحة الأدمن وجسر الأدوات)
// التخزين: نص "اسم المنتج<TAB>السعر" سطر لكل منتج، مضغوط gzip ومتحوّل base64 ومتقسّم لقطع لو كبير.

export const CHUNK_CHARS = 850000;   // أقل بكتير من حد Firestore (1MB للمستند)

// نفس تطبيع الاسم اللي كان بيستخدمه كود Apps Script (normalizeExact)
export function normKey(text) {
  return String(text || "").toLowerCase().replace(/\u00A0/g, " ").replace(/[–—]/g, "-")
    .replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim();
}

function fmtPrice(p) { return String(Math.round(p * 1e6) / 1e6); }

// rows: [[name, price], ...] بالترتيب الأصلي. أول ظهور للاسم هو اللي بيتحسب (زي الشيت بالظبط).
export function buildEntries(rows) {
  const seen = new Set(); const out = []; let invalid = 0, dup = 0;
  for (const r of rows) {
    const name = String(r[0] ?? "").trim();
    const price = typeof r[1] === "number" ? r[1] : parseFloat(String(r[1] ?? "").replace(/,/g, ""));
    if (!name || !isFinite(price)) { if (name) invalid++; continue; }
    const k = normKey(name);
    if (seen.has(k)) { dup++; continue; }
    seen.add(k); out.push([name, price]);
  }
  return { entries: out, invalid, dup };
}

export const entriesToText = entries => entries.map(([n, p]) => n.replace(/[\t\r\n]+/g, " ") + "\t" + fmtPrice(p)).join("\n");

// text -> Map(key -> {name, price}); سطر السعر "-" معناه "امسح السعر ده" (بيستخدم في التعديلات اليدوية)
export function textToMap(text, into = new Map()) {
  if (!text) return into;
  for (const line of text.split("\n")) {
    const i = line.lastIndexOf("\t");
    if (i < 1) continue;
    const name = line.slice(0, i), raw = line.slice(i + 1).trim();
    const k = normKey(name);
    if (raw === "-") { into.delete(k); continue; }
    const p = parseFloat(raw);
    if (isFinite(p)) into.set(k, { name, price: p });
  }
  return into;
}

/* ---------- gzip + base64 (الدوال native في المتصفح) ---------- */
function bytesToBase64(bytes) {
  let s = ""; const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}
function base64ToBytes(b64) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function pipe(bytes, stream) {
  const w = stream.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
export async function packText(text) {
  const gz = await pipe(new TextEncoder().encode(text), new CompressionStream("gzip"));
  const b64 = bytesToBase64(gz);
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
  return chunks.length ? chunks : [""];
}
export async function unpackText(chunks) {
  const bytes = await pipe(base64ToBytes(chunks.join("")), new DecompressionStream("gzip"));
  return new TextDecoder().decode(bytes);
}

/* ---------- CSV (بيتعامل مع علامات التنصيص والفواصل جوه الأسماء) ---------- */
export function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
