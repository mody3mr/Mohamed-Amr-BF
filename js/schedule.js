// صفحة الليدر / المندوب / مندوب المخزن (لحظية: onSnapshot)
import { db } from "./firebase.js";
import {
  collection, doc, query, where, setDoc, updateDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, esc, toast, arErr, logActivity } from "./common.js";
import { getSid } from "./session.js";
import {
  $, cairoToday, cairoNowHM, addDays, toMin, isLate, lateBy, fmt12, dayLabel, tsLabel, tsMs, timeField, confirmBox, initShell
} from "./schedule-core.js";

const api = await guard();
const me = api.profile, uid = api.user.uid;
const root = $("root");
initShell(api);

/* ------------------------------------------------------------------ مشترك (function declarations عشان تترفع لفوق) */
function byOrder(a, b) { return (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)); }
function byLoad(a, b) { return String(a.loadTime).localeCompare(String(b.loadTime)); }
function statusBadge(arr, sched, holiday) {
  if (holiday) return '<span class="badge hol">إجازة</span>';
  if (!arr) return '<span class="badge wait">ناقص</span>';
  if (isLate(arr, sched)) return `<span class="badge late">متأخر +${lateBy(arr, sched)} د</span>`;
  if (toMin(arr) < toMin(sched)) return '<span class="badge early">بدري</span>';
  return '<span class="badge ok">في الميعاد</span>';
}
function watchCol(name, cb) { return onSnapshot(collection(db, name), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), e => showError(e)); }
function showError(e) {
  console.error(e);
  root.innerHTML = `<div class="msg err">تعذر تحميل البيانات.<br><small dir="ltr">${esc((e && (e.code || e.message)) || "")}</small>
    ${e && e.code === "permission-denied" ? "<br>غالبًا قواعد Firestore لسه ماتنشرتش من آخر نسخة، أو الإدارة لسه ماحدّدتش دورك. كلّم مسؤول النظام." : ""}</div>`;
}
function nowCairoMs() {   // دقيقة النهارده بتوقيت القاهرة (بالمللي) للتذكيرات
  const [h, m] = cairoNowHM().split(":").map(Number);
  return (h * 60 + m) * 60000 + new Date().getSeconds() * 1000;
}
function notify(title, body) {
  toast(title + " — " + body);
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body, icon: "assets/logo.png" }); }
      catch (_) { navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(r => r && r.showNotification(title, { body, icon: "assets/logo.png" })); }
    }
  } catch (_) {}
}
function notifBar() {   // زرار تفعيل التنبيهات (لازم ضغطة من المستخدم)
  if (!("Notification" in window) || Notification.permission !== "default") return "";
  return `<div class="msg info" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">عشان توصلك تنبيهات بميعاد كل فرع وهو لسه مش مبعوت:
    <button class="btn sm" id="btnNotif"><i class="fa-solid fa-bell"></i> تفعيل التنبيهات</button></div>`;
}
function bindNotif() {
  const b = $("btnNotif");
  if (b) b.onclick = async () => { try { await Notification.requestPermission(); } catch (_) {} paintSoon(); };
}
let paintSoon = () => {};

