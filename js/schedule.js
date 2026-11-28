// صفحة الليدر / مندوب المخزن: إدخال المواعيد
import { db } from "./firebase.js";
import {
  collection, doc, getDocs, query, where, writeBatch, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, esc, toast, arErr } from "./common.js";
import { getSid } from "./session.js";
import {
  $, cairoToday, addDays, toMin, isLate, lateBy, fmt12, dayLabel, tsLabel, tsMs, timeField, confirmBox, initShell, message
} from "./schedule-core.js";

const api = await guard();
const me = api.profile, uid = api.user.uid;
const root = $("root");
initShell(api);
const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name));

try {
  if (me.role === "admin" && !me.sched) location.replace("schedule-admin.html");
  else if (me.sched === "leader") await leaderApp();
  else if (me.sched === "dock") await dockApp();
  else root.innerHTML = '<div class="empty">مفيش عندك صلاحية على نظام المواعيد. كلّم مسؤول النظام.</div>';
} catch (e) {
  console.error(e);
  root.innerHTML = `<div class="msg err">تعذر تحميل البيانات.<br><small dir="ltr">${esc((e && (e.code || e.message)) || "")}</small>
    ${e && e.code === "permission-denied" ? "<br>غالبًا قواعد Firestore لسه ماتنشرتش من آخر نسخة، أو الإدارة لسه ماحدّدتش دورك. كلّم مسؤول النظام." : ""}</div>`;
}

/* ------------------------------------------------------------------ مشترك */
async function loadTrucks() {
  const s = await getDocs(collection(db, "trucks"));
  return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.loadTime).localeCompare(String(b.loadTime)));
}
function statusBadge(arr, end, sched, holiday) {
  if (holiday) return '<span class="badge hol">إجازة</span>';
  if (!arr) return '<span class="badge wait">ناقص</span>';
  if (isLate(arr, sched)) return `<span class="badge late">متأخر +${lateBy(arr, sched)} د</span>`;
  if (toMin(arr) < toMin(sched)) return '<span class="badge early">بدري</span>';
  return '<span class="badge ok">في الميعاد</span>';
}

