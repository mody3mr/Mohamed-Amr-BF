// إدارة مواعيد الفروع (أدمن): العربيات + الليدرز (ثابتين) + المناديب (يوم بيوم) + مراجعة اللي اتبعت + المخزن + الشيت
import { db } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, esc, toast, arErr, logActivity } from "./common.js";
import {
  $, cairoToday, addDays, tabName, isLate, lateBy, toMin, fmt12, dayLabel, tsLabel, tsMs, timeField, modal, confirmBox, initShell, message
} from "./schedule-core.js";

const api = await guard({ admin: true });
const uid = api.user.uid, myName = api.profile.name;
initShell(api);
const root = $("root");

let trucks = [], branches = [], users = [], bridge = {};
let entries = [], docks = [], assignDay = [], assignToday = [];
let tab = "review", day = cairoToday(), booted = false, leaderQ = "";
const T = id => trucks.find(t => t.id === id);
const B = id => branches.find(b => b.id === id);
const U = id => users.find(u => u.uid === id);
const uname = id => (U(id) || {}).name || "(مستخدم اتشال)";
const empId = u => u.employeeId || "";

/* ------------------------------------------------------------------ دوال عامة (declarations) */
function byOrder(a, b) { return (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)); }
function byLoad(a, b) { return String(a.loadTime).localeCompare(String(b.loadTime)); }
function entryOf(b) { return entries.find(e => e.branchId === b.id) || null; }
function roleTxt(r) { return r === "leader" ? "ليدر" : r === "rep" ? "مندوب" : "إدارة"; }
function badge(e) {
  if (e.holiday) return '<span class="badge hol">إجازة</span>';
  if (!e.arrival) return '<span class="badge wait">ناقص</span>';
  const s = e.schedTime;
  if (isLate(e.arrival, s)) return `<span class="badge late">متأخر +${lateBy(e.arrival, s)} د</span>`;
  return toMin(e.arrival) < toMin(s) ? '<span class="badge early">بدري</span>' : '<span class="badge ok">في الميعاد</span>';
}
const hm = t => (t || "");
function statusText(e) {
  return !e ? "لم يُرسل" : e.holiday ? "إجازة" : !e.arrival ? "ناقص" : isLate(e.arrival, e.schedTime) ? `متأخر +${lateBy(e.arrival, e.schedTime)}د` : toMin(e.arrival) < toMin(e.schedTime) ? "بدري" : "في الميعاد";
}
function durMin(a, b) { const d = toMin(b) - toMin(a); return d < 0 ? d + 1440 : d; }
function fmtDur(m) { return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د`; }
function cairoStr(ts) { return ts && ts.toDate ? ts.toDate().toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : ""; }
function isoStr(ts) { return ts && ts.toDate ? ts.toDate().toISOString() : null; }
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
let xlsxP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxP || (xlsxP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res(window.XLSX); s.onerror = () => { xlsxP = null; rej(new Error("تعذر تحميل مكتبة الإكسيل، اتأكد من النت.")); };
    document.head.appendChild(s);
  }));
}
function xlsxBlob(X, wb) { return new Blob([X.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/octet-stream" }); }
function guarded(fn) {
  return async ev => {
    const b = ev.currentTarget; b.disabled = true;
    try { await fn(); } catch (e) { toast(e.message || arErr(e), "err"); } finally { b.disabled = false; }
  };
}
function userPickList(list, name, type, picked) {   // قايمة اختيار مع بحث
  return `<input class="pick-q" placeholder="ابحث بالاسم أو الرقم الوظيفي..." style="width:100%;padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:transparent;margin-bottom:10px">
    <div class="checks pick-list" style="grid-template-columns:1fr">${list.map(u => `<label data-s="${esc((u.name + " " + empId(u)).toLowerCase())}"><input type="${type}" name="${name}" value="${u.uid}" ${picked.has(u.uid) ? "checked" : ""}> ${esc(u.name)} <span class="mini">${esc(empId(u))}</span></label>`).join("")
      || "<small>مفيش مستخدمين بالدور ده. حدّد الدور من تاب المستخدمين في لوحة التحكم.</small>"}</div>`;
}
function wirePick(f) {
  const q = f.querySelector(".pick-q"); if (!q) return;
  q.oninput = () => { const v = q.value.trim().toLowerCase(); f.querySelectorAll(".pick-list label").forEach(l => { l.style.display = !v || l.dataset.s.includes(v) ? "" : "none"; }); };
}

/* ------------------------------------------------------------------ تحميل لحظي */
function rerender() {
  if (!booted || (tab !== "review" && tab !== "setup")) return;
  const y = window.scrollY; paint(); window.scrollTo(0, y);
}
function watchStatic() {
  onSnapshot(collection(db, "trucks"), s => { trucks = s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byLoad); rerender(); }, showErr);
  onSnapshot(collection(db, "branches"), s => { branches = s.docs.map(d => ({ id: d.id, ...d.data() })); rerender(); }, showErr);
  onSnapshot(collection(db, "users"), s => { users = s.docs.map(d => ({ uid: d.id, ...d.data() })); rerender(); }, showErr);
  onSnapshot(doc(db, "meta", "sheetBridge"), s => { bridge = s.exists() ? s.data() : {}; });
  onSnapshot(query(collection(db, "assign"), where("date", "==", cairoToday())), s => { assignToday = s.docs.map(d => ({ id: d.id, ...d.data() })); rerender(); }, showErr);
}
let dayUnsubs = [];
function watchDay() {
  dayUnsubs.forEach(u => u());
  const q = c => query(collection(db, c), where("date", "==", day));
  dayUnsubs = [
    onSnapshot(q("entries"), s => { entries = s.docs.map(d => ({ id: d.id, ...d.data() })); rerender(); }, showErr),
    onSnapshot(q("docks"), s => { docks = s.docs.map(d => ({ id: d.id, ...d.data() })); rerender(); }, showErr),
    onSnapshot(q("assign"), s => { assignDay = s.docs.map(d => ({ id: d.id, ...d.data() })); rerender(); }, showErr)
  ];
}
function showErr(e) { console.error(e); toast(arErr(e), "err"); }

root.innerHTML = `
  <h2>إدارة مواعيد الفروع</h2>
  <p class="sub">العربيات والليدرز (ثابتين) والمناديب (يوم بيوم)، ومراجعة اللي اتبعت وإرساله للشيت. البيانات بتتحدّث لحظيًا.</p>
  <div class="tabs">
    <button class="tab" data-t="review"><i class="fa-solid fa-list-check"></i> مراجعة اليوم</button>
    <button class="tab" data-t="setup"><i class="fa-solid fa-truck"></i> العربيات والفروع</button>
    <button class="tab" data-t="reps"><i class="fa-solid fa-people-carry-box"></i> المناديب</button>
    <button class="tab" data-t="dockrep"><i class="fa-solid fa-warehouse"></i> تقرير المخزن</button>
    <button class="tab" data-t="bridge"><i class="fa-solid fa-table"></i> ربط الشيت</button>
  </div><div id="tabBody"></div>`;
root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; paint(); });

function paint() {
  root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
  if (tab === "review") paintReview(); else if (tab === "setup") paintSetup(); else if (tab === "reps") paintReps();
  else if (tab === "dockrep") paintDockReport(); else paintBridge();
}

/* ================================================================== تصدير / نسخ احتياطي */
async function exportDayXlsx() {
  const X = await loadXLSX();
  const rows = [["Truck", "In Docks", "Out Docks", "Fps Store Name", "Arrival Schedule", "Arrival time", "End time", "Status", "Comment", "Sent by", "Role", "Sent at"]];
  trucks.forEach(t => {
    const d = docks.find(x => x.truckId === t.id);
    branches.filter(b => b.truckId === t.id).sort(byOrder).forEach((b, i) => {
      const e = entryOf(b);
      rows.push([i === 0 ? t.name : "", i === 0 && d ? hm(d.inTime) : "", i === 0 && d ? hm(d.outTime) : "", b.sheetName || b.name, hm(b.time),
        e ? (e.holiday ? 0 : hm(e.arrival)) : "", e ? (e.holiday ? 0 : hm(e.end)) : "", statusText(e), e && e.late ? e.note || "" : "",
        e ? e.by || uname(e.uid) : "", e ? roleTxt(e.role) : "", e ? cairoStr(e.sentAt) : ""]);
    });
  });
  const dk = [["Truck", "In", "Out", "By", "Sent at"]];
  docks.forEach(d => dk.push([(T(d.truckId) || {}).name || d.truckId, hm(d.inTime), hm(d.outTime), uname(d.uid), cairoStr(d.sentAt)]));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), tabName(day).replace("/", "-"));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(dk), "Docks");
  save(xlsxBlob(X, wb), `Schedule_${day}.xlsx`);
  logActivity("admin", "تصدير إكسيل ليوم " + day); toast("اتنزّل ملف الإكسيل ✓");
}
async function backupAll(kind) {
  const [e, d, a] = await Promise.all([getDocs(collection(db, "entries")), getDocs(collection(db, "docks")), getDocs(collection(db, "assign"))]);
  const ents = e.docs.map(x => ({ id: x.id, ...x.data() })), dks = d.docs.map(x => ({ id: x.id, ...x.data() })), asg = a.docs.map(x => ({ id: x.id, ...x.data() }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  if (kind === "json") {
    const clean = o => { const r = {}; Object.entries(o).forEach(([k, v]) => { r[k] = v && v.toDate ? isoStr(v) : v; }); return r; };
    const data = { app: "branch-schedule", version: 2, exportedAt: new Date().toISOString(), trucks: trucks.map(clean), branches: branches.map(clean),
      people: users.filter(u => u.sched).map(u => ({ uid: u.uid, name: u.name, employeeId: u.employeeId || null, sched: u.sched })),
      assign: asg.map(clean), entries: ents.map(clean), docks: dks.map(clean) };
    save(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), `schedule-backup-${stamp}.json`);
  } else {
    const X = await loadXLSX(), wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Truck", "Load time", "Leaders (fixed)"], ...trucks.map(t => [t.name, hm(t.loadTime), (t.leaders || []).map(uname).join(", ")])]), "Trucks");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Branch", "Name in sheet", "Truck", "Arrival schedule", "Order"],
      ...branches.map(b => [b.name, b.sheetName || "", (T(b.truckId) || {}).name || "", hm(b.time), b.order || 0])]), "Branches");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Truck", "Rep", "Assigned at"],
      ...asg.sort((x, y) => x.date.localeCompare(y.date)).map(x => [x.date, (T(x.truckId) || {}).name || x.truckId, x.repName || uname(x.rep), cairoStr(x.at)])]), "Rep assignments");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Branch", "Truck", "Sent by", "Role", "Holiday", "Arrival schedule", "Arrival", "End", "Status", "Note", "Sent at", "Archived"],
      ...ents.sort((x, y) => x.date.localeCompare(y.date)).map(x => { const b = B(x.branchId) || {}; return [x.date, b.sheetName || b.name || x.branchId, (T(b.truckId) || {}).name || "",
        x.by || uname(x.uid), roleTxt(x.role), x.holiday ? "yes" : "", hm(x.schedTime), hm(x.arrival), hm(x.end), statusText(x), x.note || "", cairoStr(x.sentAt), x.status === "archived" ? "yes" : ""]; })]), "Entries");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Truck", "In", "Out", "By", "Sent at"],
      ...dks.sort((x, y) => x.date.localeCompare(y.date)).map(x => [x.date, (T(x.truckId) || {}).name || x.truckId, hm(x.inTime), hm(x.outTime), uname(x.uid), cairoStr(x.sentAt)])]), "Docks");
    save(xlsxBlob(X, wb), `schedule-backup-${stamp}.xlsx`);
  }
  logActivity("admin", "نسخة احتياطية (" + kind + ")"); toast("اتنزّلت النسخة الاحتياطية ✓");
}

/* ================================================================== العربيات والفروع */
function paintSetup() {
  const leaders = users.filter(u => u.sched === "leader");
  const q = leaderQ.trim().toLowerCase();
  const found = q ? leaders.filter(u => (u.name + " " + empId(u)).toLowerCase().includes(q)) : [];
  const repToday = t => { const a = assignToday.find(x => x.truckId === t.id); return a ? a.repName || uname(a.rep) : ""; };
  $("tabBody").innerHTML = `
  <div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><b>تعيين ليدر على عربيات</b><div class="mini">الليدر ثابت على عربياته لحد ما أنت تغيّره. ابحث عنه واختار عربياته.</div></div></div>
    <div style="padding:14px 18px"><input id="ldQ" value="${esc(leaderQ)}" placeholder="ابحث عن ليدر بالاسم أو الرقم الوظيفي..." style="width:100%;max-width:460px;padding:11px 14px;border:2px solid var(--line);border-radius:12px;background:transparent">
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">${found.map(u => `<button class="btn ghost sm" data-a="lt" data-id="${u.uid}"><i class="fa-solid fa-user-tie"></i> ${esc(u.name)} <span class="mini">${esc(empId(u))} · ${trucks.filter(t => (t.leaders || []).includes(u.uid)).length} عربية</span></button>`).join("")
        || (q ? '<span class="mini">مفيش ليدر بالاسم ده. اتأكد إن دوره "ليدر" من تاب المستخدمين.</span>' : `<span class="mini">${leaders.length} ليدر متاحين. اكتب جزء من الاسم.</span>`)}</div></div></div>

  <div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><b>العربيات</b><div class="mini">الليدر ثابت. المندوب بتعيّنه ليوم معيّن، وبعد اليوم ده الخانة بتفضى وتعيّن مندوب جديد.</div></div><div class="sp"></div>
    <button class="btn sm" id="btnTruck"><i class="fa-solid fa-plus"></i> عربية جديدة</button>
    <button class="btn ghost sm" id="btnImport"><i class="fa-solid fa-file-import"></i> استيراد جماعي</button>
    <button class="btn ghost sm" id="btnBkX"><i class="fa-solid fa-file-excel"></i> نسخة احتياطية (Excel)</button>
    <button class="btn ghost sm" id="btnBkJ"><i class="fa-solid fa-file-code"></i> نسخة احتياطية (JSON)</button></div>
    <div class="table-wrap"><table><thead><tr><th>العربية</th><th>ميعاد التحميل</th><th>الفروع</th><th>الليدر (ثابت)</th><th>مندوب النهارده</th><th>إجراءات</th></tr></thead><tbody>
    ${trucks.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${fmt12(t.loadTime)}</td><td>${branches.filter(b => b.truckId === t.id).length}</td>
      <td style="white-space:normal">${(t.leaders || []).map(l => esc(uname(l))).join("، ") || '<span class="mini">لسه</span>'}</td>
      <td>${repToday(t) ? `<span class="badge ok">${esc(repToday(t))}</span>` : '<span class="mini">مفيش</span>'}</td>
      <td><div class="acts"><button class="btn sm" data-a="rep" data-id="${t.id}"><i class="fa-solid fa-user-plus"></i> تعيين مندوب</button>
        <button class="btn ghost sm" data-a="ld" data-id="${t.id}">الليدر</button>
        <button class="btn ghost sm" data-a="et" data-id="${t.id}">تعديل</button><button class="btn ghost sm" data-a="dt" data-id="${t.id}">مسح</button></div></td></tr>`).join("")
      || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">مفيش عربيات لسه</td></tr>'}</tbody></table></div></div>

  <div class="panel"><div class="panel-head"><div><b>الفروع</b><div class="mini">الاسم في الشيت لازم يكون زي عمود Fps Store Name بالظبط</div></div><div class="sp"></div>
    <button class="btn sm" id="btnBranch"><i class="fa-solid fa-plus"></i> فرع جديد</button></div>
    <div class="table-wrap"><table><thead><tr><th>الفرع</th><th>الاسم في الشيت</th><th>العربية</th><th>ميعاد الوصول</th><th>الترتيب</th><th>إجراءات</th></tr></thead><tbody>
    ${[...branches].sort((a, b) => (T(a.truckId) ? String(T(a.truckId).loadTime) : "zz").localeCompare(T(b.truckId) ? String(T(b.truckId).loadTime) : "zz") || byOrder(a, b)).map(b => `<tr>
      <td>${esc(b.name)}</td><td dir="ltr" style="text-align:right">${esc(b.sheetName || "")}</td><td>${esc((T(b.truckId) || {}).name || "—")}</td>
      <td>${fmt12(b.time)}</td><td>${b.order || 0}</td>
      <td><div class="acts"><button class="btn ghost sm" data-a="eb" data-id="${b.id}">تعديل</button><button class="btn ghost sm" data-a="db" data-id="${b.id}">مسح</button></div></td></tr>`).join("")
      || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">مفيش فروع لسه</td></tr>'}</tbody></table></div></div>`;

  const ld = $("ldQ"); ld.oninput = () => { leaderQ = ld.value; paintSetup(); const n = $("ldQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $("btnTruck").onclick = () => truckModal(); $("btnBranch").onclick = () => branchModal(); $("btnImport").onclick = importModal;
  $("btnBkX").onclick = guarded(() => backupAll("xlsx")); $("btnBkJ").onclick = guarded(() => backupAll("json"));
  $("tabBody").querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
    const id = b.dataset.id, a = b.dataset.a;
    if (a === "et") truckModal(T(id)); if (a === "eb") branchModal(B(id));
    if (a === "lt") leaderTrucksModal(U(id)); if (a === "ld") truckLeadersModal(T(id)); if (a === "rep") repModal(T(id));
    if (a === "dt") { if (branches.some(x => x.truckId === id)) return toast("فيه فروع على العربية دي. انقلها أو امسحها الأول.", "err"); delTruck(id); }
    if (a === "db") delBranch(id);
  });
}
async function delTruck(id) {
  if (!(await confirmBox("مسح عربية", `<p>هتمسح <b>${esc(T(id).name)}</b>؟</p>`, { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "trucks", id)); logActivity("admin", "مسح عربية " + T(id).name); toast("اتمسحت");
}
async function delBranch(id) {
  if (!(await confirmBox("مسح فرع", `<p>هتمسح <b>${esc(B(id).name)}</b> من النظام؟ البيانات القديمة المبعوتة هتفضل موجودة.</p>`, { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "branches", id)); logActivity("admin", "مسح فرع " + B(id).name); toast("اتمسح");
}
function truckModal(t) {
  modal(t ? "تعديل عربية" : "عربية جديدة", `
    <div class="field"><label>اسم العربية</label><input name="name" required value="${esc(t ? t.name : "")}" placeholder="Truck 1"></div>
    <div class="field"><label>ميعاد تحميلها من المخزن</label>${timeField("loadTime", t ? t.loadTime : "")}</div>`, {
    async onSubmit(f) {
      const name = f.elements.name.value.trim(), loadTime = f.elements.loadTime.value;
      if (!name || !loadTime) throw new Error("اكتب الاسم واختار الميعاد.");
      if (t) await updateDoc(doc(db, "trucks", t.id), { name, loadTime }); else await addDoc(collection(db, "trucks"), { name, loadTime, leaders: [], leaderNames: [] });
      toast("اتحفظ ✓");
    }
  });
}
function branchModal(b) {
  modal(b ? "تعديل فرع" : "فرع جديد", `
    <div class="field"><label>اسم الفرع (للعرض)</label><input name="name" required value="${esc(b ? b.name : "")}"></div>
    <div class="field"><label>اسمه في الشيت بالظبط</label><input name="sheetName" dir="ltr" required value="${esc(b ? b.sheetName || b.name : "")}"><small>زي ما هو مكتوب في عمود Fps Store Name</small></div>
    <div class="row"><div class="field"><label>العربية</label><select name="truckId" required><option value="">اختار...</option>
      ${trucks.map(t => `<option value="${t.id}" ${b && b.truckId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="field"><label>ميعاد الوصول المطلوب</label>${timeField("time", b ? b.time : "")}</div>
    <div class="field"><label>الترتيب جوه العربية</label><input name="order" type="number" min="0" value="${b ? b.order || 0 : 0}"></div></div>`, {
    async onSubmit(f) {
      const data = { name: f.elements.name.value.trim(), sheetName: f.elements.sheetName.value.trim(), truckId: f.elements.truckId.value, time: f.elements.time.value, order: +f.elements.order.value || 0 };
      if (!data.name || !data.sheetName || !data.truckId || !data.time) throw new Error("كمّل كل الخانات المطلوبة.");
      if (b) await updateDoc(doc(db, "branches", b.id), data); else await addDoc(collection(db, "branches"), data);
      toast("اتحفظ ✓");
    }
  });
}
// الليدر ثابت: بنعدّل trucks.leaders (+ أسماؤهم عشان تظهر للمندوب)
async function setLeaders(batch, t, ids) {
  batch.update(doc(db, "trucks", t.id), { leaders: ids, leaderNames: ids.map(uname) });
}
function leaderTrucksModal(u) {   // من شريط البحث: نعلّم على عربيات الليدر
  modal("عربيات الليدر: " + u.name, `
    <p class="mini">علّم على العربيات اللي الليدر ده مسؤول عنها. ثابتة لحد ما تغيّرها.</p>
    <div class="checks" style="grid-template-columns:1fr">${trucks.map(t => `<label><input type="checkbox" name="tr" value="${t.id}" ${(t.leaders || []).includes(u.uid) ? "checked" : ""}> ${esc(t.name)} <span class="mini">تحميل ${fmt12(t.loadTime)}</span></label>`).join("") || "<small>مفيش عربيات</small>"}</div>`, {
    async onSubmit(f) {
      const sel = new Set([...f.querySelectorAll("[name=tr]:checked")].map(x => x.value));
      const batch = writeBatch(db); let n = 0;
      trucks.forEach(t => {
        const has = (t.leaders || []).includes(u.uid), want = sel.has(t.id);
        if (has === want) return;
        setLeaders(batch, t, want ? [...(t.leaders || []), u.uid] : (t.leaders || []).filter(x => x !== u.uid)); n++;
      });
      if (n) await batch.commit();
      toast("اتحفظ ✓");
    }
  });
}
function truckLeadersModal(t) {   // من العربية: نختار ليدرزها
  const leaders = users.filter(u => u.sched === "leader");
  modal("ليدر العربية: " + t.name, userPickList(leaders, "ld", "checkbox", new Set(t.leaders || [])), {
    onMount: wirePick,
    async onSubmit(f) {
      const ids = [...f.querySelectorAll("[name=ld]:checked")].map(x => x.value);
      const batch = writeBatch(db); await setLeaders(batch, t, ids); await batch.commit(); toast("اتحفظ ✓");
    }
  });
}
function repModal(t) {   // تعيين مندوب على العربية في يوم (الافتراضي النهارده)
  const reps = users.filter(u => u.sched === "rep");
  const cur = assignToday.find(a => a.truckId === t.id);
  const m = modal("تعيين مندوب: " + t.name, `
    <div class="field"><label>اليوم</label><input type="date" name="date" value="${cairoToday()}" required></div>
    ${userPickList(reps, "rep", "radio", new Set(cur ? [cur.rep] : []))}
    ${cur ? '<button type="button" class="btn ghost sm" data-clear style="margin-top:8px"><i class="fa-solid fa-user-minus"></i> إزالة التعيين في اليوم المختار</button>' : ""}`, {
    submitText: "تعيين", onMount: f => { wirePick(f); const c = f.querySelector("[data-clear]"); if (c) c.onclick = async () => {
      await deleteDoc(doc(db, "assign", `${f.elements.date.value}_${t.id}`)); logActivity("admin", `إزالة تعيين مندوب من ${t.name} (${f.elements.date.value})`); toast("اتشال التعيين"); m.close(); }; },
    async onSubmit(f) {
      const date = f.elements.date.value, r = (f.querySelector("[name=rep]:checked") || {}).value;
      if (!date || !r) throw new Error("اختار المندوب واليوم.");
      await setDoc(doc(db, "assign", `${date}_${t.id}`), { date, truckId: t.id, rep: r, repName: uname(r), assignedBy: uid, at: serverTimestamp() });
      toast(`اتعيّن ${uname(r)} على ${t.name} ✓`);
    }
  });
}
function importModal() {
  modal("استيراد جماعي للفروع", `
    <p class="mini">سطر لكل فرع بالشكل: <b>اسم العربية | ميعاد الوصول | الاسم في الشيت</b><br>مثال: <span class="mono">Truck 1 | 06:30 | Breadfast Coffee - Chillout El Rehab</span><br>
    العربيات الجديدة بتتعمل أوتوماتيك (ميعاد تحميلها 00:00 لحد ما تعدّله). الليدرز بتعيّنهم بعد كده للعربية.</p>
    <div class="field"><textarea class="code" name="txt" dir="ltr" required style="min-height:260px"></textarea></div>`, {
    submitText: "استيراد", wide: true,
    async onSubmit(f) {
      const lines = f.elements.txt.value.split("\n").map(l => l.trim()).filter(Boolean), bad = [], rows = [];
      lines.forEach((l, i) => {
        const p = l.split("|").map(x => x.trim()), tm = (p[1] || "").replace(/^(\d):/, "0$1:");
        if (p.length < 3 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm) || !p[0] || !p[2]) bad.push(i + 1); else rows.push({ truck: p[0], time: tm, sheet: p[2] });
      });
      if (bad.length) throw new Error("فيه سطور غلط (رقم السطر): " + bad.join("، "));
      const tmap = {}; trucks.forEach(t => { tmap[t.name.toLowerCase()] = t.id; });
      for (const r of rows) if (!tmap[r.truck.toLowerCase()]) tmap[r.truck.toLowerCase()] = (await addDoc(collection(db, "trucks"), { name: r.truck, loadTime: "00:00", leaders: [], leaderNames: [] })).id;
      const order = {}, known = new Set(branches.map(b => (b.sheetName || "").toLowerCase())), batch = writeBatch(db); let n = 0;
      rows.forEach(r => {
        if (known.has(r.sheet.toLowerCase())) return;
        const tid = tmap[r.truck.toLowerCase()]; order[tid] = (order[tid] || 0) + 1;
        batch.set(doc(collection(db, "branches")), { name: r.sheet.replace(/^breadfast coffee\s*-\s*/i, ""), sheetName: r.sheet, truckId: tid, time: r.time, order: order[tid] }); n++;
      });
      await batch.commit(); toast(`اتضاف ${n} فرع ✓`);
    }
  });
}

/* ================================================================== مراجعة اليوم */
function paintReview() {
  const all = [...entries, ...docks], allArch = all.length && all.every(x => x.status === "archived");
  $("tabBody").innerHTML = `
    <div class="datebar"><label class="dl">اليوم:</label><input type="date" id="dayIn" value="${day}">
      <span class="dl">${dayLabel(day)}</span><span class="mini">(تاب الشيت: ${tabName(day)})</span>
      ${allArch ? '<span class="badge ok">اتبعت للشيت واتأرشف</span>' : ""}
      <div class="grow-sp"></div>
      <button class="btn ghost" id="btnXlsx" ${all.length ? "" : "disabled"}><i class="fa-solid fa-file-excel"></i> تصدير إكسيل لليوم</button>
      <button class="btn" id="btnSheet" ${all.length ? "" : "disabled"}><i class="fa-solid fa-table"></i> إرسال للشيت</button></div>
    <div id="revMsg" class="msg hidden"></div>
    ${trucks.map(t => {
      const d = docks.find(x => x.truckId === t.id), a = assignDay.find(x => x.truckId === t.id);
      const brs = branches.filter(b => b.truckId === t.id).sort(byOrder);
      return `<div class="truck"><div class="truck-h"><i class="fa-solid fa-truck"></i> ${esc(t.name)} <small>تحميل ${fmt12(t.loadTime)}</small>
        ${(t.leaders || []).length ? `<span class="badge wait">الليدر: ${esc((t.leaders || []).map(uname).join("، "))}</span>` : ""}
        ${a ? `<span class="badge ok">المندوب: ${esc(a.repName || uname(a.rep))}</span>` : '<span class="badge late">مفيش مندوب</span>'}
        <span class="sp"></span>
        ${d ? `<span>مخزن: دخول <b>${fmt12(d.inTime)}</b> / خروج <b>${fmt12(d.outTime)}</b> <small>(${esc(uname(d.uid))} ${tsLabel(d.sentAt)})</small></span>
          <button class="btn ghost sm" data-a="ed" data-id="${d.id}">تعديل</button><button class="btn ghost sm" data-a="dd" data-id="${d.id}">مسح</button>`
        : `<small>مفيش تسجيل مخزن</small> <button class="btn ghost sm" data-a="ad" data-id="${t.id}">إضافة</button>`}</div>
        <div class="table-wrap"><table><thead><tr><th>الفرع</th><th>الميعاد</th><th>وصول</th><th>انتهاء</th><th>الحالة</th><th>السبب</th><th>بواسطة / وقت الإرسال</th><th></th></tr></thead><tbody>
        ${brs.map(b => {
          const e = entryOf(b);
          if (!e) return `<tr><td>${esc(b.name)}</td><td>${fmt12(b.time)}</td><td colspan="5" style="color:var(--muted)">لسه مش مبعوت</td><td><button class="btn ghost sm" data-a="ae" data-id="${b.id}">إضافة</button></td></tr>`;
          return `<tr><td>${esc(b.name)}</td><td>${fmt12(e.schedTime)}</td><td>${e.holiday ? "—" : fmt12(e.arrival)}</td><td>${e.holiday ? "—" : fmt12(e.end)}</td><td>${badge(e)}</td>
            <td style="white-space:normal;min-width:160px">${esc(e.note || "")}</td>
            <td>${esc(e.by || uname(e.uid))} <span class="badge wait">${roleTxt(e.role)}</span> <span class="mini">${tsLabel(e.sentAt)}</span>${e.editedAt ? ' <span class="badge wait">اتعدّل</span>' : ""}</td>
            <td><div class="acts"><button class="btn ghost sm" data-a="ee" data-id="${e.id}">تعديل</button><button class="btn ghost sm" data-a="de" data-id="${e.id}">مسح</button></div></td></tr>`;
        }).join("") || '<tr><td colspan="8" style="color:var(--muted);text-align:center">مفيش فروع على العربية دي</td></tr>'}
        </tbody></table></div></div>`;
    }).join("") || '<div class="empty">عرّف العربيات والفروع الأول من تاب "العربيات والفروع".</div>'}`;
  $("dayIn").onchange = e => { day = e.target.value || cairoToday(); entries = []; docks = []; assignDay = []; watchDay(); paintReview(); };
  $("btnSheet").onclick = sendToSheet; $("btnXlsx").onclick = guarded(exportDayXlsx);
  $("tabBody").querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
    const a = b.dataset.a, id = b.dataset.id;
    if (a === "ee") entryModal(entries.find(x => x.id === id)); if (a === "ae") entryModal(null, B(id)); if (a === "de") delEntry(id);
    if (a === "ed") dockModal(docks.find(x => x.id === id)); if (a === "ad") dockModal(null, T(id)); if (a === "dd") delDock(id);
  });
}
function entryModal(e, branch) {
  const b = e ? B(e.branchId) || { name: "(فرع اتشال)", time: e.schedTime } : branch;
  modal((e ? "تعديل بيانات " : "إضافة بيانات ") + b.name, `
    <div class="row"><div class="field"><label>وصول</label>${timeField("arr", e ? e.arrival : "")}</div>
    <div class="field"><label>انتهاء</label>${timeField("end", e ? e.end : "")}</div></div>
    <div class="field"><label class="hol"><input type="checkbox" name="hol" ${e && e.holiday ? "checked" : ""}> الفرع إجازة (هيتكتب 0 في الشيت)</label></div>
    <div class="field"><label>السبب / ملاحظة</label><textarea name="note" rows="3">${esc(e ? e.note || "" : "")}</textarea></div>`, {
    async onSubmit(f) {
      const hol = f.elements.hol.checked, arrival = hol ? null : f.elements.arr.value || null, end = hol ? null : f.elements.end.value || null, note = f.elements.note.value.trim();
      const sched = e ? e.schedTime : b.time;
      if (e) await updateDoc(doc(db, "entries", e.id), { arrival, end, holiday: hol, note, late: isLate(arrival, sched), editedBy: uid, editedAt: serverTimestamp() });
      else await setDoc(doc(db, "entries", `${day}_${b.id}`), { date: day, branchId: b.id, uid, by: myName, role: "admin", arrival, end, holiday: hol, note, late: isLate(arrival, sched),
        schedTime: sched, sentAt: serverTimestamp(), sid: "admin", status: "sent", addedByAdmin: true });
      toast("اتحفظ ✓");
    }
  });
}
async function delEntry(id) {
  if (!(await confirmBox("مسح بيانات", "<p>هتمسح البيانات دي نهائيًا؟ الفرع هيرجع للمطلوب عند اللي كان بيبعته.</p>", { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "entries", id)); logActivity("admin", "مسح بيانات فرع " + id); toast("اتمسحت");
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
      toast("اتحفظ ✓");
    }
  });
}
async function delDock(id) {
  if (!(await confirmBox("مسح", "<p>هتمسح تسجيل المخزن ده؟</p>", { danger: true, submitText: "مسح" }))) return;
  await deleteDoc(doc(db, "docks", id)); toast("اتمسح");
}
async function sendToSheet() {
  if (!bridge.url || !bridge.secret) return toast("اضبط رابط الشيت والمفتاح الأول من تاب \"ربط الشيت\".", "err");
  const rows = [], missing = [];
  branches.forEach(b => {
    const e = entryOf(b);
    if (!e) { missing.push(b.name); return; }
    rows.push({ name: b.sheetName || b.name, arrival: e.arrival || null, end: e.end || null, holiday: !!e.holiday, comment: e.late && e.note ? e.note : "" });
  });
  const dk = docks.map(d => ({ names: branches.filter(b => b.truckId === d.truckId).map(b => b.sheetName || b.name), in: d.inTime, out: d.outTime || null }));
  const ok = await confirmBox("إرسال للشيت", `
    <p>هتتكتب بيانات <b>${rows.length}</b> فرع و<b>${dk.length}</b> عربية في تاب <b>${tabName(day)}</b>.</p>
    ${missing.length ? `<div class="msg info" style="white-space:normal">فروع مفيهاش بيانات (مش هتتكتب): ${missing.map(esc).join("، ")}</div>` : ""}
    <p class="mini">بعد الإرسال الناجح اليوم ده بيتنقل للمهام المكتملة عند الليدرز والمناديب.</p>`, { submitText: "إرسال" });
  if (!ok) return;
  const btn = $("btnSheet"); btn.disabled = true; const box = $("revMsg");
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
    logActivity("sheet", `إرسال للشيت: تاب ${tabName(day)} (${rows.length} فرع، ${dk.length} عربية)`);
    message($("revMsg"), `<b>اتبعت للشيت ✓</b> اتكتب ${j.written || 0} خانة.` +
      (j.notFound && j.notFound.length ? `<br>الفروع دي مالقيتش اسمها في الشيت: <b>${j.notFound.map(esc).join("، ")}</b>. راجع "الاسم في الشيت".` : ""), j.notFound && j.notFound.length ? "info" : "ok");
  } catch (e) {
    btn.disabled = false;
    message(box, "تعذر قراءة رد الشيت. افتح الشيت وتأكد لو البيانات اتكتبت قبل ما تبعت تاني. " + esc(e.message || ""), "err");
  }
}

/* ================================================================== المناديب (سجل التعيينات + تقرير) */
let rpFrom = null, rpTo = cairoToday(), rpRep = "", rpTruck = "", rpRows = [];
async function paintReps() {
  if (!rpFrom) rpFrom = addDays(rpTo, -6);
  const sel = "padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:transparent";
  $("tabBody").innerHTML = `
    <div class="datebar"><label class="dl">من:</label><input type="date" id="rpFrom" value="${rpFrom}"><label class="dl">إلى:</label><input type="date" id="rpTo" value="${rpTo}">
      <select id="rpRep" style="${sel}"><option value="">كل المناديب</option>${users.filter(u => u.sched === "rep").map(u => `<option value="${u.uid}" ${rpRep === u.uid ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
      <select id="rpTruck" style="${sel}"><option value="">كل العربيات</option>${trucks.map(t => `<option value="${t.id}" ${rpTruck === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <div class="grow-sp"></div><button class="btn ghost" id="rpXlsx"><i class="fa-solid fa-file-excel"></i> تصدير إكسيل</button></div>
    <div id="rpBody"><div class="empty">جاري التحميل...</div></div>`;
  const reload = async () => {
    rpFrom = $("rpFrom").value || rpFrom; rpTo = $("rpTo").value || rpTo; rpRep = $("rpRep").value; rpTruck = $("rpTruck").value;
    if (rpFrom > rpTo) { [rpFrom, rpTo] = [rpTo, rpFrom]; $("rpFrom").value = rpFrom; $("rpTo").value = rpTo; }
    try {
      const rng = c => query(collection(db, c), where("date", ">=", rpFrom), where("date", "<=", rpTo));
      const [a, e] = await Promise.all([getDocs(rng("assign")), getDocs(rng("entries"))]);
      const ents = e.docs.map(x => x.data());
      rpRows = a.docs.map(x => x.data()).filter(a => (!rpRep || a.rep === rpRep) && (!rpTruck || a.truckId === rpTruck)).sort((x, y) => y.date.localeCompare(x.date)).map(a => {
        const bs = branches.filter(b => b.truckId === a.truckId), ids = new Set(bs.map(b => b.id));
        const mine = ents.filter(x => x.date === a.date && ids.has(x.branchId) && x.uid === a.rep), other = ents.filter(x => x.date === a.date && ids.has(x.branchId) && x.uid !== a.rep);
        const ms = mine.map(x => tsMs(x.sentAt)).filter(Boolean);
        return { a, total: bs.length, mine: mine.length, other: other.length, first: ms.length ? Math.min(...ms) : 0, last: ms.length ? Math.max(...ms) : 0 };
      });
      renderReps();
    } catch (er) { $("rpBody").innerHTML = `<div class="msg err">${esc(arErr(er))}</div>`; }
  };
  ["rpFrom", "rpTo", "rpRep", "rpTruck"].forEach(id => $(id).onchange = reload);
  $("rpXlsx").onclick = guarded(async () => {
    const X = await loadXLSX(), wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Rep", "Truck", "Branches", "Sent by rep", "Sent by others", "First sent", "Last sent"],
      ...rpRows.map(r => [r.a.date, r.a.repName || uname(r.a.rep), (T(r.a.truckId) || {}).name || "", r.total, r.mine, r.other, r.first ? cairoStr({ toDate: () => new Date(r.first) }) : "", r.last ? cairoStr({ toDate: () => new Date(r.last) }) : ""])]), "Reps");
    save(xlsxBlob(X, wb), `Reps_${rpFrom}_${rpTo}.xlsx`); toast("اتنزّل التقرير ✓");
  });
  await reload();
}
function renderReps() {
  const rows = rpRows;
  const per = {}; rows.forEach(r => { const k = r.a.rep; (per[k] = per[k] || { n: 0, sent: 0, last: "", truck: "" }); per[k].n++; per[k].sent += r.mine; if (r.a.date >= per[k].last) { per[k].last = r.a.date; per[k].truck = (T(r.a.truckId) || {}).name || ""; } });
  const tm = ms => ms ? new Date(ms).toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit" }) : "—";
  $("rpBody").innerHTML = rows.length ? `
    ${Object.keys(per).length > 1 ? `<div class="panel" style="margin-bottom:16px"><div class="panel-head"><b>ملخص لكل مندوب</b></div><div class="table-wrap"><table><thead><tr><th>المندوب</th><th>عدد التعيينات</th><th>فروع بعتها</th><th>آخر عربية</th></tr></thead><tbody>
      ${Object.entries(per).map(([k, v]) => `<tr><td>${esc(uname(k))}</td><td>${v.n}</td><td>${v.sent}</td><td>${esc(v.truck)} <span class="mini">${v.last}</span></td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>اليوم</th><th>المندوب</th><th>العربية</th><th>فروعها</th><th>بعتها المندوب</th><th>بعتها حد تاني</th><th>أول إرسال</th><th>آخر إرسال</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${dayLabel(r.a.date)}</td><td>${esc(r.a.repName || uname(r.a.rep))}</td><td>${esc((T(r.a.truckId) || {}).name || "—")}</td><td>${r.total}</td>
      <td>${r.mine}${r.mine < r.total ? ` <span class="badge wait">ناقص ${r.total - r.mine - r.other < 0 ? 0 : r.total - r.mine - r.other}</span>` : ""}</td><td>${r.other}</td><td>${tm(r.first)}</td><td>${tm(r.last)}</td></tr>`).join("")}
    </tbody></table></div></div>` : '<div class="empty">مفيش تعيينات مناديب في الفترة دي.</div>';
}

/* ================================================================== تقرير المخزن */
let repFrom = null, repTo = cairoToday(), repTruck = "", repRows = [];
function repData() {
  return repRows.filter(d => !repTruck || d.truckId === repTruck).sort((a, b) => b.date.localeCompare(a.date) || (T(a.truckId) ? String(T(a.truckId).loadTime) : "").localeCompare(T(b.truckId) ? String(T(b.truckId).loadTime) : ""))
    .map(d => { const t = T(d.truckId) || { name: "(عربية اتشالت)", loadTime: "" };
      return { d, t, dur: d.outTime ? durMin(d.inTime, d.outTime) : null, diff: t.loadTime ? toMin(d.inTime) - toMin(t.loadTime) : null }; });
}
async function paintDockReport() {
  if (!repFrom) repFrom = addDays(repTo, -6);
  $("tabBody").innerHTML = `
    <div class="datebar"><label class="dl">من:</label><input type="date" id="rpFrom" value="${repFrom}"><label class="dl">إلى:</label><input type="date" id="rpTo" value="${repTo}">
      <label class="dl">العربية:</label><select id="rpTruck" style="padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:transparent">
        <option value="">كل العربيات</option>${trucks.map(t => `<option value="${t.id}" ${repTruck === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <div class="grow-sp"></div><button class="btn ghost" id="rpXlsx"><i class="fa-solid fa-file-excel"></i> تصدير إكسيل</button></div>
    <div id="rpBody"><div class="empty">جاري التحميل...</div></div>`;
  const reload = async () => {
    repFrom = $("rpFrom").value || repFrom; repTo = $("rpTo").value || repTo; repTruck = $("rpTruck").value;
    if (repFrom > repTo) { [repFrom, repTo] = [repTo, repFrom]; $("rpFrom").value = repFrom; $("rpTo").value = repTo; }
    try {
      const s = await getDocs(query(collection(db, "docks"), where("date", ">=", repFrom), where("date", "<=", repTo)));
      repRows = s.docs.map(x => ({ id: x.id, ...x.data() })); renderRep();
    } catch (e) { $("rpBody").innerHTML = `<div class="msg err">${esc(arErr(e))}</div>`; }
  };
  ["rpFrom", "rpTo", "rpTruck"].forEach(id => $(id).onchange = reload);
  $("rpXlsx").onclick = guarded(async () => {
    const X = await loadXLSX(), wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["Date", "Truck", "Load time", "In", "Diff vs load time (min)", "Out", "Duration (min)", "By", "Sent at"],
      ...repData().map(r => [r.d.date, r.t.name, hm(r.t.loadTime), hm(r.d.inTime), r.diff == null ? "" : r.diff, hm(r.d.outTime), r.dur == null ? "" : r.dur, uname(r.d.uid), cairoStr(r.d.sentAt)])]), "Dock report");
    save(xlsxBlob(X, wb), `Dock_report_${repFrom}_${repTo}.xlsx`); toast("اتنزّل التقرير ✓");
  });
  await reload();
}
function renderRep() {
  const rows = repData(), done = rows.filter(r => r.dur != null);
  const avg = done.length ? Math.round(done.reduce((a, r) => a + r.dur, 0) / done.length) : null, late = rows.filter(r => r.diff != null && r.diff > 30).length;
  const per = trucks.filter(t => !repTruck || t.id === repTruck).map(t => {
    const rs = rows.filter(r => r.d.truckId === t.id), dn = rs.filter(r => r.dur != null), wd = rs.filter(r => r.diff != null);
    return { t, n: rs.length, avg: dn.length ? Math.round(dn.reduce((a, r) => a + r.dur, 0) / dn.length) : null, avgDiff: wd.length ? Math.round(wd.reduce((a, r) => a + r.diff, 0) / wd.length) : null };
  }).filter(x => x.n);
  $("rpBody").innerHTML = rows.length ? `
    <div class="msg info">عدد التسجيلات: <b>${rows.length}</b> — خرجت منهم: <b>${done.length}</b>${avg != null ? ` — متوسط مدة التحميل: <b>${fmtDur(avg)}</b>` : ""} — دخول متأخر عن الميعاد (أكتر من 30 د): <b>${late}</b></div>
    ${per.length > 1 ? `<div class="panel" style="margin-bottom:16px"><div class="panel-head"><b>ملخص لكل عربية</b></div><div class="table-wrap"><table><thead><tr><th>العربية</th><th>عدد المرات</th><th>متوسط مدة التحميل</th><th>متوسط الفرق عن الميعاد</th></tr></thead><tbody>
      ${per.map(x => `<tr><td>${esc(x.t.name)}</td><td>${x.n}</td><td>${x.avg != null ? fmtDur(x.avg) : "—"}</td><td>${x.avgDiff == null ? "—" : x.avgDiff > 0 ? `متأخر ${x.avgDiff} د` : x.avgDiff < 0 ? `بدري ${-x.avgDiff} د` : "في الميعاد"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>اليوم</th><th>العربية</th><th>ميعاد التحميل</th><th>دخلت</th><th>الفرق عن الميعاد</th><th>خرجت</th><th>مدة التحميل</th><th>بواسطة / وقت التسجيل</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${dayLabel(r.d.date)}</td><td>${esc(r.t.name)}</td><td>${fmt12(r.t.loadTime)}</td><td><b>${fmt12(r.d.inTime)}</b></td>
      <td>${r.diff == null ? "—" : r.diff > 30 ? `<span class="badge late">متأخر ${r.diff} د</span>` : r.diff > 0 ? `${r.diff} د` : r.diff < 0 ? `<span class="badge early">بدري ${-r.diff} د</span>` : "في الميعاد"}</td>
      <td>${r.d.outTime ? `<b>${fmt12(r.d.outTime)}</b>` : '<span class="badge wait">لسه جوه</span>'}</td><td>${r.dur != null ? fmtDur(r.dur) : "—"}</td>
      <td>${esc(uname(r.d.uid))} <span class="mini">${tsLabel(r.d.sentAt)}</span></td></tr>`).join("")}
    </tbody></table></div></div>` : '<div class="empty">مفيش تسجيلات مخزن في الفترة والعربية دي.</div>';
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
    try { bridge = { url: $("brUrl").value.trim(), secret: $("brSecret").value.trim() }; await setDoc(doc(db, "meta", "sheetBridge"), { ...bridge, updatedAt: serverTimestamp() }); logActivity("admin", "تعديل رابط الشيت"); toast("اتحفظ ✓"); }
    catch (e) { toast(arErr(e), "err"); }
  };
  $("brTest").onclick = async () => {
    const m = $("brMsg");
    try {
      const r = await fetch($("brUrl").value.trim(), { method: "POST", body: JSON.stringify({ secret: $("brSecret").value.trim(), action: "ping" }) });
      const j = await r.json(); message(m, j.ok ? "الاتصال شغال ✓" : "الرابط شغال بس المفتاح غلط.", j.ok ? "ok" : "err");
    } catch (e) { message(m, "مقدرتش أوصل للرابط. اتأكد إنه منشور (Anyone) وإنه بيخلص بـ /exec.", "err"); }
  };
}

/* ------------------------------------------------------------------ تشغيل (آخر الملف) */
booted = true;
watchStatic();
watchDay();
paint();