/* ================================================================== ليدر / مندوب */
function fieldApp(role) {
  let trucks = [], branches = [], assigns = [], assignDocs = {}, ents = {};
  let tab = "today";
  const days = { today: cairoToday(), sent: cairoToday(), done: cairoToday() };
  let ready = { trucks: false, branches: false, assigns: role === "leader" }, lastSig = "", drafts = {};
  let dayUnsubs = [], dayKey = "", timers = [], fired = new Set(), loaded = new Set(), expectedN = 0;

  root.innerHTML = `
    <h2>${role === "leader" ? "عربياتك وفروعها" : "فروع عربيتك"}</h2>
    <p class="sub">${role === "leader"
      ? "كل يوم بتشوف عربياتك وفروعها، وتعرف مين بعت، وتقدر تبعت أي فرع لسه ماتبعتش."
      : "سجّل وأرسل كل فرع لوحده. الفرع اللي بتبعته بينتقل لتاب «اللي اتبعت»."}</p>
    <div id="notifBox"></div>
    <div class="tabs">
      <button class="tab" data-t="today"><i class="fa-solid fa-pen-to-square"></i> المطلوب</button>
      <button class="tab" data-t="sent"><i class="fa-solid fa-paper-plane"></i> اللي اتبعت</button>
      <button class="tab" data-t="done"><i class="fa-solid fa-circle-check"></i> المهام المكتملة</button>
    </div><div id="tabBody"></div>`;
  root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; lastSig = ""; paint(); });

  watchCol("trucks", a => { trucks = a.sort(byLoad); ready.trucks = true; paint(); });
  watchCol("branches", a => { branches = a; ready.branches = true; paint(); });
  paintSoon = () => { lastSig = ""; paint(); };
  setInterval(() => paint(), 60000);   // تحديث "عدّى الميعاد" والتذكيرات

  const day = () => days[tab];
  function myTrucks() {
    return role === "leader" ? trucks.filter(t => (t.leaders || []).includes(uid)) : trucks.filter(t => assigns.some(a => a.truckId === t.id));
  }
  const myBranches = () => { const ids = new Set(myTrucks().map(t => t.id)); return branches.filter(b => ids.has(b.truckId)); };

  // مستمعين اليوم المعروض: assign (مندوب) + مستند لكل فرع
  function attachDay() {
    const key = day() + "|" + role + "|" + myBranches().map(b => b.id).sort().join(",") + "|" + (role === "leader" ? myTrucks().map(t => t.id).join(",") : "");
    if (key === dayKey) return; dayKey = key;
    dayUnsubs.forEach(u => u()); dayUnsubs = []; ents = {}; assignDocs = {}; loaded = new Set(); expectedN = myBranches().length; lastSig = "";
    if (role === "rep") {
      dayUnsubs.push(onSnapshot(query(collection(db, "assign"), where("rep", "==", uid), where("date", "==", day())), s => {
        const next = s.docs.map(d => ({ id: d.id, ...d.data() }));
        const sig = next.map(a => a.id).sort().join(",");
        const changed = sig !== assigns.map(a => a.id).sort().join(",");
        assigns = next; ready.assigns = true;
        if (changed) { dayKey = ""; }
        paint();
      }, showError));
    }
    myTrucks().forEach(t => { if (role === "leader") dayUnsubs.push(onSnapshot(doc(db, "assign", `${day()}_${t.id}`), s => { assignDocs[t.id] = s.exists() ? s.data() : null; paint(); }, () => {})); });
    myBranches().forEach(b => dayUnsubs.push(onSnapshot(doc(db, "entries", `${day()}_${b.id}`), s => { ents[b.id] = s.exists() ? { id: s.id, ...s.data() } : null; loaded.add(b.id); paint(); }, () => {})));
  }

  function snapshotDrafts() {
    document.querySelectorAll(".brow[data-b]").forEach(r => {
      const g = n => r.querySelector(`[name=${n}]`);
      drafts[r.dataset.b] = { arr: g("arr").value, end: g("end").value, hol: g("hol").checked, note: g("note").value };
    });
  }
  function restoreDrafts() {
    document.querySelectorAll(".brow[data-b]").forEach(r => {
      const d = drafts[r.dataset.b]; if (!d) return;
      const g = n => r.querySelector(`[name=${n}]`);
      g("arr").value = d.arr; g("end").value = d.end; g("hol").checked = d.hol; g("note").value = d.note;
      refreshRow(r);
    });
  }

  function paint() {
    root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
    if (!ready.trucks || !ready.branches) return;
    attachDay();
    if (role === "rep" && !ready.assigns) return;
    if (loaded.size < expectedN) { if (!$("tabBody").innerHTML) $("tabBody").innerHTML = '<div class="empty">جاري التحميل...</div>'; return; }   // مانعرضش حاجة قبل ما نعرف إيه اتبعت
    const today = cairoToday(), isToday = day() === today, nowMin = toMin(cairoNowHM());
    const mt = myTrucks(), mb = myBranches();
    // توقيع الحالة: لو متغيّرش مش بنعيد الرسم (عشان مانضيّعش اللي المستخدم بيكتبه)
    const sig = [tab, day(), mt.map(t => t.id + (t.name || "") + (t.loadTime || "")).join(), mb.map(b => b.id + b.time + b.name).join(),
      Object.entries(ents).map(([k, e]) => k + (e ? e.status + tsMs(e.sentAt) : "-")).sort().join(),
      Object.entries(assignDocs).map(([k, a]) => k + (a ? a.rep : "-")).sort().join(), assigns.map(a => a.repName).join(),
      tab === "today" && isToday ? mb.map(b => (nowMin > toMin(b.time) + 30 ? "L" : nowMin >= toMin(b.time) ? "T" : "-")).join("") : "",
      "Notification" in window ? Notification.permission : ""].join("|");
    if (sig === lastSig) return;
    lastSig = sig;
    snapshotDrafts();
    const keep = document.activeElement && document.activeElement.closest && document.activeElement.closest(".brow[data-b]")
      ? { b: document.activeElement.closest(".brow").dataset.b, n: document.activeElement.name } : null;
    const scroll = window.scrollY;
    render(mt, mb, today, isToday, nowMin);
    restoreDrafts();
    if (keep) { const el = document.querySelector(`.brow[data-b="${keep.b}"] [name="${keep.n}"]`); if (el) el.focus(); }
    window.scrollTo(0, scroll);
    $("notifBox").innerHTML = notifBar(); bindNotif();
    setupReminders(mb, isToday);
  }

  function repName(t) {
    if (role === "rep") return me.name;
    const a = assignDocs[t.id]; return a ? a.repName || "مندوب" : "";
  }
  function render(mt, mb, today, isToday, nowMin) {
    const body = $("tabBody");
    const wantStatus = tab === "today" ? null : tab === "sent" ? "sent" : "archived";
    const dateBar = `<div class="datebar"><label class="dl">اليوم:</label>
      <input type="date" id="dayIn" value="${day()}" ${tab === "today" ? `min="${addDays(today, -7)}"` : ""} max="${today}">
      <span class="dl">${dayLabel(day())}</span></div>`;
    if (!mt.length) {
      body.innerHTML = dateBar + `<div class="empty">${role === "leader" ? "مفيش عربيات متعيّنة ليك لسه. الإدارة هي اللي بتعيّنها، كلّمهم."
        : "مفيش عربية متعيّنة عليك في اليوم ده. استنى الإدارة تعيّنك."}</div>`;
      $("dayIn").onchange = e => { days[tab] = e.target.value || today; lastSig = ""; paint(); };
      return;
    }
    let total = 0;
    const html = mt.map(t => {
      const items = mb.filter(b => b.truckId === t.id).sort(byOrder).filter(b => {
        const e = ents[b.id];
        return wantStatus === null ? !e : e && e.status === wantStatus;
      });
      if (!items.length) return "";
      total += items.length;
      const rn = repName(t);
      return `<div class="truck"><div class="truck-h"><i class="fa-solid fa-truck"></i> ${esc(t.name)}
        <small>تحميل ${fmt12(t.loadTime)}</small>
        ${(t.leaderNames || []).length ? `<span class="badge wait">الليدر: ${esc((t.leaderNames || []).join("، "))}</span>` : ""}
        ${rn ? `<span class="badge ok">المندوب: ${esc(rn)}</span>` : (role === "leader" ? '<span class="badge late">مفيش مندوب النهارده</span>' : "")}</div>
        ${items.map(b => tab === "today" ? formRow(b, isToday, nowMin) : lockedRow(b, ents[b.id])).join("")}</div>`;
    }).join("");
    const emptyMsg = tab === "today"
      ? '<div class="msg okm">كل فروع اليوم دي اتبعتت ✓ شوفها في تاب "اللي اتبعت".</div>'
      : tab === "sent" ? '<div class="empty">مفيش فروع مبعوتة (مستنية مراجعة الإدارة) في اليوم ده.</div>'
      : '<div class="empty">مفيش مهام مكتملة في اليوم ده.</div>';
    body.innerHTML = dateBar + (total ? html : emptyMsg);
    $("dayIn").onchange = e => { days[tab] = e.target.value || today; lastSig = ""; paint(); };
    body.querySelectorAll(".brow[data-b]").forEach(r => {
      r.addEventListener("input", () => refreshRow(r)); r.addEventListener("change", () => refreshRow(r));
      r.querySelector("[data-send]").onclick = () => sendOne(r);
    });
  }

  function formRow(b, isToday, nowMin) {
    const od = isToday && nowMin > toMin(b.time) + 30 ? '<span class="badge late">عدّى الميعاد</span>'
      : isToday && nowMin >= toMin(b.time) ? '<span class="badge wait">ميعاده دلوقتي</span>' : "";
    return `<div class="brow" data-b="${b.id}">
      <div class="bn">${esc(b.name)}<small>ميعاد الفرع ${fmt12(b.time)}</small> ${od}</div>
      <div class="times">
        <label>وصول ${timeField("arr")}</label>
        <label>انتهاء ${timeField("end")}</label>
        <label class="hol"><input type="checkbox" name="hol"> الفرع إجازة</label>
        <span data-flag></span>
      </div>
      <div><textarea name="note" maxlength="300" placeholder="السبب (اختياري، وإجباري لو متأخر أو ناقص)"></textarea>
        <button class="btn sm" type="button" data-send style="margin-top:8px"><i class="fa-solid fa-paper-plane"></i> إرسال الفرع</button></div>
    </div>`;
  }
  function lockedRow(b, e) {
    return `<div class="brow locked">
      <div class="bn">${esc(b.name)}<small>ميعاد الفرع ${fmt12(b.time)}</small></div>
      <div class="times">${e.holiday ? '<span class="badge hol">الفرع إجازة</span>'
        : `<span>وصول <b>${fmt12(e.arrival)}</b></span><span>انتهاء <b>${fmt12(e.end)}</b></span>`}
        ${statusBadge(e.arrival, e.schedTime || b.time, e.holiday)}</div>
      <div>${e.note ? `<div class="mini">السبب: ${esc(e.note)}</div>` : ""}
        <span class="badge ok"><i class="fa-solid fa-lock"></i> ${esc(e.by || "")} (${e.role === "leader" ? "ليدر" : e.role === "rep" ? "مندوب" : "إدارة"}) · ${tsLabel(e.sentAt)}</span></div></div>`;
  }

  function readRow(r) {
    const hol = r.querySelector("[name=hol]").checked;
    return { b: branches.find(x => x.id === r.dataset.b), hol,
      arrival: hol ? null : r.querySelector("[name=arr]").value || null, end: hol ? null : r.querySelector("[name=end]").value || null,
      note: r.querySelector("[name=note]").value.trim() };
  }
  function refreshRow(r) {
    const hol = r.querySelector("[name=hol]").checked;
    r.querySelectorAll(".tf input, .tf button").forEach(x => { x.disabled = hol; });
    if (hol) r.querySelectorAll(".tf input").forEach(x => { x.value = ""; });
    const v = readRow(r);
    const late = isLate(v.arrival, v.b.time), inc = !hol && (!v.arrival || !v.end);
    r.querySelector("[data-flag]").innerHTML = hol ? '<span class="badge hol">إجازة</span>' : v.arrival ? statusBadge(v.arrival, v.b.time, false) : "";
    r.querySelector("[name=note]").placeholder = late ? "الفرع واصل متأخر، لازم تكتب السبب" : inc ? "في وقت ناقص، لازم تكتب السبب" : "السبب (اختياري)";
    if ((late || inc) && v.note.length >= 3) r.classList.remove("invalid");
  }

  async function sendOne(r) {
    const x = readRow(r), b = x.b;
    const late = isLate(x.arrival, b.time), inc = !x.hol && (!x.arrival || !x.end);
    if ((late || inc) && x.note.length < 3) {
      r.classList.add("invalid");
      const what = late ? `واصل متأخر ${lateBy(x.arrival, b.time)} دقيقة بعد الميعاد` : !x.arrival && !x.end ? "مفيش ميعاد وصول ولا انتهاء" : !x.arrival ? "ناقص ميعاد الوصول" : "ناقص ميعاد الانتهاء";
      toast(`${b.name}: ${what}. اكتب السبب، أو كمّل المواعيد، أو علّم الفرع إجازة.`, "err");
      r.querySelector("[name=note]").focus();
      return;
    }
    const ok = await confirmBox("تأكيد إرسال الفرع",
      `<p><b>${esc(b.name)}</b> — ${dayLabel(day())}<br>${x.hol ? "الفرع إجازة" : `وصول ${fmt12(x.arrival)} ← انتهاء ${fmt12(x.end)}`}</p><p class="mini">بعد الإرسال مفيش تعديل غير من الإدارة.</p>`, { submitText: "إرسال" });
    if (!ok) return;
    const btn = r.querySelector("[data-send]"); btn.disabled = true;
    try {
      await setDoc(doc(db, "entries", `${day()}_${b.id}`), {
        date: day(), branchId: b.id, uid, by: me.name, role, arrival: x.arrival, end: x.end, holiday: x.hol, note: x.note,
        late: isLate(x.arrival, b.time), schedTime: b.time, sentAt: serverTimestamp(), sid: getSid(), status: "sent"
      });
      delete drafts[b.id];
      logActivity("sched", `أرسل فرع ${b.name} (${day()}): ${x.hol ? "إجازة" : `${x.arrival || "-"} → ${x.end || "-"}`}`);
      toast("اتبعت ✓ وانتقل لتاب اللي اتبعت");
    } catch (e) {
      btn.disabled = false;
      toast(e && e.code === "permission-denied" ? "الإرسال اترفض: الفرع ده اتبعت قبل كده (من حد تاني)، أو العربية مش متعيّنة عليك. حدّث الصفحة." : arErr(e), "err");
    }
  }

  // تذكيرات: قبل ميعاد الفرع بـ 10 دقايق، وبعد الميعاد بـ 30 دقيقة (آخر مهلة) لو لسه مش مبعوت
  function setupReminders(mb, isToday) {
    timers.forEach(clearTimeout); timers = [];
    if (!isToday || tab !== "today") return;
    const now = nowCairoMs();
    mb.filter(b => !ents[b.id]).forEach(b => {
      [[-10, "فرع " + b.name + " ميعاده بعد 10 دقايق", "m10"], [30, "فرع " + b.name + " عدّى الميعاد بـ 30 دقيقة ولسه ماتبعتش", "p30"]].forEach(([off, msg, k]) => {
        const at = (toMin(b.time) + off) * 60000, d = at - now, key = day() + b.id + k;
        if (d > 0 && d < 864e5 && !fired.has(key)) timers.push(setTimeout(() => { fired.add(key); if (!ents[b.id]) notify("تذكير بميعاد فرع", msg); }, d));
      });
    });
  }
}

