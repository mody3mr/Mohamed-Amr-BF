import {
  collection, doc, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normKey, buildEntries, entriesToText, textToMap, packText, unpackText, parseCSV } from "./prices-core.js";

const SHEETJS = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let sheetJsPromise = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return sheetJsPromise || (sheetJsPromise = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = SHEETJS; s.onload = res;
    s.onerror = () => { sheetJsPromise = null; rej(new Error("تعذر تحميل مكتبة قراءة الإكسيل. جرّب CSV أو اتأكد من الإنترنت.")); };
    document.head.appendChild(s);
  }));
}

// ov: سطور "اسم<TAB>سعر" (أو "-" لمسح السعر)
function parseOv(text) {
  const m = new Map();
  for (const line of String(text || "").split("\n")) {
    const i = line.lastIndexOf("\t"); if (i < 1) continue;
    const name = line.slice(0, i), raw = line.slice(i + 1).trim();
    const p = raw === "-" ? null : parseFloat(raw);
    if (p === null || isFinite(p)) m.set(normKey(name), { name, price: p });
  }
  return m;
}
const ovToText = m => [...m.values()].map(e => e.name.replace(/[\t\r\n]+/g, " ") + "\t" + (e.price === null ? "-" : String(e.price))).join("\n");

export function mount({ db, me, root, esc, toast, arErr, modal }) {
  root.innerHTML = `
  <div class="panel">
    <div class="panel-head">
      <div><h2>أسعار المنتجات</h2><div class="sub" style="margin:0">القائمة اللي بتستخدمها أداة حساب الأسعار</div></div>
      <div class="sp"></div><span class="badge" id="pcState">جاري التحميل...</span>
    </div>
    <div class="settings">
      <div class="set-row">
        <div><b>رفع قائمة أسعار كاملة</b>
          <div class="sub">ملف CSV أو Excel: العمود الأول اسم المنتج والتاني السعر (الصف الأول عناوين). لو الاسم اتكرر بياخد <b>أول سعر من فوق</b> زي الشيت بالظبط. الأسرع: في جوجل شيت افتح تاب "price list" لوحده وانزّله CSV.</div></div>
        <button class="btn" id="pcImport" style="white-space:nowrap"><i class="fa-solid fa-file-arrow-up"></i> رفع ملف</button>
        <input type="file" id="pcFile" accept=".csv,.xlsx,.xls" class="hidden">
      </div>
      <div class="field" style="margin-top:16px"><label for="pcSearch">ابحث عن منتج وعدّل سعره</label>
        <input id="pcSearch" placeholder="اكتب جزء من اسم المنتج (حرفين على الأقل)"></div>
      <div id="pcResults"></div>
      <div class="set-row" style="margin-top:8px">
        <div style="flex:1"><b>إضافة منتج جديد / سعر جديد</b>
          <div class="row" style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <input id="pcNewName" placeholder="اسم المنتج بالظبط زي ما هو في الأودو" style="flex:2;min-width:220px;padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:transparent">
            <input id="pcNewPrice" type="number" step="0.01" min="0" placeholder="السعر" dir="ltr" style="flex:1;min-width:100px;padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:transparent">
            <button class="btn" id="pcAdd"><i class="fa-solid fa-plus"></i> حفظ</button>
          </div></div>
      </div>
      <div style="margin-top:18px"><b>التعديلات اليدوية</b> <span class="sub" id="pcOvCount" style="display:inline"></span>
        <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>المنتج</th><th>السعر</th><th>إجراء</th></tr></thead><tbody id="pcOvBody"></tbody></table></div></div>
    </div>
  </div>`;
  const $ = id => root.querySelector("#" + id);

  let base = new Map();          // key -> {name, price}
  let meta = null, ov = new Map(), ovV = "";
  let loadedKey = null;

  const effective = () => { const m = new Map(base); ov.forEach((e, k) => { if (e.price === null) m.delete(k); else m.set(k, { name: e.name, price: e.price }); }); return m; };
  const fmt = n => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

  function renderState() {
    const st = $("pcState");
    if (!meta) { st.className = "badge off"; st.textContent = "لسه مفيش قائمة أسعار — ارفع ملف"; return; }
    st.className = "badge ok";
    st.textContent = `${fmt(meta.count)} منتج • آخر تحديث ${meta.updatedAtMs ? new Date(meta.updatedAtMs).toLocaleString("ar-EG") : ""}${meta.source ? " • " + meta.source : ""}`;
  }
  function renderOv() {
    $("pcOvCount").textContent = ov.size ? `(${ov.size})` : "";
    $("pcOvBody").innerHTML = ov.size
      ? [...ov.entries()].map(([k, e]) => `<tr><td>${esc(e.name)}</td><td>${e.price === null ? "محذوف" : fmt(e.price)}</td><td><button class="btn ghost sm" data-del="${esc(k)}"><i class="fa-solid fa-rotate-left"></i> رجّع الأصلي</button></td></tr>`).join("")
      : '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:18px">مفيش تعديلات يدوية.</td></tr>';
  }
  function renderResults() {
    const q = normKey($("pcSearch").value);
    const box = $("pcResults");
    if (q.length < 2) { box.innerHTML = ""; return; }
    const eff = effective(); const out = [];
    for (const [k, e] of eff) { if (k.includes(q)) { out.push([k, e]); if (out.length >= 25) break; } }
    box.innerHTML = out.length
      ? `<div class="table-wrap"><table><thead><tr><th>المنتج</th><th>السعر</th><th></th></tr></thead><tbody>${out.map(([k, e]) =>
          `<tr><td>${esc(e.name)}${ov.has(k) ? ' <span class="badge wait">معدّل يدويًا</span>' : ""}</td>
           <td><input type="number" step="0.01" min="0" dir="ltr" value="${e.price}" data-price="${esc(k)}" style="width:110px;padding:6px 8px;border:2px solid var(--line);border-radius:10px;background:transparent"></td>
           <td><button class="btn sm" data-save="${esc(k)}" data-name="${esc(e.name)}"><i class="fa-solid fa-floppy-disk"></i> حفظ</button></td></tr>`).join("")}</tbody></table></div>`
      : '<div class="sub">مفيش منتج بالاسم ده. تقدر تضيفه من تحت.</div>';
  }

  async function writeOv(map) {
    const b = writeBatch(db);
    b.set(doc(db, "prices", "ov"), { text: ovToText(map), v: Date.now().toString(36), updatedAt: serverTimestamp() });
    await b.commit();
  }

  // ---- تحميل القائمة (لحظي) ----
  const unsub = onSnapshot(collection(db, "prices"), async snap => {
    const docs = {}; snap.docs.forEach(d => { docs[d.id] = d.data(); });
    meta = docs.meta || null;
    ov = parseOv(docs.ov && docs.ov.text); ovV = (docs.ov && docs.ov.v) || "";
    renderState(); renderOv();
    if (meta) {
      const key = meta.version;
      if (key !== loadedKey) {
        const chunks = []; for (let i = 0; i < meta.chunks; i++) { if (!docs["b" + i]) return; chunks.push(docs["b" + i].data); }
        try { base = textToMap(await unpackText(chunks)); loadedKey = key; } catch (e) { toast("تعذر فك ضغط القائمة", "err"); }
      }
    } else { base = new Map(); loadedKey = null; }
    renderResults();
  }, err => toast(arErr(err), "err"));

  // ---- بحث وتعديل ----
  $("pcSearch").addEventListener("input", renderResults);
  $("pcResults").addEventListener("click", async e => {
    const b = e.target.closest("[data-save]"); if (!b) return;
    const k = b.dataset.save; const inp = $("pcResults").querySelector(`[data-price="${CSS.escape(k)}"]`);
    const p = parseFloat(inp.value);
    if (!isFinite(p) || p < 0) return toast("اكتب سعر صحيح", "err");
    const m = new Map(ov); m.set(k, { name: b.dataset.name, price: p });
    try { await writeOv(m); toast("تم حفظ السعر"); } catch (ex) { toast(arErr(ex), "err"); }
  });
  $("pcAdd").onclick = async () => {
    const name = $("pcNewName").value.trim(); const p = parseFloat($("pcNewPrice").value);
    if (!name || !isFinite(p) || p < 0) return toast("اكتب اسم المنتج والسعر", "err");
    const m = new Map(ov); m.set(normKey(name), { name, price: p });
    try { await writeOv(m); $("pcNewName").value = ""; $("pcNewPrice").value = ""; toast("تمت إضافة السعر"); } catch (ex) { toast(arErr(ex), "err"); }
  };
  $("pcOvBody").addEventListener("click", async e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    const m = new Map(ov); m.delete(b.dataset.del);
    try { await writeOv(m); toast("اترجع السعر الأصلي"); } catch (ex) { toast(arErr(ex), "err"); }
  });

  // ---- رفع ملف أسعار ----
  $("pcImport").onclick = () => $("pcFile").click();
  $("pcFile").addEventListener("change", async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const btn = $("pcImport"); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري قراءة الملف...';
    try {
      let rows;
      if (/\.csv$/i.test(f.name)) rows = parseCSV(await f.text());
      else {
        await loadSheetJS();
        const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array" });
        const name = wb.SheetNames.find(n => n.trim().toLowerCase() === "price list") || wb.SheetNames[0];
        const ws = wb.Sheets[name];
        const rg = XLSX.utils.decode_range(ws["!ref"]); rg.e.c = Math.min(rg.e.c, 1); ws["!ref"] = XLSX.utils.encode_range(rg);
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      }
      const { entries, invalid, dup } = buildEntries(rows.slice(1));
      if (!entries.length) throw new Error("مفيش منتجات بأسعار صالحة في الملف (العمود الأول اسم والتاني سعر).");
      modal("تأكيد رفع قائمة الأسعار", `
        <p>هيتحفظ <b>${fmt(entries.length)}</b> منتج من الملف <span class="mono">${esc(f.name)}</span>.</p>
        <p class="sub">اتجاهلنا ${fmt(dup)} اسم مكرر (بناخد أول سعر) و${fmt(invalid)} صف من غير سعر صالح.</p>
        <p class="sub">القايمة بتحل محل القديمة لكل المستخدمين فورًا.</p>
        <div class="field"><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="clear" style="width:auto"> امسح التعديلات اليدوية الحالية (${ov.size})</label></div>`, {
        submitText: "حفظ القائمة",
        async onSubmit(form) {
          const text = entriesToText(entries);
          const chunks = await packText(text);
          const old = meta ? meta.chunks : 0;
          const b = writeBatch(db);
          chunks.forEach((c, i) => b.set(doc(db, "prices", "b" + i), { data: c }));
          for (let i = chunks.length; i < old; i++) b.delete(doc(db, "prices", "b" + i));
          b.set(doc(db, "prices", "meta"), {
            version: Date.now().toString(36), count: entries.length, chunks: chunks.length,
            updatedAt: serverTimestamp(), updatedAtMs: Date.now(), source: f.name, by: me.name || ""
          });
          if (form.elements.clear.checked) b.delete(doc(db, "prices", "ov"));
          await b.commit();
          toast("تم حفظ قائمة الأسعار");
        }
      });
    } catch (ex) { toast(ex.message || arErr(ex), "err"); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-file-arrow-up"></i> رفع ملف'; }
  });

  renderOv();
  return unsub;
}