/* ================================================================== الليدر */
async function leaderApp() {
  const [trucks, bs] = await Promise.all([
    loadTrucks(),
    getDocs(query(collection(db, "branches"), where("leaders", "array-contains", uid)))
  ]);
  const branches = bs.docs.map(d => ({ id: d.id, ...d.data() }));
  const truckOf = id => trucks.find(t => t.id === id);
  let mine = [];
  let tab = "enter", day = cairoToday();

  async function loadMine() {
    const s = await getDocs(query(collection(db, "entries"), where("uid", "==", uid)));
    mine = s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  await loadMine();

  function groups() {   // [{truck, items:[branch]}] بترتيب ميعاد تحميل العربية
    const g = trucks.map(t => ({ truck: t, items: branches.filter(b => b.truckId === t.id).sort(byOrder) })).filter(x => x.items.length);
    const rest = branches.filter(b => !truckOf(b.truckId));
    if (rest.length) g.push({ truck: { id: "", name: "من غير عربية", loadTime: "" }, items: rest.sort(byOrder) });
    return g;
  }

  function shell() {
    root.innerHTML = `
      <h2>مواعيد فروعك</h2>
      <p class="sub">سجّل وقت وصول وانتهاء كل فرع، وبعدها ابعتهم كلهم مرة واحدة. بعد الإرسال مفيش تعديل غير من الإدارة.</p>
      <div class="tabs">
        <button class="tab" data-t="enter"><i class="fa-solid fa-pen-to-square"></i> إدخال المواعيد</button>
        <button class="tab" data-t="sent"><i class="fa-solid fa-paper-plane"></i> اللي اتبعت</button>
        <button class="tab" data-t="done"><i class="fa-solid fa-circle-check"></i> المهام المكتملة</button>
      </div>
      <div id="tabBody"></div>`;
    root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; paint(); });
    paint();
  }
  function paint() {
    root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
    if (tab === "enter") paintEnter(); else paintHistory(tab === "done");
  }

  /* ---------- إدخال ---------- */
  function lockedRow(b, e) {
    return `<div class="brow locked">
      <div class="bn">${esc(b.name)}<small>ميعاد الفرع ${fmt12(b.time)}</small></div>
      <div class="times">${e.holiday ? '<span class="badge hol">الفرع إجازة</span>'
        : `<span>وصول <b>${fmt12(e.arrival)}</b></span><span>انتهاء <b>${fmt12(e.end)}</b></span>`}
        ${statusBadge(e.arrival, e.end, e.schedTime || b.time, e.holiday)}</div>
      <div>${e.note ? `<div class="mini">السبب: ${esc(e.note)}</div>` : ""}
        <span class="badge ok"><i class="fa-solid fa-lock"></i> اتبعت ${tsLabel(e.sentAt)}</span></div></div>`;
  }
  function formRow(b) {
    return `<div class="brow" data-b="${b.id}" data-sched="${esc(b.time)}">
      <div class="bn">${esc(b.name)}<small>ميعاد الفرع ${fmt12(b.time)}</small></div>
      <div class="times">
        <label>وصول ${timeField("arr")}</label>
        <label>انتهاء ${timeField("end")}</label>
        <label class="hol"><input type="checkbox" name="hol"> الفرع إجازة</label>
        <span data-flag></span>
      </div>
      <div><textarea name="note" maxlength="300" placeholder="السبب (اختياري، وإجباري لو متأخر أو ناقص)"></textarea></div>
    </div>`;
  }
  function paintEnter() {
    const today = cairoToday();
    const body = $("tabBody");
    if (!branches.length) { body.innerHTML = '<div class="empty">مفيش فروع متعيّنة عليك لسه. الإدارة هي اللي بتعيّن العربيات والفروع ليك، كلّمهم.</div>'; return; }
    const gs = groups();
    body.innerHTML = `
      <div class="datebar"><label class="dl">اليوم:</label>
        <input type="date" id="dayIn" value="${day}" min="${addDays(today, -7)}" max="${today}">
        <span class="dl" id="dayLbl">${dayLabel(day)}</span></div>
      <div id="sentMsg" class="msg hidden"></div>
      <div id="problems" class="msg err hidden"></div>
      ${gs.map(g => `<div class="truck">
        <div class="truck-h"><i class="fa-solid fa-truck"></i> ${esc(g.truck.name)}
          ${g.truck.loadTime ? `<small>ميعاد تحميل العربية ${fmt12(g.truck.loadTime)}</small>` : ""}</div>
        ${g.items.map(b => { const e = mine.find(x => x.date === day && x.branchId === b.id); return e ? lockedRow(b, e) : formRow(b); }).join("")}
      </div>`).join("")}
      <div class="stick-send"><button class="btn" id="btnSend"><i class="fa-solid fa-paper-plane"></i> إرسال لكل الفروع</button>
        <span class="mini" id="pendingCnt"></span></div>`;
    $("dayIn").onchange = e => { day = e.target.value || today; paintEnter(); };
    body.querySelectorAll(".brow[data-b]").forEach(r => {
      const refresh = () => refreshRow(r);
      r.addEventListener("input", refresh); r.addEventListener("change", refresh);
    });
    $("btnSend").onclick = send;
    const pend = body.querySelectorAll(".brow[data-b]").length;
    $("pendingCnt").textContent = pend ? `${pend} فرع لسه مش مبعوت` : "كل فروع اليوم دي اتبعتت ✓";
    if (!pend) $("btnSend").disabled = true;
  }
  function readRow(r) {
    const hol = r.querySelector("[name=hol]").checked;
    return {
      b: branches.find(x => x.id === r.dataset.b), hol,
      arrival: hol ? null : (r.querySelector("[name=arr]").value || null),
      end: hol ? null : (r.querySelector("[name=end]").value || null),
      note: r.querySelector("[name=note]").value.trim()
    };
  }
  function refreshRow(r) {
    const hol = r.querySelector("[name=hol]").checked;
    r.querySelectorAll(".tf input, .tf button").forEach(x => { x.disabled = hol; });
    if (hol) r.querySelectorAll(".tf input").forEach(x => { x.value = ""; });
    const v = readRow(r);
    const late = isLate(v.arrival, v.b.time), inc = !hol && (!v.arrival || !v.end);
    r.querySelector("[data-flag]").innerHTML = hol ? '<span class="badge hol">إجازة</span>'
      : v.arrival ? statusBadge(v.arrival, v.end, v.b.time, false) : "";
    const ta = r.querySelector("[name=note]");
    ta.placeholder = late ? "الفرع واصل متأخر، لازم تكتب السبب" : inc ? "في وقت ناقص، لازم تكتب السبب" : "السبب (اختياري)";
    if ((late || inc) && v.note.length >= 3) r.classList.remove("invalid");
  }

  async function send() {
    const rows = [...$("tabBody").querySelectorAll(".brow[data-b]")].map(r => ({ el: r, ...readRow(r) }));
    const box = $("problems");
    box.classList.add("hidden");
    rows.forEach(x => x.el.classList.remove("invalid"));
    const problems = [];
    rows.forEach(x => {
      const late = isLate(x.arrival, x.b.time), inc = !x.hol && (!x.arrival || !x.end);
      if ((late || inc) && x.note.length < 3) {
        const t = trucks.find(t => t.id === x.b.truckId);
        const what = late ? `واصل متأخر ${lateBy(x.arrival, x.b.time)} دقيقة بعد الميعاد`
          : !x.arrival && !x.end ? "مفيش ميعاد وصول ولا انتهاء"
          : !x.arrival ? "ناقص ميعاد الوصول" : "ناقص ميعاد الانتهاء";
        problems.push(`<b>${esc(x.b.name)}</b>${t ? ` (${esc(t.name)})` : ""}: ${what}. اكتب السبب، أو حط المواعيد، أو علّم الفرع إجازة.`);
        x.el.classList.add("invalid");
      }
    });
    if (problems.length) {
      box.innerHTML = "<b>في فروع محتاجة تتراجع قبل الإرسال:</b><br>" + problems.map(p => "• " + p).join("<br>");
      box.classList.remove("hidden");
      rows.find(x => x.el.classList.contains("invalid")).el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const sum = rows.map(x => `<tr><td>${esc(x.b.name)}</td><td>${x.hol ? "إجازة" : `${fmt12(x.arrival)} ← ${fmt12(x.end)}`}</td></tr>`).join("");
    const ok = await confirmBox("تأكيد الإرسال",
      `<p>هتبعت بيانات <b>${rows.length}</b> فرع ليوم <b>${dayLabel(day)}</b>. بعد الإرسال مش هتقدر تعدّل.</p>
       <div class="table-wrap" style="max-height:260px"><table><tbody>${sum}</tbody></table></div>`, { submitText: "إرسال" });
    if (!ok) return;
    $("btnSend").disabled = true;
    try {
      const batch = writeBatch(db), sid = getSid();
      rows.forEach(x => batch.set(doc(db, "entries", `${day}_${x.b.id}_${uid}`), {
        date: day, branchId: x.b.id, uid, arrival: x.arrival, end: x.end, holiday: x.hol, note: x.note,
        late: isLate(x.arrival, x.b.time), schedTime: x.b.time, sentAt: serverTimestamp(), sid, status: "sent"
      }));
      await batch.commit();
      await loadMine();
      paintEnter();
      const nTr = new Set(rows.map(x => x.b.truckId)).size;
      message($("sentMsg"), `<b>اتبعتت ✓</b> يوم ${dayLabel(day)} كان معاك <b>${nTr}</b> عربيات و<b>${rows.length}</b> فروع، والبيانات اللي بعتها قدامك تحت (متقفلة).`, "ok");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      $("btnSend").disabled = false;
      toast(e && e.code === "permission-denied"
        ? "الإرسال اترفض. غالبًا حاجة من الفروع اتبعتت قبل كده أو الجلسة خلصت، حدّث الصفحة وجرّب تاني."
        : arErr(e), "err");
    }
  }

  /* ---------- اللي اتبعت / المكتمل ---------- */
  function paintHistory(archived) {
    const list = mine.filter(e => (e.status === "archived") === archived);
    const body = $("tabBody");
    if (!list.length) { body.innerHTML = `<div class="empty">${archived ? "مفيش مهام مكتملة لسه." : "مفيش حاجة مبعوتة في انتظار المراجعة."}</div>`; return; }
    const days = [...new Set(list.map(e => e.date))].sort().reverse();
    body.innerHTML = days.map(d => {
      const es = list.filter(e => e.date === d);
      return `<div class="panel" style="margin-bottom:14px"><div class="panel-head"><b>${dayLabel(d)}</b>
        <span class="badge ${archived ? "ok" : "wait"}">${archived ? "اتأرشفت" : "مستنية مراجعة الإدارة"}</span></div>
        <div class="table-wrap"><table><thead><tr><th>الفرع</th><th>وصول</th><th>انتهاء</th><th>الحالة</th><th>السبب</th><th>وقت الإرسال</th></tr></thead><tbody>
        ${es.sort((a, b) => tsMs(a.sentAt) - tsMs(b.sentAt)).map(e => { const b = branches.find(x => x.id === e.branchId) || { name: "(فرع اتشال)" };
          return `<tr><td>${esc(b.name)}</td><td>${e.holiday ? "—" : fmt12(e.arrival)}</td><td>${e.holiday ? "—" : fmt12(e.end)}</td>
          <td>${statusBadge(e.arrival, e.end, e.schedTime, e.holiday)}</td><td style="white-space:normal">${esc(e.note || "")}</td><td>${tsLabel(e.sentAt)}</td></tr>`; }).join("")}
        </tbody></table></div></div>`;
    }).join("");
  }
  shell();
}

