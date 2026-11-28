import { db, secondaryAuth } from "./firebase.js";
import {
  createUserWithEmailAndPassword, signOut, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { isLive } from "./session.js";
import { guard, logout, canSee, esc, arErr, toast, normId, validId, makeEmail, initThemeButton } from "./common.js";

const $ = id => document.getElementById(id);
const api = await guard();
let me = api.profile;
const isAdmin = me.role === "admin";
const user = api.user;
let tools = [];
let users = [];
let usersStarted = false;
let sessions = {};          // uid -> بيانات الجلسة (للأدمن)
let devices = {};           // uid -> الجهاز المربوط (للأدمن)

initThemeButton($("btnTheme"));

const ICONS = [
  ["fa-solid fa-table-list", "جدول"], ["fa-solid fa-file-excel", "إكسيل"], ["fa-solid fa-chart-column", "رسم بياني"],
  ["fa-solid fa-truck", "شحن"], ["fa-solid fa-triangle-exclamation", "تنبيه"], ["fa-solid fa-pen-to-square", "تعديل"],
  ["fa-solid fa-calculator", "حاسبة"], ["fa-solid fa-boxes-stacked", "مخزون"], ["fa-solid fa-file-pdf", "PDF"],
  ["fa-solid fa-gears", "أدوات"], ["fa-solid fa-screwdriver-wrench", "صيانة"], ["fa-solid fa-magnifying-glass", "بحث"]
];
const ICON_RE = /^fa-[a-z]+ fa-[a-z0-9-]+$/;

/* ------------------------------------------------------------------ helpers */
function modal(title, bodyHtml, { onSubmit, submitText = "حفظ", danger = false, onMount } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<form class="modal"><h3>${esc(title)}</h3><div class="msg err hidden" data-err></div>${bodyHtml}
    <div class="actions"><button class="btn ${danger ? "danger" : ""}" type="submit">${esc(submitText)}</button>
    <button type="button" class="btn ghost" data-close>إلغاء</button></div></form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector("form");
  const close = () => ov.remove();
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  form.querySelector("[data-close]").addEventListener("click", close);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const err = form.querySelector("[data-err]");
    err.classList.add("hidden");
    btn.disabled = true;
    try { await onSubmit(form); close(); }
    catch (ex) {
      err.textContent = ex && ex.code ? arErr(ex) : (ex && ex.message) || "حصل خطأ";
      err.classList.remove("hidden");
      btn.disabled = false;
    }
  });
  if (onMount) onMount(form);
  const first = form.querySelector("input:not([type=checkbox]):not([disabled]),textarea");
  if (first) first.focus();
  return { form, close };
}

