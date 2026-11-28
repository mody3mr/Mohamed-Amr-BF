// إدارة مواعيد الفروع (أدمن): العربيات والفروع + مراجعة اللي اتبعت + إرسال للشيت
import { db } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, esc, toast, arErr } from "./common.js";
import {
  $, cairoToday, tabName, isLate, lateBy, toMin, fmt12, dayLabel, tsLabel, tsMs, timeField, modal, confirmBox, initShell, message
} from "./schedule-core.js";

const api = await guard({ admin: true });
const uid = api.user.uid;
initShell(api);
const root = $("root");

let trucks = [], branches = [], users = [], bridge = {};
let tab = "review", day = cairoToday(), entries = [], docks = [];
const T = id => trucks.find(t => t.id === id);
const B = id => branches.find(b => b.id === id);
const U = id => users.find(u => u.uid === id);
const uname = id => (U(id) || {}).name || "(مستخدم اتشال)";
const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name));

async function loadAll() {
  const [t, b, u, br] = await Promise.all([
    getDocs(collection(db, "trucks")), getDocs(collection(db, "branches")), getDocs(collection(db, "users")), getDoc(doc(db, "meta", "sheetBridge"))
  ]);
  trucks = t.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.loadTime).localeCompare(String(b.loadTime)));
  branches = b.docs.map(d => ({ id: d.id, ...d.data() }));
  users = u.docs.map(d => ({ uid: d.id, ...d.data() }));
  bridge = br.exists() ? br.data() : {};
}
async function loadDay() {
  const [e, d] = await Promise.all([
    getDocs(query(collection(db, "entries"), where("date", "==", day))),
    getDocs(query(collection(db, "docks"), where("date", "==", day)))
  ]);
  entries = e.docs.map(x => ({ id: x.id, ...x.data() }));
  docks = d.docs.map(x => ({ id: x.id, ...x.data() }));
}
await loadAll();
await loadDay();

root.innerHTML = `
  <h2>إدارة مواعيد الفروع</h2>
  <p class="sub">عرّف العربيات والفروع، راجع اللي الليدرز بعتوه، وابعته للشيت.</p>
  <div class="tabs">
    <button class="tab" data-t="review"><i class="fa-solid fa-list-check"></i> مراجعة اليوم</button>
    <button class="tab" data-t="setup"><i class="fa-solid fa-truck"></i> العربيات والفروع</button>
    <button class="tab" data-t="bridge"><i class="fa-solid fa-table"></i> ربط الشيت</button>
  </div><div id="tabBody"></div>`;
root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; paint(); });
paint();

function paint() {
  root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
  if (tab === "review") paintReview(); else if (tab === "setup") paintSetup(); else paintBridge();
}

/* ================================================================== تصدير / نسخ احتياطي */
let xlsxP = null;
const loadXLSX = () => window.XLSX ? Promise.resolve(window.XLSX) : (xlsxP || (xlsxP = new Promise((res, rej) => {
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  s.onload = () => res(window.XLSX); s.onerror = () => { xlsxP = null; rej(new Error("تعذر تحميل مكتبة الإكسيل، اتأكد من النت.")); };
  document.head.appendChild(s);
})));
const cairoStr = ts => ts && ts.toDate ? ts.toDate().toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : "";
const isoStr = ts => ts && ts.toDate ? ts.toDate().toISOString() : null;
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const statusText = e => !e ? "لم يُرسل" : e.holiday ? "إجازة" : !e.arrival ? "ناقص"
  : isLate(e.arrival, e.schedTime) ? `متأخر +${lateBy(e.arrival, e.schedTime)}د` : toMin(e.arrival) < toMin(e.schedTime) ? "بدري" : "في الميعاد";
const hm = t => (t || "");