/* ================================================================== مندوب المخزن */
function durMin(a, b) { const d = toMin(b) - toMin(a); return d < 0 ? d + 1440 : d; }
function fmtDur(m) { return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د`; }

async function dockApp() {
  const [trucks, bs] = await Promise.all([loadTrucks(), getDocs(collection(db, "branches"))]);
  const branches = bs.docs.map(d => ({ id: d.id, ...d.data() }));
  let tab = "today", day = cairoToday(), doneDay = cairoToday(), doneAll = false, docks = [];
  const truckOf = id => trucks.find(t => t.id === id) || { name: "(عربية اتشالت)", loadTime: "" };

  async function load() {
    const s = await getDocs(query(collection(db, "docks"), where("date", "==", day)));
    docks = s.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  root.innerHTML = `
    <h2>تحميل العربيات</h2>
    <p class="sub">العربيات بترتيب ميعاد تحميلها. سجّل دخول العربية للمخزن وخروجها، ولما تخرج بتنتقل لوحدها للمكتمل.</p>
    <div class="tabs"><button class="tab" data-t="today"><i class="fa-solid fa-truck-ramp-box"></i> العربيات</button>
      <button class="tab" data-t="done"><i class="fa-solid fa-circle-check"></i> المكتمل</button></div>
    <div id="tabBody"></div>`;
  root.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.t; paint(); });
  await paint();

  async function paintDone() {
    const body = $("tabBody"), today = cairoToday();
    let list;
    if (doneAll) list = (await getDocs(collection(db, "docks"))).docs.map(d => ({ id: d.id, ...d.data() }));
    else list = (await getDocs(query(collection(db, "docks"), where("date", "==", doneDay)))).docs.map(d => ({ id: d.id, ...d.data() }));
    list = list.filter(d => d.outTime).sort((a, b) => b.date.localeCompare(a.date) || String(a.outTime).localeCompare(String(b.outTime)));
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
    const di = $("doneIn");
    di.onchange = e => { doneDay = e.target.value || today; paint(); };
    $("allBtn").onclick = () => { doneAll = !doneAll; paint(); };
  }

  async function paint() {
    root.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
    const body = $("tabBody");
    if (tab === "done") return paintDone();
    await load();
    const today = cairoToday();
    const loaded = docks.filter(d => d.outTime).length;
    const pending = trucks.filter(t => { const d = docks.find(x => x.truckId === t.id); return !d || !d.outTime; });
    body.innerHTML = `
      <div class="datebar"><label class="dl">اليوم:</label>
        <input type="date" id="dayIn" value="${day}" min="${addDays(today, -7)}" max="${today}">
        <span class="dl">${dayLabel(day)}</span></div>
      <div class="msg ${pending.length ? "info" : "okm"}">${pending.length
        ? `لسه <b>${pending.length}</b> عربيات ماتحملتش: ${pending.map(t => esc(t.name)).join("، ")}`
        : "كل العربيات اتحمّلت ✓"}${loaded ? ` — اتحمّل <b>${loaded}</b> وانتقلوا للمكتمل` : ""}</div>
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
    $("dayIn").onchange = e => { day = e.target.value || today; paint(); };
    body.querySelectorAll("[data-act]").forEach(btn => btn.onclick = async () => {
      const card = btn.closest(".dcard"), tid = card.dataset.t;
      const val = card.querySelector(btn.dataset.act === "in" ? "[name=in]" : "[name=out]").value;
      if (!val) return toast("اختار الوقت الأول", "err");
      btn.disabled = true;
      try {
        const ref = doc(db, "docks", `${day}_${tid}`);
        if (btn.dataset.act === "in") await setDoc(ref, { date: day, truckId: tid, uid, inTime: val, outTime: null, sentAt: serverTimestamp(), sid: getSid(), status: "sent" });
        else await updateDoc(ref, { outTime: val, outAt: serverTimestamp(), outSid: getSid() });
        toast(btn.dataset.act === "out" ? "اتحمّلت ✓ وانتقلت للمكتمل" : "اتسجّل ✓"); paint();
      } catch (e) { btn.disabled = false; toast(e && e.code === "permission-denied" ? "اترفض: العربية دي اتسجّلت قبل كده. حدّث الصفحة." : arErr(e), "err"); }
    });
  }
}