/* ================================================================== مندوب المخزن */
function durMin(a, b) { const d = toMin(b) - toMin(a); return d < 0 ? d + 1440 : d; }
function fmtDur(m) { return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د`; }

function dockApp() {
  let trucks = [], branches = [], docks = [], tab = "today", day = cairoToday(), doneDay = cairoToday(), doneAll = false;
  let ready = { trucks: false, branches: false, docks: false }, lastSig = "", dayUnsub = null, dayKey = "", allDocks = [], allUnsub = null;
  const truckOf = id => trucks.find(t => t.id === id) || { name: "(عربية اتشالت)", loadTime: "" };

  root.innerHTML = `
    <h2>تحميل العربيات</h2>
    <p class="sub">العربيات بترتيب ميعاد تحميلها. سجّل دخول العربية للمخزن وخروجها، ولما تخرج بتنتقل لوحدها للمكتمل.</p>
    <div class="tabs"><button class="tab" data-t="today"><i class="fa-solid fa-truck-ramp-box"></i> العربيات</button>
      <button class="tab" data-t="done"><i class="fa-solid fa-circle-check"></i> المكتمل</button></div>
    <div id="tabBody"></div>`;
  root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; lastSig = ""; paint(); });
  watchCol("trucks", a => { trucks = a.sort(byLoad); ready.trucks = true; paint(); });
  watchCol("branches", a => { branches = a; ready.branches = true; paint(); });

  function attach() {
    if (tab === "done") {
      const k = doneAll ? "all" : doneDay; if (k === dayKey) return; dayKey = k;
      if (dayUnsub) dayUnsub();
      const q = doneAll ? collection(db, "docks") : query(collection(db, "docks"), where("date", "==", doneDay));
      dayUnsub = onSnapshot(q, s => { allDocks = s.docs.map(d => ({ id: d.id, ...d.data() })); ready.docks = true; lastSig = ""; paint(); }, showError);
    } else {
      const k = "d" + day; if (k === dayKey) return; dayKey = k;
      if (dayUnsub) dayUnsub();
      dayUnsub = onSnapshot(query(collection(db, "docks"), where("date", "==", day)), s => { docks = s.docs.map(d => ({ id: d.id, ...d.data() })); ready.docks = true; lastSig = ""; paint(); }, showError);
    }
  }
  function paint() {
    root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
    if (!ready.trucks || !ready.branches) return;
    const before = dayKey; attach();
    if (before !== dayKey) { ready.docks = false; return; }
    if (!ready.docks) return;
    const sig = tab + "|" + (tab === "done" ? allDocks : docks).map(d => d.id + d.inTime + (d.outTime || "")).join() + trucks.map(t => t.id + t.name + t.loadTime).join();
    if (sig === lastSig) return; lastSig = sig;
    tab === "done" ? paintDone() : paintToday();
  }

  function paintDone() {
    const today = cairoToday(), body = $("tabBody");
    const list = allDocks.filter(d => d.outTime).sort((a, b) => b.date.localeCompare(a.date) || String(a.outTime).localeCompare(String(b.outTime)));
    body.innerHTML = `
      <div class="datebar"><label class="dl">اليوم:</label>
        <input type="date" id="doneIn" value="${doneDay}" max="${today}" ${doneAll ? "disabled" : ""}>
        <span class="dl">${doneAll ? "كل الأيام" : dayLabel(doneDay)}</span>
        <button class="btn ${doneAll ? "" : "ghost"} sm" id="allBtn">${doneAll ? "عرض يوم واحد" : "عرض كل الأيام"}</button></div>
      ${list.length ? `<div class="panel"><div class="table-wrap"><table><thead><tr><th>اليوم</th><th>العربية</th><th>ميعاد التحميل</th><th>دخلت</th><th>خرجت</th><th>مدة التحميل</th><th>وقت التسجيل</th></tr></thead><tbody>
        ${list.map(d => { const t = truckOf(d.truckId);
          return `<tr><td>${dayLabel(d.date)}</td><td>${esc(t.name)}</td><td>${fmt12(t.loadTime)}</td><td><b>${fmt12(d.inTime)}</b></td><td><b>${fmt12(d.outTime)}</b></td>
          <td>${fmtDur(durMin(d.inTime, d.outTime))}</td><td>${tsLabel(d.sentAt)}</td></tr>`; }).join("")}
        </tbody></table></div></div>` : '<div class="empty">مفيش عربيات اتحمّلت في الفترة دي.</div>'}`;
    $("doneIn").onchange = e => { doneDay = e.target.value || today; dayKey = ""; lastSig = ""; paint(); };
    $("allBtn").onclick = () => { doneAll = !doneAll; dayKey = ""; lastSig = ""; paint(); };
  }

  function paintToday() {
    const today = cairoToday(), body = $("tabBody");
    const loaded = docks.filter(d => d.outTime).length;
    const pending = trucks.filter(t => { const d = docks.find(x => x.truckId === t.id); return !d || !d.outTime; });
    body.innerHTML = `
      <div class="datebar"><label class="dl">اليوم:</label>
        <input type="date" id="dayIn" value="${day}" min="${addDays(today, -7)}" max="${today}"><span class="dl">${dayLabel(day)}</span></div>
      <div class="msg ${pending.length ? "info" : "okm"}">${pending.length
        ? `لسه <b>${pending.length}</b> عربيات ماتحملتش: ${pending.map(t => esc(t.name)).join("، ")}` : "كل العربيات اتحمّلت ✓"}${loaded ? ` — اتحمّل <b>${loaded}</b> وانتقلوا للمكتمل` : ""}</div>
      ${pending.map(t => {
        const d = docks.find(x => x.truckId === t.id);
        const brs = branches.filter(b => b.truckId === t.id).sort(byOrder).map(b => esc(b.name)).join("، ");
        return `<div class="dcard" data-t="${t.id}">
          <h4><i class="fa-solid fa-truck"></i> ${esc(t.name)} <small class="mini">ميعاد التحميل ${fmt12(t.loadTime)}</small>
            ${d ? '<span class="badge wait">جوه المخزن</span>' : '<span class="badge late">لسه</span>'}</h4>
          <div class="brs">الفروع: ${brs || "—"}</div>
          ${!d ? `<label>دخول المخزن ${timeField("in")}</label> <button class="btn sm" data-act="in">تسجيل الدخول</button>`
            : `<div>دخلت <b>${fmt12(d.inTime)}</b> <span class="mini">(اتسجّلت ${tsLabel(d.sentAt)})</span></div>
               <div style="margin-top:8px"><label>خروج من المخزن ${timeField("out")}</label> <button class="btn sm" data-act="out">تسجيل الخروج</button></div>`}
        </div>`;
      }).join("") || (trucks.length ? "" : '<div class="empty">الإدارة لسه ماضافتش عربيات.</div>')}`;
    $("dayIn").onchange = e => { day = e.target.value || today; dayKey = ""; lastSig = ""; paint(); };
    body.querySelectorAll("[data-act]").forEach(btn => btn.onclick = async () => {
      const card = btn.closest(".dcard"), tid = card.dataset.t, isIn = btn.dataset.act === "in";
      const val = card.querySelector(isIn ? "[name=in]" : "[name=out]").value;
      if (!val) return toast("اختار الوقت الأول", "err");
      btn.disabled = true;
      try {
        const ref = doc(db, "docks", `${day}_${tid}`);
        if (isIn) await setDoc(ref, { date: day, truckId: tid, uid, inTime: val, outTime: null, sentAt: serverTimestamp(), sid: getSid(), status: "sent" });
        else await updateDoc(ref, { outTime: val, outAt: serverTimestamp(), outSid: getSid() });
        logActivity("dock", `${truckOf(tid).name}: ${isIn ? "دخول" : "خروج"} ${val} (${day})`);
        toast(isIn ? "اتسجّل ✓" : "اتحمّلت ✓ وانتقلت للمكتمل");
      } catch (e) { btn.disabled = false; toast(e && e.code === "permission-denied" ? "اترفض: العربية دي اتسجّلت قبل كده. حدّث الصفحة." : arErr(e), "err"); }
    });
  }
}

/* ------------------------------------------------------------------ تشغيل (آخر الملف عشان كل التعريفات تكون جاهزة) */
try {
  if (me.role === "admin") location.replace("schedule-admin.html");
  else if (me.sched === "leader") fieldApp("leader");
  else if (me.sched === "rep") fieldApp("rep");
  else if (me.sched === "dock") dockApp();
  else root.innerHTML = '<div class="empty">مفيش عندك صلاحية على نظام المواعيد. كلّم مسؤول النظام.</div>';
} catch (e) { showError(e); }