function accessHtml(allTools, ids, sched = "") {
  const list = tools.length
    ? tools.map(t => `<label><input type="checkbox" name="tid" value="${esc(t.id)}" ${ids.includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")
    : '<span class="sub" style="margin:0">مفيش أدوات لسه</span>';
  return `<div class="field"><label>الأدوات المسموحة</label>
    <label style="font-weight:500;display:flex;gap:8px;align-items:center"><input type="checkbox" name="allTools" ${allTools ? "checked" : ""} style="width:auto"> كل الأدوات (الحالية والجديدة)</label>
    <div class="checks" data-checks>${list}</div></div>
  <div class="field"><label>دور نظام المواعيد</label><select name="sched">
    <option value="" ${!sched ? "selected" : ""}>مفيش</option>
    <option value="leader" ${sched === "leader" ? "selected" : ""}>ليدر / مندوب (بيدخل مواعيد فروعه)</option>
    <option value="dock" ${sched === "dock" ? "selected" : ""}>مندوب المخزن (مواعيد تحميل العربيات)</option></select></div>`;
}
function wireAccess(form) {
  const all = form.elements.allTools;
  const sync = () => form.querySelectorAll("input[name=tid]").forEach(i => { i.disabled = all.checked; });
  all.addEventListener("change", sync); sync();
}
function readAccess(form) {
  return {
    allTools: form.elements.allTools.checked,
    toolIds: [...form.querySelectorAll("input[name=tid]:checked")].map(i => i.value)
  };
}
function roleLabel(r) { return r === "admin" ? "مسؤول" : "مستخدم"; }
const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";
// مفتاح مؤقت عشوائي بيتستخدم في أول دخول للموظف (بعدها الموظف بيختار كلمة المرور بنفسه)
function randomKey() {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

/* ------------------------------------------------------------------ tools (لحظي) */
function schedCards() {
  const c = [];
  if (isAdmin) c.push(["schedule-admin.html", "fa-solid fa-calendar-check", "إدارة مواعيد الفروع", "العربيات والفروع ومراجعة اللي اتبعت وإرساله للشيت"]);
  if (me && (me.sched === "leader" || me.sched === "dock" || isAdmin))
    c.push(["schedule.html", "fa-solid fa-clock", me.sched === "dock" ? "مواعيد تحميل العربيات" : "إدخال مواعيد الفروع", me.sched === "dock" ? "سجّل دخول وخروج العربيات من المخزن" : "سجّل مواعيد وصول وانتهاء فروعك"]);
  return c.map(([href, ic, t, p]) => `<a class="tool" href="${href}"><div class="ico"><i class="${ic}"></i></div><h3>${t}</h3><p>${p}</p></a>`).join("");
}
function renderTools() {
  const grid = $("toolsGrid");
  const mine = tools.filter(t => canSee(me, t.id));
  const extra = schedCards();
  if (!mine.length && extra) { grid.innerHTML = extra; return; }
  if (!mine.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      ${isAdmin && !tools.length
        ? `مفيش أدوات لسه.<br><br><button class="btn" id="btnSeed"><i class="fa-solid fa-wand-magic-sparkles"></i> إضافة أدوات Odoo الجاهزة</button>`
        : "مفيش أدوات متاحة لحسابك دلوقتي. كلّم مسؤول النظام."}</div>`;
    const seed = $("btnSeed"); if (seed) seed.onclick = seedDefault;
    return;
  }
  grid.innerHTML = mine.map(t => `<a class="tool" href="tool.html?id=${encodeURIComponent(t.id)}">
      <div class="ico"><i class="${ICON_RE.test(t.icon || "") ? esc(t.icon) : "fa-solid fa-screwdriver-wrench"}"></i></div>
      <h3>${esc(t.name)}</h3><p>${esc(t.description || "")}</p></a>`).join("") + extra;
}

async function seedDefault() {
  await setDoc(doc(db, "tools", "fps-tools"), {
    name: "أدوات Odoo",
    description: "سحبة الأعداد لكل كاتيجري، إضافة الملاحظات، اوت بوت، واستخراج سحبة أعداد فروع جاهزة.",
    icon: "fa-solid fa-table-list", type: "file", path: "tools/fps-tools.html", createdAt: serverTimestamp()
  });
  toast("تمت إضافة الأداة");
}

/* ------------------------------------------------------------------ manage tools */
function renderManage() {
  const body = $("toolsBody");
  $("btnAddPriceTool").classList.toggle("hidden", tools.some(t => t.path === "tools/price-calc.html"));
  if (!tools.length) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:30px">مفيش أدوات. اضغط "أداة جديدة" أو أضف الأدوات الجاهزة من تاب "الأدوات".</td></tr>`;
    return;
  }
  body.innerHTML = tools.map(t => `<tr>
    <td><i class="${ICON_RE.test(t.icon || "") ? esc(t.icon) : "fa-solid fa-screwdriver-wrench"}" style="color:var(--brand)"></i> <b>${esc(t.name)}</b></td>
    <td><span class="badge">${t.type === "html" ? "كود HTML" : "ملف في المشروع"}</span></td>
    <td>${t.type === "html" ? '<span class="sub" style="margin:0">محفوظ في قاعدة البيانات</span>' : `<span class="mono">${esc(t.path)}</span>`}</td>
    <td><div class="acts">
      <button class="btn ghost sm" data-act="edit" data-id="${esc(t.id)}"><i class="fa-solid fa-pen"></i> تعديل</button>
      <button class="btn ghost sm" data-act="del" data-id="${esc(t.id)}"><i class="fa-solid fa-trash"></i> مسح</button>
    </div></td></tr>`).join("");
}