// إكسيل لليوم المعروض: بنفس ترتيب شيت End To End (عربية > فروع) عشان تقدر تكمل منه يدوي لو الشيت وقع
async function exportDayXlsx() {
  const X = await loadXLSX();
  const rows = [["Truck", "In Docks", "Out Docks", "Fps Store Name", "Arrival Schedule", "Arrival time", "End time", "Status", "Comment", "Leader", "Sent at"]];
  trucks.forEach(t => {
    const d = docks.find(x => x.truckId === t.id);
    branches.filter(b => b.truckId === t.id).sort(byOrder).forEach((b, i) => {
      const { off } = officialOf(b);
      rows.push([i === 0 ? t.name : "", i === 0 && d ? hm(d.inTime) : "", i === 0 && d ? hm(d.outTime) : "", b.sheetName || b.name, hm(b.time),
        off ? (off.holiday ? 0 : hm(off.arrival)) : "", off ? (off.holiday ? 0 : hm(off.end)) : "", statusText(off),
        off && off.late ? off.note || "" : "", off ? uname(off.uid) : "", off ? cairoStr(off.sentAt) : ""]);
    });
  });
  const all = [["Branch", "Truck", "Leader", "Official", "Holiday", "Arrival schedule", "Arrival", "End", "Status", "Note", "Sent at", "Archived"]];
  entries.forEach(e => { const b = B(e.branchId) || {}; all.push([b.sheetName || b.name || e.branchId, (T(b.truckId) || {}).name || "", uname(e.uid),
    officialOf(b).off === e ? "yes" : "no", e.holiday ? "yes" : "", hm(e.schedTime), hm(e.arrival), hm(e.end), statusText(e), e.note || "", cairoStr(e.sentAt), e.status === "archived" ? "yes" : ""]); });
  const dk = [["Truck", "In", "Out", "By", "Sent at"]];
  docks.forEach(d => dk.push([(T(d.truckId) || {}).name || d.truckId, hm(d.inTime), hm(d.outTime), uname(d.uid), cairoStr(d.sentAt)]));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), tabName(day).replace("/", "-"));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(all), "All entries");
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(dk), "Docks");
  save(new Blob([X.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/octet-stream" }), `Schedule_${day}.xlsx`);
  toast("اتنزّل ملف الإكسيل ✓");
}

// نسخة احتياطية كاملة (كل الأيام): إكسيل للقراءة + JSON للاحتفاظ بالبيانات
async function backupAll(kind) {
  const [e, d] = await Promise.all([getDocs(collection(db, "entries")), getDocs(collection(db, "docks"))]);
  const ents = e.docs.map(x => ({ id: x.id, ...x.data() })), dks = d.docs.map(x => ({ id: x.id, ...x.data() }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  if (kind === "json") {
    const clean = o => { const r = {}; Object.entries(o).forEach(([k, v]) => { r[k] = v && v.toDate ? isoStr(v) : v; }); return r; };
    const data = { app: "branch-schedule", exportedAt: new Date().toISOString(), trucks: trucks.map(clean), branches: branches.map(clean),
      leaders: users.filter(u => u.sched).map(u => ({ uid: u.uid, name: u.name, empId: u.employeeId || null, sched: u.sched })), entries: ents.map(clean), docks: dks.map(clean) };
    save(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), `schedule-backup-${stamp}.json`);
  } else {
    const X = await loadXLSX();
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Truck", "Load time", "Leaders", "Primary"],
      ...trucks.map(t => [t.name, hm(t.loadTime), (t.leaders || []).map(uname).join(", "), t.primary ? uname(t.primary) : ""])]), "Trucks");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Branch", "Name in sheet", "Truck", "Arrival schedule", "Order", "Leaders", "Primary"],
      ...branches.map(b => [b.name, b.sheetName || "", (T(b.truckId) || {}).name || "", hm(b.time), b.order || 0, (b.leaders || []).map(uname).join(", "), b.primary ? uname(b.primary) : ""])]), "Branches");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Branch", "Truck", "Leader", "Holiday", "Arrival schedule", "Arrival", "End", "Status", "Note", "Sent at", "Archived"],
      ...ents.sort((a, b) => a.date.localeCompare(b.date)).map(x => { const b = B(x.branchId) || {}; return [x.date, b.sheetName || b.name || x.branchId, (T(b.truckId) || {}).name || "",
        uname(x.uid), x.holiday ? "yes" : "", hm(x.schedTime), hm(x.arrival), hm(x.end), statusText(x), x.note || "", cairoStr(x.sentAt), x.status === "archived" ? "yes" : ""]; })]), "Entries");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Truck", "In", "Out", "By", "Sent at"],
      ...dks.sort((a, b) => a.date.localeCompare(b.date)).map(x => [x.date, (T(x.truckId) || {}).name || x.truckId, hm(x.inTime), hm(x.outTime), uname(x.uid), cairoStr(x.sentAt)])]), "Docks");
    save(new Blob([X.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/octet-stream" }), `schedule-backup-${stamp}.xlsx`);
  }
  toast("اتنزّلت النسخة الاحتياطية ✓");
}
function guarded(fn) {     // function declaration (مرفوعة لفوق) لأن paint() بتتنادى قبل الوصول لهذا السطر
  return async ev => {
    const b = ev.currentTarget; b.disabled = true;
    try { await fn(); } catch (e) { toast(e.message || arErr(e), "err"); } finally { b.disabled = false; }
  };
}

/* ================================================================== العربيات والفروع */
function paintSetup() {
  const leaders = users.filter(u => u.sched === "leader");
  $("tabBody").innerHTML = `
  <div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><b>العربيات</b><div class="mini">ترتيبها في صفحة مندوب المخزن بحسب ميعاد التحميل</div></div><div class="sp"></div>
    <button class="btn sm" id="btnTruck"><i class="fa-solid fa-plus"></i> عربية جديدة</button>
    <button class="btn ghost sm" id="btnImport"><i class="fa-solid fa-file-import"></i> استيراد جماعي</button>
    <button class="btn ghost sm" id="btnBkX"><i class="fa-solid fa-file-excel"></i> نسخة احتياطية (Excel)</button>
    <button class="btn ghost sm" id="btnBkJ"><i class="fa-solid fa-file-code"></i> نسخة احتياطية (JSON)</button></div>
    <div class="table-wrap"><table><thead><tr><th>العربية</th><th>ميعاد التحميل</th><th>عدد الفروع</th><th>الليدرز (على كل فروعها)</th><th>إجراءات</th></tr></thead><tbody>
    ${trucks.map(t => `<tr><td>${esc(t.name)}</td><td>${fmt12(t.loadTime)}</td><td>${branches.filter(b => b.truckId === t.id).length}</td>
      <td style="white-space:normal">${(t.leaders || []).map(l => `${esc(uname(l))}${l === t.primary ? " ★" : ""}`).join("، ") || "—"}</td>
      <td><div class="acts"><button class="btn sm" data-a="lt" data-id="${t.id}"><i class="fa-solid fa-user-check"></i> تعيين ليدرز</button><button class="btn ghost sm" data-a="et" data-id="${t.id}">تعديل</button><button class="btn ghost sm" data-a="dt" data-id="${t.id}">مسح</button></div></td></tr>`).join("")
      || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">مفيش عربيات لسه</td></tr>'}</tbody></table></div></div>

  <div class="panel"><div class="panel-head"><div><b>الفروع</b><div class="mini">الاسم في الشيت لازم يكون زي عمود Fps Store Name بالظبط</div></div><div class="sp"></div>
    <button class="btn sm" id="btnBranch"><i class="fa-solid fa-plus"></i> فرع جديد</button></div>
    <div class="table-wrap"><table><thead><tr><th>الفرع</th><th>الاسم في الشيت</th><th>العربية</th><th>ميعاد الوصول</th><th>الترتيب</th><th>الليدرز</th><th>إجراءات</th></tr></thead><tbody>
    ${[...branches].sort((a, b) => (T(a.truckId) ? String(T(a.truckId).loadTime) : "zz").localeCompare(T(b.truckId) ? String(T(b.truckId).loadTime) : "zz") || byOrder(a, b)).map(b => `<tr>
      <td>${esc(b.name)}</td><td dir="ltr" style="text-align:right">${esc(b.sheetName || "")}</td><td>${esc((T(b.truckId) || {}).name || "—")}</td>
      <td>${fmt12(b.time)}</td><td>${b.order || 0}</td>
      <td style="white-space:normal">${(b.leaders || []).map(l => `${esc(uname(l))}${l === b.primary ? " ★" : ""}`).join("، ") || "—"}</td>
      <td><div class="acts"><button class="btn ghost sm" data-a="eb" data-id="${b.id}">تعديل</button><button class="btn ghost sm" data-a="db" data-id="${b.id}">مسح</button></div></td></tr>`).join("")
      || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">مفيش فروع لسه</td></tr>'}</tbody></table></div></div>
  ${leaders.length ? "" : '<div class="msg info" style="margin-top:14px">مفيش مستخدمين بدور "ليدر". حدد الدور من تاب المستخدمين في لوحة التحكم عشان تقدر تعيّنهم على فروع.</div>'}`;

  $("btnTruck").onclick = () => truckModal();
  $("btnBranch").onclick = () => branchModal();
  $("btnImport").onclick = importModal;
  $("btnBkX").onclick = guarded(() => backupAll("xlsx"));
  $("btnBkJ").onclick = guarded(() => backupAll("json"));
  $("tabBody").querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
    const id = b.dataset.id, a = b.dataset.a;
    if (a === "et") truckModal(T(id)); if (a === "eb") branchModal(B(id));
    if (a === "lt") assignModal(T(id));
    if (a === "dt") {
      if (branches.some(x => x.truckId === id)) return toast("فيه فروع على العربية دي. انقلها أو امسحها الأول.", "err");
      delTruck(id);
    }
    if (a === "db") delBranch(id);
  });
}
async function delTruck(id) {
  if (!(await confirmBox("مسح عربية", `<p>هتمسح <b>${esc(T(id).name)}</b>؟</p>`, { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "trucks", id)); await loadAll(); paint(); toast("اتمسحت");
}
async function delBranch(id) {
  if (!(await confirmBox("مسح فرع", `<p>هتمسح <b>${esc(B(id).name)}</b> من النظام؟ البيانات القديمة المبعوتة هتفضل موجودة.</p>`, { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "branches", id)); await loadAll(); paint(); toast("اتمسح");
}
function truckModal(t) {
  modal(t ? "تعديل عربية" : "عربية جديدة", `
    <div class="field"><label>اسم العربية</label><input name="name" required value="${esc(t ? t.name : "")}" placeholder="Truck 1"></div>
    <div class="field"><label>ميعاد تحميلها من المخزن</label>${timeField("loadTime", t ? t.loadTime : "")}</div>`, {
    async onSubmit(f) {
      const name = f.elements.name.value.trim(), loadTime = f.elements.loadTime.value;
      if (!name || !loadTime) throw new Error("اكتب الاسم واختار الميعاد.");
      if (t) await updateDoc(doc(db, "trucks", t.id), { name, loadTime }); else await addDoc(collection(db, "trucks"), { name, loadTime });
      await loadAll(); paint(); toast("اتحفظ ✓");
    }
  });
}
// تعيين الليدرز على العربية كلها: بيتطبق على كل فروعها مرة واحدة (والفروع الجديدة اللي بتتضاف للعربية بتاخدهم)
function assignModal(t) {
  const leaders = users.filter(u => u.sched === "leader");
  const sel = new Set(t.leaders || []);
  const n = branches.filter(b => b.truckId === t.id).length;
  modal("تعيين ليدرز: " + t.name, `
    <p class="mini">هيتعيّنوا على <b>${n}</b> فرع في العربية دي (بيستبدلوا الليدرز القدام). ★ = الأساسي، وهو اللي بياخد ميعاد الإرسال لو اتنين بعتوا نفس الفرع.</p>
    <div class="field"><div class="checks">${leaders.map(u => `<label><input type="checkbox" name="ld" value="${u.uid}" ${sel.has(u.uid) ? "checked" : ""}> ${esc(u.name)}
      <input type="radio" name="primary" value="${u.uid}" ${t.primary === u.uid ? "checked" : ""} title="الأساسي"> ★</label>`).join("")
      || "<small>مفيش مستخدمين بدور ليدر. حدد الدور من تاب المستخدمين.</small>"}</div></div>`, {
    async onSubmit(f) {
      const ld = [...f.querySelectorAll("[name=ld]:checked")].map(x => x.value);
      let primary = (f.querySelector("[name=primary]:checked") || {}).value || "";
      if (primary && !ld.includes(primary)) primary = "";
      if (!primary && ld.length) primary = ld[0];
      const batch = writeBatch(db);
      batch.update(doc(db, "trucks", t.id), { leaders: ld, primary });
      branches.filter(b => b.truckId === t.id).forEach(b => batch.update(doc(db, "branches", b.id), { leaders: ld, primary }));
      await batch.commit(); await loadAll(); paint(); toast("اتعيّنوا على العربية كلها ✓");
    }
  });
}
function branchModal(b) {
  const leaders = users.filter(u => u.sched === "leader");
  const sel = new Set(b ? b.leaders || [] : []);
  modal(b ? "تعديل فرع" : "فرع جديد", `
    <div class="field"><label>اسم الفرع (للعرض)</label><input name="name" required value="${esc(b ? b.name : "")}"></div>
    <div class="field"><label>اسمه في الشيت بالظبط</label><input name="sheetName" dir="ltr" required value="${esc(b ? b.sheetName || b.name : "")}"><small>زي ما هو مكتوب في عمود Fps Store Name</small></div>
    <div class="row"><div class="field"><label>العربية</label><select name="truckId" required><option value="">اختار...</option>
      ${trucks.map(t => `<option value="${t.id}" ${b && b.truckId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="field"><label>ميعاد الوصول المطلوب</label>${timeField("time", b ? b.time : "")}</div>
    <div class="field"><label>الترتيب جوه العربية</label><input name="order" type="number" min="0" value="${b ? b.order || 0 : 0}"></div></div>
    <div class="field"><label>الليدرز المسؤولين (★ الأساسي)</label><div class="checks">
      ${leaders.map(u => `<label><input type="checkbox" name="ld" value="${u.uid}" ${sel.has(u.uid) ? "checked" : ""}> ${esc(u.name)}
        <input type="radio" name="primary" value="${u.uid}" ${b && b.primary === u.uid ? "checked" : ""} title="الأساسي"> ★</label>`).join("")
        || "<small>مفيش ليدرز لسه</small>"}</div></div>`, {
    async onSubmit(f) {
      const ld = [...f.querySelectorAll("[name=ld]:checked")].map(x => x.value);
      let primary = (f.querySelector("[name=primary]:checked") || {}).value || "";
      if (primary && !ld.includes(primary)) primary = "";
      if (!primary && ld.length) primary = ld[0];
      const data = {
        name: f.elements.name.value.trim(), sheetName: f.elements.sheetName.value.trim(), truckId: f.elements.truckId.value,
        time: f.elements.time.value, order: +f.elements.order.value || 0, leaders: ld, primary
      };
      if (!data.name || !data.sheetName || !data.truckId || !data.time) throw new Error("كمّل كل الخانات المطلوبة.");
      if (!b && !ld.length && (T(data.truckId) || {}).leaders) { data.leaders = T(data.truckId).leaders; data.primary = T(data.truckId).primary || ""; }
      if (b) await updateDoc(doc(db, "branches", b.id), data); else await addDoc(collection(db, "branches"), data);
      await loadAll(); paint(); toast("اتحفظ ✓");
    }
  });
}
function importModal() {
  modal("استيراد جماعي للفروع", `
    <p class="mini">سطر لكل فرع بالشكل: <b>اسم العربية | ميعاد الوصول | الاسم في الشيت</b><br>مثال: <span class="mono">Truck 1 | 06:30 | Breadfast Coffee - Chillout El Rehab</span><br>
    العربيات الجديدة بتتعمل أوتوماتيك (ميعاد تحميلها 00:00 لحد ما تعدّله). الليدرز بتعيّنهم بعد كده لكل فرع.</p>
    <div class="field"><textarea class="code" name="txt" dir="ltr" required style="min-height:260px"></textarea></div>`, {
    submitText: "استيراد", wide: true,
    async onSubmit(f) {
      const lines = f.elements.txt.value.split("\n").map(l => l.trim()).filter(Boolean);
      const bad = [], rows = [];
      lines.forEach((l, i) => {
        const p = l.split("|").map(x => x.trim());
        let tm = (p[1] || "").replace(/^(\d):/, "0$1:");
        if (p.length < 3 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm) || !p[0] || !p[2]) bad.push(i + 1); else rows.push({ truck: p[0], time: tm, sheet: p[2] });
      });
      if (bad.length) throw new Error("فيه سطور غلط (رقم السطر): " + bad.join("، "));
      const tmap = {}; trucks.forEach(t => { tmap[t.name.toLowerCase()] = t.id; });
      for (const r of rows) if (!tmap[r.truck.toLowerCase()]) tmap[r.truck.toLowerCase()] = (await addDoc(collection(db, "trucks"), { name: r.truck, loadTime: "00:00" })).id;
      const order = {}; const known = new Set(branches.map(b => (b.sheetName || "").toLowerCase()));
      const batch = writeBatch(db); let n = 0;
      rows.forEach(r => {
        if (known.has(r.sheet.toLowerCase())) return;
        const tid = tmap[r.truck.toLowerCase()]; order[tid] = (order[tid] || 0) + 1;
        const tt = T(tid) || {};
        batch.set(doc(collection(db, "branches")), { name: r.sheet.replace(/^breadfast coffee\s*-\s*/i, ""), sheetName: r.sheet, truckId: tid, time: r.time, order: order[tid], leaders: tt.leaders || [], primary: tt.primary || "" });
        n++;
      });
      await batch.commit(); await loadAll(); paint(); toast(`اتضاف ${n} فرع ✓`);
    }
  });
}

/* ================================================================== مراجعة اليوم */
function officialOf(b) {
  const list = entries.filter(e => e.branchId === b.id);
  if (!list.length) return { list, off: null };
  const off = list.find(e => e.uid === b.primary) || [...list].sort((a, c) => tsMs(a.sentAt) - tsMs(c.sentAt))[0];
  return { list, off };
}
function badge(e) {
  if (e.holiday) return '<span class="badge hol">إجازة</span>';
  if (!e.arrival) return '<span class="badge wait">ناقص</span>';
  const s = e.schedTime;
  if (isLate(e.arrival, s)) return `<span class="badge late">متأخر +${lateBy(e.arrival, s)} د</span>`;
  return toMin(e.arrival) < toMin(s) ? '<span class="badge early">بدري</span>' : '<span class="badge ok">في الميعاد</span>';
}
function paintReview() {
  const allArch = (entries.length || docks.length) && [...entries, ...docks].every(x => x.status === "archived");
  const sentTruckCount = trucks.length;
  $("tabBody").innerHTML = `
    <div class="datebar"><label class="dl">اليوم:</label><input type="date" id="dayIn" value="${day}">
      <span class="dl">${dayLabel(day)}</span><span class="mini">(تاب الشيت: ${tabName(day)})</span>
      ${allArch ? '<span class="badge ok">اتبعت للشيت وأتأرشف</span>' : ""}
      <div class="grow-sp"></div>
      <button class="btn ghost" id="btnXlsx" ${entries.length || docks.length ? "" : "disabled"}><i class="fa-solid fa-file-excel"></i> تصدير إكسيل لليوم</button>
      <button class="btn" id="btnSheet" ${entries.length || docks.length ? "" : "disabled"}><i class="fa-solid fa-table"></i> إرسال للشيت</button></div>
    <div id="revMsg" class="msg hidden"></div>
    ${trucks.map(t => {
      const d = docks.find(x => x.truckId === t.id);
      const brs = branches.filter(b => b.truckId === t.id).sort(byOrder);
      return `<div class="truck"><div class="truck-h"><i class="fa-solid fa-truck"></i> ${esc(t.name)} <small>تحميل ${fmt12(t.loadTime)}</small>
        <span class="sp"></span>
        ${d ? `<span>مخزن: دخول <b>${fmt12(d.inTime)}</b> / خروج <b>${fmt12(d.outTime)}</b> <small>(${esc(uname(d.uid))} ${tsLabel(d.sentAt)})</small></span>
          <button class="btn ghost sm" data-a="ed" data-id="${d.id}">تعديل</button><button class="btn ghost sm" data-a="dd" data-id="${d.id}">مسح</button>`
        : `<small>مفيش تسجيل مخزن</small> <button class="btn ghost sm" data-a="ad" data-id="${t.id}">إضافة</button>`}</div>
        <div class="table-wrap"><table><thead><tr><th>الفرع</th><th>الميعاد</th><th>وصول</th><th>انتهاء</th><th>الحالة</th><th>السبب</th><th>بواسطة / وقت الإرسال</th><th></th></tr></thead><tbody>
        ${brs.map(b => {
          const { list, off } = officialOf(b);
          if (!list.length) return `<tr><td>${esc(b.name)}</td><td>${fmt12(b.time)}</td><td colspan="5" style="color:var(--muted)">لسه مش مبعوت</td>
            <td><button class="btn ghost sm" data-a="ae" data-id="${b.id}">إضافة</button></td></tr>`;
          return [...list].sort((a, c) => (a === off ? -1 : c === off ? 1 : tsMs(a.sentAt) - tsMs(c.sentAt))).map(e => `<tr class="${e === off ? "" : "dup"}">
            <td>${esc(b.name)} ${e === off ? '<span class="badge ok">الرسمي</span>' : '<span class="badge wait">نسخة تانية</span>'}</td><td>${fmt12(e.schedTime)}</td>
            <td>${e.holiday ? "—" : fmt12(e.arrival)}</td><td>${e.holiday ? "—" : fmt12(e.end)}</td><td>${badge(e)}</td>
            <td style="white-space:normal;min-width:160px">${esc(e.note || "")}</td>
            <td>${esc(uname(e.uid))}${e.uid === b.primary ? " ★" : ""} <span class="mini">${tsLabel(e.sentAt)}</span>${e.editedAt ? ' <span class="badge wait">اتعدّل</span>' : ""}</td>
            <td><div class="acts"><button class="btn ghost sm" data-a="ee" data-id="${e.id}">تعديل</button><button class="btn ghost sm" data-a="de" data-id="${e.id}">مسح</button></div></td></tr>`).join("");
        }).join("") || '<tr><td colspan="8" style="color:var(--muted);text-align:center">مفيش فروع على العربية دي</td></tr>'}
        </tbody></table></div></div>`;
    }).join("") || '<div class="empty">عرّف العربيات والفروع الأول من تاب "العربيات والفروع".</div>'}`;

  $("dayIn").onchange = async e => { day = e.target.value || cairoToday(); await loadDay(); paintReview(); };
  $("btnSheet").onclick = sendToSheet;
  $("btnXlsx").onclick = guarded(exportDayXlsx);
  $("tabBody").querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
    const a = b.dataset.a, id = b.dataset.id;
    if (a === "ee") entryModal(entries.find(x => x.id === id));
    if (a === "ae") entryModal(null, B(id));
    if (a === "de") delEntry(id);
    if (a === "ed") dockModal(docks.find(x => x.id === id));
    if (a === "ad") dockModal(null, T(id));
    if (a === "dd") delDock(id);
  });
}
async function refreshReview() { await loadDay(); paintReview(); }

function entryModal(e, branch) {
  const b = e ? B(e.branchId) || { name: "(فرع اتشال)", time: e.schedTime } : branch;
  modal((e ? "تعديل بيانات " : "إضافة بيانات ") + b.name, `
    <div class="row"><div class="field"><label>وصول</label>${timeField("arr", e ? e.arrival : "")}</div>
    <div class="field"><label>انتهاء</label>${timeField("end", e ? e.end : "")}</div></div>
    <div class="field"><label class="hol"><input type="checkbox" name="hol" ${e && e.holiday ? "checked" : ""}> الفرع إجازة (هيتكتب 0 في الشيت)</label></div>
    <div class="field"><label>السبب / ملاحظة</label><textarea name="note" rows="3">${esc(e ? e.note || "" : "")}</textarea></div>`, {
    async onSubmit(f) {
      const hol = f.elements.hol.checked;
      const arrival = hol ? null : f.elements.arr.value || null, end = hol ? null : f.elements.end.value || null, note = f.elements.note.value.trim();
      const sched = e ? e.schedTime : b.time;
      if (e) await updateDoc(doc(db, "entries", e.id), { arrival, end, holiday: hol, note, late: isLate(arrival, sched), editedBy: uid, editedAt: serverTimestamp() });
      else {
        const who = b.primary || uid;
        await setDoc(doc(db, "entries", `${day}_${b.id}_${who}`), {
          date: day, branchId: b.id, uid: who, arrival, end, holiday: hol, note, late: isLate(arrival, sched), schedTime: sched,
          sentAt: serverTimestamp(), sid: "admin", status: "sent", addedByAdmin: true
        });
      }
      await refreshReview(); toast("اتحفظ ✓");
    }
  });
}
async function delEntry(id) {
  if (!(await confirmBox("مسح بيانات", "<p>هتمسح البيانات دي نهائيًا؟</p>", { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "entries", id)); await refreshReview(); toast("اتمسحت");
}
function dockModal(d, truck) {
  const t = d ? T(d.truckId) || { name: "(عربية اتشالت)" } : truck;
  modal((d ? "تعديل " : "إضافة ") + "مواعيد المخزن: " + t.name, `
    <div class="row"><div class="field"><label>دخول</label>${timeField("in", d ? d.inTime : "")}</div>
    <div class="field"><label>خروج</label>${timeField("out", d ? d.outTime : "")}</div></div>`, {
    async onSubmit(f) {
      const inTime = f.elements.in.value, outTime = f.elements.out.value || null;
      if (!inTime) throw new Error("اختار وقت الدخول.");
      if (d) await updateDoc(doc(db, "docks", d.id), { inTime, outTime, editedBy: uid, editedAt: serverTimestamp() });
      else await setDoc(doc(db, "docks", `${day}_${truck.id}`), { date: day, truckId: truck.id, uid, inTime, outTime, sentAt: serverTimestamp(), sid: "admin", status: "sent", addedByAdmin: true });
      await refreshReview(); toast("اتحفظ ✓");
    }
  });
}
async function delDock(id) {
  if (!(await confirmBox("مسح", "<p>هتمسح تسجيل المخزن ده؟</p>", { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "docks", id)); await refreshReview(); toast("اتمسح");
}

/* ---------- الإرسال للشيت ---------- */
async function sendToSheet() {
  if (!bridge.url || !bridge.secret) return toast("اضبط رابط الشيت والمفتاح الأول من تاب \"ربط الشيت\".", "err");
  const rows = [], missing = [];
  branches.forEach(b => {
    const { off } = officialOf(b);
    if (!off) { missing.push(b.name); return; }
    rows.push({ name: b.sheetName || b.name, arrival: off.arrival || null, end: off.end || null, holiday: !!off.holiday, comment: off.late && off.note ? off.note : "" });
  });
  const dk = docks.map(d => ({ names: branches.filter(b => b.truckId === d.truckId).map(b => b.sheetName || b.name), in: d.inTime, out: d.outTime || null }));
  const ok = await confirmBox("إرسال للشيت", `
    <p>هتتكتب بيانات <b>${rows.length}</b> فرع و<b>${dk.length}</b> عربية في تاب <b>${tabName(day)}</b>.</p>
    ${missing.length ? `<div class="msg info" style="white-space:normal">فروع مفيهاش بيانات (مش هتتكتب): ${missing.map(esc).join("، ")}</div>` : ""}
    <p class="mini">بعد الإرسال الناجح اليوم ده بيتأرشف ويظهر للمناديب في المهام المكتملة.</p>`, { submitText: "إرسال" });
  if (!ok) return;
  const btn = $("btnSheet"); btn.disabled = true;
  const box = $("revMsg");
  try {
    const res = await fetch(bridge.url, { method: "POST", body: JSON.stringify({ secret: bridge.secret, tab: tabName(day), rows, docks: dk }) });
    const j = await res.json();
    if (!j.ok) {
      message(box, j.error === "tab-not-found" ? `مفيش تاب في الشيت اسمه <b>${tabName(day)}</b>.` : j.error === "unauthorized" ? "المفتاح السري غلط." : "الشيت رجّع خطأ: " + esc(j.error || ""), "err");
      btn.disabled = false; return;
    }
    const batch = writeBatch(db);
    entries.forEach(x => batch.update(doc(db, "entries", x.id), { status: "archived", archivedAt: serverTimestamp() }));
    docks.forEach(x => batch.update(doc(db, "docks", x.id), { status: "archived", archivedAt: serverTimestamp() }));
    await batch.commit();
    await loadDay(); paintReview();
    message($("revMsg"), `<b>اتبعت للشيت ✓</b> اتكتب ${j.written || 0} خانة.` +
      (j.notFound && j.notFound.length ? `<br>الفروع دي مالقيتش اسمها في الشيت: <b>${j.notFound.map(esc).join("، ")}</b>. راجع "الاسم في الشيت".` : ""), j.notFound && j.notFound.length ? "info" : "ok");
  } catch (e) {
    btn.disabled = false;
    message(box, "تعذر قراءة رد الشيت. افتح الشيت وتأكد لو البيانات اتكتبت قبل ما تبعت تاني. " + esc(e.message || ""), "err");
  }
}

/* ================================================================== ربط الشيت */
function paintBridge() {
  $("tabBody").innerHTML = `
    <div class="panel" style="max-width:720px"><div class="panel-head"><b>رابط Apps Script</b></div><div style="padding:18px">
      <div class="msg info">الإعدادات دي بيشوفها الأدمن بس. خطوات إنشاء السكربت في ملف <span class="mono">apps-script/Code.gs</span>.</div>
      <div class="field"><label>رابط Web App</label><input id="brUrl" dir="ltr" value="${esc(bridge.url || "")}" placeholder="https://script.google.com/macros/s/.../exec"></div>
      <div class="field"><label>المفتاح السري</label><input id="brSecret" dir="ltr" type="password" value="${esc(bridge.secret || "")}"><small>نفس القيمة اللي في Script Properties باسم SECRET</small></div>
      <div style="display:flex;gap:10px"><button class="btn" id="brSave">حفظ</button><button class="btn ghost" id="brTest">اختبار الاتصال</button></div>
      <div id="brMsg" class="msg hidden" style="margin-top:14px"></div></div></div>`;
  $("brSave").onclick = async () => {
    try {
      bridge = { url: $("brUrl").value.trim(), secret: $("brSecret").value.trim() };
      await setDoc(doc(db, "meta", "sheetBridge"), { ...bridge, updatedAt: serverTimestamp() });
      toast("اتحفظ ✓");
    } catch (e) { toast(arErr(e), "err"); }
  };
  $("brTest").onclick = async () => {
    const m = $("brMsg");
    try {
      const r = await fetch($("brUrl").value.trim(), { method: "POST", body: JSON.stringify({ secret: $("brSecret").value.trim(), action: "ping" }) });
      const j = await r.json();
      message(m, j.ok ? "الاتصال شغال ✓" : "الرابط شغال بس المفتاح غلط.", j.ok ? "ok" : "err");
    } catch (e) { message(m, "مقدرتش أوصل للرابط. اتأكد إنه منشور (Anyone) وإنه بيخلص بـ /exec.", "err"); }
  };
}