function toolModal(existing, existingHtml) {
  const t = existing || { name: "", description: "", icon: ICONS[0][0], type: "html", path: "" };
  modal(existing ? "تعديل أداة" : "أداة جديدة", `
    <div class="field"><label>اسم الأداة</label><input name="name" value="${esc(t.name)}" required maxlength="80"></div>
    <div class="field"><label>وصف قصير</label><input name="description" value="${esc(t.description)}" maxlength="160"></div>
    <div class="row">
      <div class="field"><label>الأيقونة</label><select name="icon">${ICONS.map(([v, l]) => `<option value="${v}" ${v === t.icon ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label>نوع الأداة</label><select name="type">
        <option value="html" ${t.type === "html" ? "selected" : ""}>لصق كود HTML (من غير رفع على GitHub)</option>
        <option value="file" ${t.type === "file" ? "selected" : ""}>ملف موجود في فولدر tools</option></select></div>
    </div>
    <div class="field" data-for="file"><label>مسار الملف</label><input name="path" dir="ltr" placeholder="tools/my-tool.html" value="${esc(t.path)}"><small>الملف لازم يكون مرفوع في فولدر tools على GitHub.</small></div>
    <div data-for="html">
      <div class="field"><label>كود الأداة (HTML كامل)</label><textarea class="code" name="html" spellcheck="false">${esc(existingHtml || "")}</textarea></div>
      <div class="field"><label>أو ارفع ملف HTML</label><input type="file" name="htmlfile" accept=".html,.htm"></div>
    </div>`, {
    onMount(form) {
      const sync = () => {
        const isHtml = form.elements.type.value === "html";
        form.querySelector('[data-for="html"]').classList.toggle("hidden", !isHtml);
        form.querySelector('[data-for="file"]').classList.toggle("hidden", isHtml);
      };
      form.elements.type.addEventListener("change", sync); sync();
      form.elements.htmlfile.addEventListener("change", async e => {
        const f = e.target.files[0]; if (f) form.elements.html.value = await f.text();
      });
    },
    async onSubmit(form) {
      const name = form.elements.name.value.trim();
      const type = form.elements.type.value;
      if (!name) throw { message: "اكتب اسم الأداة." };
      const id = existing ? existing.id : doc(collection(db, "tools")).id;
      const meta = { name, description: form.elements.description.value.trim(), icon: form.elements.icon.value, type, path: "", updatedAt: serverTimestamp() };
      if (!existing) meta.createdAt = serverTimestamp();
      const batch = writeBatch(db);
      if (type === "file") {
        const path = form.elements.path.value.trim();
        if (!/^tools\/[A-Za-z0-9._-]+\.html$/.test(path)) throw { message: "المسار لازم يبقى بالشكل: tools/اسم-الملف.html (حروف إنجليزي بدون مسافات)." };
        meta.path = path;
        if (existing && existing.type === "html") batch.delete(doc(db, "toolCode", id));
      } else {
        const html = form.elements.html.value;
        if (!html.trim()) throw { message: "الصق كود HTML أو ارفع ملف." };
        if (new Blob([html]).size > 900000) throw { message: "حجم الكود أكبر من 900KB. ارفعه كملف في فولدر tools بدل كده." };
        batch.set(doc(db, "toolCode", id), { html, updatedAt: serverTimestamp() });
      }
      batch.set(doc(db, "tools", id), meta, { merge: true });
      await batch.commit();
      toast("تم حفظ الأداة");
    }
  });
}

$("btnAddTool").onclick = () => toolModal(null, "");
$("btnAddPriceTool").onclick = async () => {
  try {
    await setDoc(doc(db, "tools", "price-calc"), {
      name: "أداة حساب الأسعار", icon: "fa-solid fa-calculator", type: "file", path: "tools/price-calc.html",
      description: "ارفع سحبة الأودو وهتاخد شيت extiract: عدد القطع وإجمالي السعر لكل فرع.", createdAt: serverTimestamp()
    });
    toast("تمت إضافة أداة حساب الأسعار");
  } catch (e) { toast(arErr(e), "err"); }
};
$("toolsBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const t = tools.find(x => x.id === b.dataset.id); if (!t) return;
  if (b.dataset.act === "edit") {
    let html = "";
    if (t.type === "html") {
      try { const s = await getDoc(doc(db, "toolCode", t.id)); html = s.exists() ? s.data().html : ""; }
      catch (ex) { return toast(arErr(ex), "err"); }
    }
    toolModal(t, html);
  } else {
    modal("مسح الأداة", `<p>هتمسح الأداة <b>${esc(t.name)}</b> نهائيًا. متأكد؟</p>`, {
      submitText: "مسح", danger: true,
      async onSubmit() {
        const batch = writeBatch(db);
        batch.delete(doc(db, "tools", t.id));
        batch.delete(doc(db, "toolCode", t.id));
        await batch.commit();
        toast("تم مسح الأداة");
      }
    });
  }
});

/* ------------------------------------------------------------------ users */
function renderUsers() {
  if (!users.length) { $("usersBody").innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:26px">لا يوجد مستخدمين.</td></tr>'; return; }
  $("usersBody").innerHTML = users.map(u => {
    const you = u.uid === me.uid;
    const access = u.role === "admin" || u.allTools ? "الكل" : `${(u.toolIds || []).filter(id => tools.some(t => t.id === id)).length} أداة`;
    return `<tr>
      <td><span class="mono">${esc(u.employeeId)}</span></td>
      <td>${esc(u.name)} ${you ? '<span class="badge">انت</span>' : ""}</td>
      <td>${roleLabel(u.role)}</td>
      <td><span class="badge ${u.active ? "ok" : "off"}">${u.active ? "مفعّل" : "محظور"}</span>${u.pending ? ' <span class="badge wait">مستني أول دخول</span>' : ""}${u.role !== "admin" && u.deviceLock !== false ? (devices[u.uid] ? ` <span class="badge wait" title="الحساب مربوط بالجهاز ده">مربوط: ${esc(devices[u.uid].device || "")}</span>` : ' <span class="badge wait">هيتربط بأول جهاز</span>') : ""}${isLive(sessions[u.uid]) ? ` <span class="badge ok" title="${esc(sessions[u.uid].device || "")}">متصل الآن · ${esc(sessions[u.uid].device || "")}</span>` : ""}</td>
      <td>${access}</td>
      <td><div class="acts">
        <button class="btn ghost sm" data-act="edit" data-uid="${esc(u.uid)}"><i class="fa-solid fa-pen"></i> تعديل</button>
        ${you ? "" : `<button class="btn ${u.active ? "ghost" : ""} sm" data-act="ban" data-uid="${esc(u.uid)}"><i class="fa-solid ${u.active ? "fa-ban" : "fa-lock-open"}"></i> ${u.active ? "حظر" : "إلغاء الحظر"}</button>
        ${u.role === "admin" ? "" : `<button class="btn ghost sm" data-act="lock" data-uid="${esc(u.uid)}"><i class="fa-solid fa-link${u.deviceLock === false ? "-slash" : ""}"></i> ربط الجهاز: ${u.deviceLock === false ? "إيقاف" : "تشغيل"}</button>`}
        ${devices[u.uid] ? `<button class="btn ghost sm" data-act="unbind" data-uid="${esc(u.uid)}"><i class="fa-solid fa-link-slash"></i> فك الربط</button>` : ""}
        ${sessions[u.uid] && sessions[u.uid].closed !== true ? `<button class="btn ghost sm" data-act="kill" data-uid="${esc(u.uid)}"><i class="fa-solid fa-plug-circle-xmark"></i> إنهاء الجلسة</button>` : ""}
        <button class="btn ghost sm" data-act="pw" data-uid="${esc(u.uid)}"><i class="fa-solid fa-key"></i> باسورد</button>
        <button class="btn ghost sm" data-act="del" data-uid="${esc(u.uid)}"><i class="fa-solid fa-trash"></i></button>`}
      </div></td></tr>`;
  }).join("");
}

function startUsers() {
  if (usersStarted || !isAdmin) return;
  usersStarted = true;
  onSnapshot(collection(db, "users"), snap => {
    users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)));
    renderUsers();
  }, err => toast(arErr(err), "err"));
  onSnapshot(collection(db, "sessions"), snap => {
    sessions = {}; snap.docs.forEach(d => { sessions[d.id] = d.data(); });
    renderUsers();
  }, () => {});
  onSnapshot(collection(db, "devices"), snap => {
    devices = {}; snap.docs.forEach(d => { devices[d.id] = d.data(); });
    renderUsers();
  }, () => {});
  setInterval(() => { if (users.length) renderUsers(); }, 30000);   // المؤشر بيتحدث مع الوقت
}

// بيعمل حساب Firebase جديد من غير ما الأدمن يتسجل خروج
async function createAuthAccount(empId, password) {
  const email = makeEmail(empId);
  const sauth = secondaryAuth();
  const cred = await createUserWithEmailAndPassword(sauth, email, password);
  const uid = cred.user.uid;
  await signOut(sauth);
  return { uid, email };
}

function cleanUserData(u) {
  const d = { employeeId: u.employeeId, name: u.name, role: u.role, active: u.active, allTools: !!u.allTools, toolIds: u.toolIds || [] };
  if (u.createdAt) d.createdAt = u.createdAt;
  if (u.createdBy) d.createdBy = u.createdBy;
  if (u.deviceLock === false) d.deviceLock = false;
  if (u.sched) d.sched = u.sched;
  return d;
}

$("btnAddUser").onclick = () => modal("مستخدم جديد", `
  <div class="field"><label>الاسم</label><input name="name" required maxlength="80"></div>
  <div class="row">
    <div class="field"><label>الرقم الوظيفي</label><input name="empId" dir="ltr" required><small>حروف إنجليزي/أرقام فقط</small></div>
    <div class="field"><label>الدور</label><select name="role"><option value="user">مستخدم</option><option value="admin">مسؤول</option></select></div>
  </div>
  <div class="field"><label>كلمة المرور (اختياري)</label><input name="pass" type="text" dir="ltr" minlength="6" autocomplete="off"><small>سيبها فاضية والموظف هيكتب رقمه الوظيفي في صفحة الدخول ويختار كلمة المرور بنفسه أول مرة. أو اكتب كلمة مرور (6 على الأقل) وابعتهاله.</small></div>
  ${accessHtml(true, [])}`, {
  submitText: "إنشاء",
  onMount: wireAccess,
  async onSubmit(form) {
    const name = form.elements.name.value.trim();
    const id = normId(form.elements.empId.value);
    const pass = form.elements.pass.value;
    if (!validId(id)) throw { message: "الرقم الوظيفي لازم حروف إنجليزي/أرقام (2 إلى 32)، ويقدر يحتوي . _ -" };
    if (pass && pass.length < 6) throw { message: "كلمة المرور لازم 6 على الأقل (أو سيبها فاضية)." };
    if ((await getDoc(doc(db, "loginMap", id))).exists()) throw { message: "الرقم الوظيفي ده مستخدم قبل كده." };
    const pending = !pass;
    const secret = pending ? randomKey() : pass;
    const { uid, email } = await createAuthAccount(id, secret);
    const acc = readAccess(form);
    const batch = writeBatch(db);
    batch.set(doc(db, "users", uid), {
      uid, employeeId: id, name, role: form.elements.role.value, active: true, pending,
      allTools: acc.allTools, toolIds: acc.toolIds, authEmail: email, createdAt: serverTimestamp(), createdBy: me.uid,
      ...(form.elements.sched.value ? { sched: form.elements.sched.value } : {})
    });
    batch.set(doc(db, "loginMap", id), {
      email, uid, first: firstName(name), active: true, needsPassword: pending, ...(pending ? { initKey: secret } : {})
    });
    await batch.commit();
    toast("تم إنشاء المستخدم");
  }
});

async function setBan(u, active) {
  const batch = writeBatch(db);
  batch.update(doc(db, "users", u.uid), { active });
  batch.set(doc(db, "loginMap", u.employeeId), { active }, { merge: true });
  await batch.commit();
}

$("usersBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const u = users.find(x => x.uid === b.dataset.uid); if (!u) return;
  const you = u.uid === me.uid;

  if (b.dataset.act === "ban") {
    const ban = u.active;
    modal(ban ? "حظر مستخدم" : "إلغاء الحظر", ban
      ? `<p>هتحظر <b>${esc(u.name)}</b> (<span class="mono">${esc(u.employeeId)}</span>). هيتطرد من الموقع فورًا لو فاتحه دلوقتي، ومش هيعرف يدخل لحد ما تلغي الحظر.</p>`
      : `<p>هترجّع الدخول لـ <b>${esc(u.name)}</b> (<span class="mono">${esc(u.employeeId)}</span>).</p>`, {
      submitText: ban ? "حظر" : "إلغاء الحظر", danger: ban,
      async onSubmit() { await setBan(u, !ban); toast(ban ? "تم حظر المستخدم" : "تم إلغاء الحظر"); }
    });
  }

  if (b.dataset.act === "edit") {
    modal("تعديل مستخدم", `
      <div class="field"><label>الاسم</label><input name="name" value="${esc(u.name)}" required maxlength="80"></div>
      <div class="row">
        <div class="field"><label>الرقم الوظيفي</label><input name="empId" dir="ltr" value="${esc(u.employeeId)}" required></div>
        <div class="field"><label>الدور</label><select name="role" ${you ? "disabled" : ""}>
          <option value="user" ${u.role !== "admin" ? "selected" : ""}>مستخدم</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>مسؤول</option></select></div>
      </div>
      <div class="field"><label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" name="active" style="width:auto" ${u.active ? "checked" : ""} ${you ? "disabled" : ""}> الحساب مفعّل (شيل العلامة = حظر)</label>
        ${you ? '<small>مينفعش توقف أو تغيّر دور حسابك انت.</small>' : ""}</div>
      ${accessHtml(!!u.allTools, u.toolIds || [], u.sched || "")}`, {
      onMount: wireAccess,
      async onSubmit(form) {
        const name = form.elements.name.value.trim();
        const newId = normId(form.elements.empId.value);
        if (!validId(newId)) throw { message: "الرقم الوظيفي لازم حروف إنجليزي/أرقام (2 إلى 32)." };
        const acc = readAccess(form);
        const patch = { name, allTools: acc.allTools, toolIds: acc.toolIds, sched: form.elements.sched.value };
        if (!you) { patch.role = form.elements.role.value; patch.active = form.elements.active.checked; }
        const batch = writeBatch(db);
        const mapPatch = { first: firstName(name), active: you ? true : form.elements.active.checked };
        if (newId !== u.employeeId) {
          if ((await getDoc(doc(db, "loginMap", newId))).exists()) throw { message: "الرقم الوظيفي الجديد مستخدم قبل كده." };
          const oldMap = (await getDoc(doc(db, "loginMap", u.employeeId))).data() || { email: u.authEmail, uid: u.uid };
          batch.delete(doc(db, "loginMap", u.employeeId));
          batch.set(doc(db, "loginMap", newId), { ...oldMap, ...mapPatch });
          patch.employeeId = newId;
        } else {
          batch.set(doc(db, "loginMap", u.employeeId), mapPatch, { merge: true });
        }
        batch.update(doc(db, "users", u.uid), patch);
        await batch.commit();
        toast("تم حفظ التعديل");
      }
    });
  }

  if (b.dataset.act === "pw") {
    modal(`تصفير كلمة المرور — ${u.name}`, `
      <p class="sub">الرقم الوظيفي: <b class="mono">${esc(u.employeeId)}</b></p>
      <div class="field"><label>كلمة المرور الجديدة (اختياري)</label><input name="pass" type="text" dir="ltr" minlength="6" autocomplete="off">
        <small>سيبها فاضية = تصفير: الموظف يدخل برقمه الوظيفي ويختار كلمة مرور جديدة بنفسه. أو اكتب كلمة مرور (6 على الأقل) وابعتهاله.</small></div>`, {
      submitText: "تصفير / تغيير",
      async onSubmit(form) {
        const pass = form.elements.pass.value;
        if (pass && pass.length < 6) throw { message: "كلمة المرور لازم 6 على الأقل (أو سيبها فاضية)." };
        const pending = !pass;
        const secret = pending ? randomKey() : pass;
        // Firebase مش بيسمح لأدمن من المتصفح يغيّر باسورد حد تاني،
        // فبنعمل حساب دخول جديد بالباسورد الجديد ونحوّل عليه نفس بيانات الموظف.
        const { uid: newUid, email } = await createAuthAccount(u.employeeId, secret);
        const batch = writeBatch(db);
        batch.set(doc(db, "users", newUid), { ...cleanUserData(u), uid: newUid, authEmail: email, pending, passwordResetAt: serverTimestamp() });
        batch.delete(doc(db, "users", u.uid));
        batch.set(doc(db, "loginMap", u.employeeId), {
          email, uid: newUid, first: firstName(u.name), active: !!u.active, needsPassword: pending, ...(pending ? { initKey: secret } : {})
        });
        await batch.commit();
        toast(pending ? "تم التصفير، الموظف هيختار كلمة مرور جديدة عند الدخول" : "تم تغيير كلمة المرور");
      }
    });
  }

  if (b.dataset.act === "unbind") {
    modal("فك ربط الجهاز", `<p>هتفك ربط <b>${esc(u.name)}</b> من الجهاز <b>${esc((devices[u.uid] || {}).device || "")}</b>. هيتسجّل خروجه فورًا، وأول جهاز يدخل منه بعد كده هو اللي هيتربط بالحساب.</p>`, {
      submitText: "فك الربط", danger: true,
      async onSubmit() {
        await deleteDoc(doc(db, "devices", u.uid));
        try { await deleteDoc(doc(db, "sessions", u.uid)); } catch (_) {}
        toast("تم فك الربط");
      }
    });
  }

  if (b.dataset.act === "lock") {
    const on = u.deviceLock !== false;
    modal(on ? "إيقاف ربط الجهاز" : "تشغيل ربط الجهاز", on
      ? `<p>هتوقف الربط الدايم لـ <b>${esc(u.name)}</b>. هيفضل ممنوع يفتح من جهازين في نفس الوقت، بس يقدر يغيّر جهازه براحته.</p>`
      : `<p>هتشغّل الربط الدايم لـ <b>${esc(u.name)}</b>: أول جهاز يدخل منه بيتربط بالحساب لحد ما تفك الربط.</p>`, {
      submitText: on ? "إيقاف" : "تشغيل", danger: on,
      async onSubmit() {
        await updateDoc(doc(db, "users", u.uid), { deviceLock: !on });
        if (on) { try { await deleteDoc(doc(db, "devices", u.uid)); } catch (_) {} }
        toast(on ? "تم إيقاف الربط" : "تم تشغيل الربط");
      }
    });
  }

  if (b.dataset.act === "kill") {
    modal("إنهاء الجلسة", `<p>هتنهي جلسة <b>${esc(u.name)}</b>. لو كان فاتح الموقع هيتسجّل خروجه فورًا، وبعدها يقدر يدخل من أي جهاز.</p>`, {
      submitText: "إنهاء الجلسة", danger: true,
      async onSubmit() { await deleteDoc(doc(db, "sessions", u.uid)); toast("تم إنهاء الجلسة"); }
    });
  }

  if (b.dataset.act === "del") {
    modal("مسح مستخدم", `<p>هتمسح المستخدم <b>${esc(u.name)}</b> (<span class="mono">${esc(u.employeeId)}</span>) ومش هيقدر يدخل تاني. متأكد؟</p>
      <p class="sub">لو عايز بس تمنعه مؤقتًا، الأفضل زرار "حظر".</p>`, {
      submitText: "مسح", danger: true,
      async onSubmit() {
        const batch = writeBatch(db);
        batch.delete(doc(db, "users", u.uid));
        batch.delete(doc(db, "loginMap", u.employeeId));
        await batch.commit();
        toast("تم مسح المستخدم");
      }
    });
  }
});

/* ------------------------------------------------------------------ site settings */
function renderSite() {
  const s = api.site;
  const on = s.maintenance === true;
  $("swMaint").checked = on;
  $("siteState").className = "badge " + (on ? "off" : "ok");
  $("siteState").textContent = on ? "الموقع في وضع الصيانة" : "الموقع شغال";
  $("maintBanner").classList.toggle("hidden", !(on && isAdmin));
  if (document.activeElement !== $("maintMsg")) $("maintMsg").value = s.message || "";
}

if (isAdmin) {
  $("swMaint").addEventListener("change", e => {
    const on = e.target.checked;
    e.target.checked = !on;                       // نرجّعه لحد ما الأدمن يأكد
    modal(on ? "تفعيل وضع الصيانة" : "إيقاف وضع الصيانة", on
      ? "<p>الموقع هيتقفل على كل المستخدمين العاديين فورًا (حتى اللي فاتحينه دلوقتي) وهيشوفوا رسالة الصيانة. انت بس اللي هتفضل تدخل. متأكد؟</p>"
      : "<p>الموقع هيرجع شغال لكل المستخدمين.</p>", {
      submitText: on ? "قفل الموقع" : "تشغيل الموقع", danger: on,
      async onSubmit() {
        await setDoc(doc(db, "meta", "site"), { maintenance: on, message: $("maintMsg").value.trim(), updatedAt: serverTimestamp() }, { merge: true });
        toast(on ? "الموقع اتقفل للصيانة" : "الموقع شغال تاني");
      }
    });
  });
  $("btnSaveMsg").onclick = async () => {
    try { await setDoc(doc(db, "meta", "site"), { message: $("maintMsg").value.trim() }, { merge: true }); toast("تم حفظ الرسالة"); }
    catch (e) { toast(arErr(e), "err"); }
  };
  $("btnPush").onclick = async () => {
    try {
      await setDoc(doc(db, "meta", "site"), { version: Date.now().toString(36), versionAt: serverTimestamp() }, { merge: true });
      toast("تم إرسال التحديث، الكل هياخد النسخة الجديدة خلال ثواني");
    } catch (e) { toast(arErr(e), "err"); }
  };
  api.onSite(renderSite);
}

/* ------------------------------------------------------------------ my password / logout */
$("btnPass").onclick = () => modal("تغيير كلمة المرور", `
  <div class="field"><label>كلمة المرور الحالية</label><input name="cur" type="password" dir="ltr" required autocomplete="current-password"></div>
  <div class="field"><label>كلمة المرور الجديدة</label><input name="n1" type="password" dir="ltr" minlength="6" required autocomplete="new-password"></div>
  <div class="field"><label>تأكيد كلمة المرور الجديدة</label><input name="n2" type="password" dir="ltr" minlength="6" required autocomplete="new-password"></div>`, {
  async onSubmit(form) {
    if (form.elements.n1.value !== form.elements.n2.value) throw { message: "كلمتا المرور الجديدتان مش متطابقتين." };
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, form.elements.cur.value));
    await updatePassword(user, form.elements.n1.value);
    toast("تم تغيير كلمة المرور");
  }
});
$("btnOut").onclick = logout;

/* ------------------------------------------------------------------ tabs + boot */
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
  ["tools", "users", "manage", "prices", "settings"].forEach(n => $("tab-" + n).classList.toggle("hidden", n !== btn.dataset.tab));
  if (btn.dataset.tab === "users") startUsers();
  if (btn.dataset.tab === "prices") openPrices();
}));

// تاب الأسعار بيتحمّل أول ما تفتحه بس (عشان اللوحة تفضل سريعة)
let pricesOpened = false;
async function openPrices() {
  if (pricesOpened || !isAdmin) return;
  pricesOpened = true;
  try {
    const mod = await import("./prices-admin.js");
    mod.mount({ db, me, root: $("pricesRoot"), esc, toast, arErr, modal });
  } catch (e) { pricesOpened = false; toast(arErr(e), "err"); }
}

// الشاشة بتظهر فورًا من بيانات حسابك، والأدوات بتتحمّل من الكاش وبعدين بتتحدّث لحظيًا
$("whoName").textContent = me.name;
$("whoRole").textContent = roleLabel(me.role);
if (isAdmin) { document.querySelectorAll(".adm").forEach(el => el.classList.remove("hidden")); renderSite(); }
$("boot").classList.add("hidden");
$("app").classList.remove("hidden");

api.onProfile(p => { me = p; $("whoName").textContent = p.name; renderTools(); if (usersStarted) renderUsers(); });

onSnapshot(collection(db, "tools"), snap => {
  tools = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
  renderTools();
  if (isAdmin) { renderManage(); if (usersStarted) renderUsers(); }
}, err => { $("toolsGrid").innerHTML = '<div class="empty" style="grid-column:1/-1">' + esc(arErr(err)) + "</div>"; });
