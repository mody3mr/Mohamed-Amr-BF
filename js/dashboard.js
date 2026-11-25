import { db, secondaryAuth } from "./firebase.js";
import {
  createUserWithEmailAndPassword, signOut, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, logout, canSee, esc, arErr, toast, normId, validId, makeEmail } from "./common.js";

const $ = id => document.getElementById(id);
const { user, profile: me } = await guard();
const isAdmin = me.role === "admin";
let tools = [];
let users = [];

const ICONS = [
  ["fa-solid fa-table-list", "جدول"], ["fa-solid fa-file-excel", "إكسيل"], ["fa-solid fa-chart-column", "رسم بياني"],
  ["fa-solid fa-truck", "شحن"], ["fa-solid fa-triangle-exclamation", "تنبيه"], ["fa-solid fa-pen-to-square", "تعديل"],
  ["fa-solid fa-calculator", "حاسبة"], ["fa-solid fa-boxes-stacked", "مخزون"], ["fa-solid fa-file-pdf", "PDF"],
  ["fa-solid fa-gears", "أدوات"], ["fa-solid fa-screwdriver-wrench", "صيانة"], ["fa-solid fa-magnifying-glass", "بحث"]
];

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

function accessHtml(allTools, ids) {
  const list = tools.length
    ? tools.map(t => `<label><input type="checkbox" name="tid" value="${esc(t.id)}" ${ids.includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")
    : '<span class="sub" style="margin:0">مفيش أدوات لسه</span>';
  return `<div class="field"><label>الأدوات المسموحة</label>
    <label style="font-weight:500;display:flex;gap:8px;align-items:center"><input type="checkbox" name="allTools" ${allTools ? "checked" : ""} style="width:auto"> كل الأدوات (الحالية والجديدة)</label>
    <div class="checks" data-checks>${list}</div></div>`;
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

/* ------------------------------------------------------------------ data */
async function loadTools() {
  const snap = await getDocs(collection(db, "tools"));
  tools = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
}
async function loadUsers() {
  const snap = await getDocs(collection(db, "users"));
  users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)));
}

/* ------------------------------------------------------------------ render: tools */
function renderTools() {
  const grid = $("toolsGrid");
  const mine = tools.filter(t => canSee(me, t.id));
  if (!mine.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      ${isAdmin && !tools.length
        ? `مفيش أدوات لسه.<br><br><button class="btn" id="btnSeed"><i class="fa-solid fa-wand-magic-sparkles"></i> إضافة أداة FPs الجاهزة</button>`
        : "مفيش أدوات متاحة لحسابك دلوقتي. كلّم مسؤول النظام."}</div>`;
    const seed = $("btnSeed"); if (seed) seed.onclick = seedDefault;
    return;
  }
  grid.innerHTML = mine.map(t => `<a class="tool" href="tool.html?id=${encodeURIComponent(t.id)}">
      <div class="ico"><i class="${/^fa-[a-z]+ fa-[a-z0-9-]+$/.test(t.icon || "") ? esc(t.icon) : "fa-solid fa-screwdriver-wrench"}"></i></div>
      <h3>${esc(t.name)}</h3><p>${esc(t.description || "")}</p></a>`).join("");
}

async function seedDefault() {
  const batch = writeBatch(db);
  batch.set(doc(db, "tools", "fps-tools"), {
    name: "أدوات FPs (Pivot / ملاحظات / اوت بوت)",
    description: "Pivot لشيت أودو، إضافة الملاحظات، وفحص الاوت من المندوب والمصنع.",
    icon: "fa-solid fa-table-list", type: "file", path: "tools/fps-tools.html", createdAt: serverTimestamp()
  });
  await batch.commit();
  await loadTools(); renderTools(); renderManage();
  toast("تمت إضافة الأداة");
}

/* ------------------------------------------------------------------ render: manage tools */
function renderManage() {
  const body = $("toolsBody");
  if (!tools.length) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:30px">مفيش أدوات. اضغط "أداة جديدة" أو أضف الأداة الجاهزة من تاب "الأدوات".</td></tr>`;
    return;
  }
  body.innerHTML = tools.map(t => `<tr>
    <td><i class="${/^fa-[a-z]+ fa-[a-z0-9-]+$/.test(t.icon || "") ? esc(t.icon) : "fa-solid fa-screwdriver-wrench"}" style="color:var(--brand)"></i> <b>${esc(t.name)}</b></td>
    <td><span class="badge">${t.type === "html" ? "كود HTML" : "ملف في المشروع"}</span></td>
    <td>${t.type === "html" ? '<span class="sub" style="margin:0">محفوظ في قاعدة البيانات</span>' : `<span class="mono">${esc(t.path)}</span>`}</td>
    <td><div class="acts">
      <button class="btn ghost sm" data-act="edit" data-id="${esc(t.id)}"><i class="fa-solid fa-pen"></i> تعديل</button>
      <button class="btn ghost sm" data-act="del" data-id="${esc(t.id)}"><i class="fa-solid fa-trash"></i> مسح</button>
    </div></td></tr>`).join("");
}

function toolModal(existing, existingHtml) {
  const t = existing || { name: "", description: "", icon: ICONS[0][0], type: "html", path: "" };
  const title = existing ? "تعديل أداة" : "أداة جديدة";
  modal(title, `
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
    submitText: "حفظ",
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
      await loadTools(); renderTools(); renderManage();
      toast("تم حفظ الأداة");
    }
  });
}

$("btnAddTool").onclick = () => toolModal(null, "");
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
        await loadTools(); renderTools(); renderManage();
        toast("تم مسح الأداة");
      }
    });
  }
});

/* ------------------------------------------------------------------ render: users */
function renderUsers() {
  $("usersBody").innerHTML = users.map(u => {
    const you = u.uid === me.uid;
    const access = u.role === "admin" || u.allTools ? "الكل" : `${(u.toolIds || []).filter(id => tools.some(t => t.id === id)).length} أداة`;
    return `<tr>
      <td><span class="mono">${esc(u.employeeId)}</span></td>
      <td>${esc(u.name)} ${you ? '<span class="badge">انت</span>' : ""}</td>
      <td>${roleLabel(u.role)}</td>
      <td><span class="badge ${u.active ? "ok" : "off"}">${u.active ? "مفعّل" : "موقوف"}</span></td>
      <td>${access}</td>
      <td><div class="acts">
        <button class="btn ghost sm" data-act="edit" data-uid="${esc(u.uid)}"><i class="fa-solid fa-pen"></i> تعديل</button>
        ${you ? "" : `<button class="btn ghost sm" data-act="pw" data-uid="${esc(u.uid)}"><i class="fa-solid fa-key"></i> باسورد</button>
        <button class="btn ghost sm" data-act="del" data-uid="${esc(u.uid)}"><i class="fa-solid fa-trash"></i></button>`}
      </div></td></tr>`;
  }).join("");
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
  return d;
}

$("btnAddUser").onclick = () => modal("مستخدم جديد", `
  <div class="field"><label>الاسم</label><input name="name" required maxlength="80"></div>
  <div class="row">
    <div class="field"><label>الرقم الوظيفي</label><input name="empId" dir="ltr" required><small>حروف إنجليزي/أرقام فقط</small></div>
    <div class="field"><label>الدور</label><select name="role"><option value="user">مستخدم</option><option value="admin">مسؤول</option></select></div>
  </div>
  <div class="field"><label>كلمة المرور</label><input name="pass" type="text" dir="ltr" minlength="6" required autocomplete="off"><small>6 على الأقل. ابعتها للموظف وهو يقدر يغيرها بعد الدخول.</small></div>
  ${accessHtml(true, [])}`, {
  submitText: "إنشاء",
  onMount: wireAccess,
  async onSubmit(form) {
    const name = form.elements.name.value.trim();
    const id = normId(form.elements.empId.value);
    const pass = form.elements.pass.value;
    if (!validId(id)) throw { message: "الرقم الوظيفي لازم حروف إنجليزي/أرقام (2 إلى 32)، ويقدر يحتوي . _ -" };
    if (pass.length < 6) throw { message: "كلمة المرور لازم 6 على الأقل." };
    if ((await getDoc(doc(db, "loginMap", id))).exists()) throw { message: "الرقم الوظيفي ده مستخدم قبل كده." };
    const { uid, email } = await createAuthAccount(id, pass);
    const acc = readAccess(form);
    const batch = writeBatch(db);
    batch.set(doc(db, "users", uid), {
      uid, employeeId: id, name, role: form.elements.role.value, active: true,
      allTools: acc.allTools, toolIds: acc.toolIds, authEmail: email, createdAt: serverTimestamp(), createdBy: me.uid
    });
    batch.set(doc(db, "loginMap", id), { email, uid });
    await batch.commit();
    await loadUsers(); renderUsers();
    toast("تم إنشاء المستخدم");
  }
});

$("usersBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const u = users.find(x => x.uid === b.dataset.uid); if (!u) return;
  const you = u.uid === me.uid;

  if (b.dataset.act === "edit") {
    modal("تعديل مستخدم", `
      <div class="field"><label>الاسم</label><input name="name" value="${esc(u.name)}" required maxlength="80"></div>
      <div class="row">
        <div class="field"><label>الرقم الوظيفي</label><input name="empId" dir="ltr" value="${esc(u.employeeId)}" required></div>
        <div class="field"><label>الدور</label><select name="role" ${you ? "disabled" : ""}>
          <option value="user" ${u.role !== "admin" ? "selected" : ""}>مستخدم</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>مسؤول</option></select></div>
      </div>
      <div class="field"><label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" name="active" style="width:auto" ${u.active ? "checked" : ""} ${you ? "disabled" : ""}> الحساب مفعّل</label>
        ${you ? '<small>مينفعش توقف أو تغيّر دور حسابك انت.</small>' : "<small>لو شلت العلامة الموظف مش هيقدر يدخل.</small>"}</div>
      ${accessHtml(!!u.allTools, u.toolIds || [])}`, {
      onMount: wireAccess,
      async onSubmit(form) {
        const name = form.elements.name.value.trim();
        const newId = normId(form.elements.empId.value);
        if (!validId(newId)) throw { message: "الرقم الوظيفي لازم حروف إنجليزي/أرقام (2 إلى 32)." };
        const acc = readAccess(form);
        const patch = { name, allTools: acc.allTools, toolIds: acc.toolIds };
        if (!you) { patch.role = form.elements.role.value; patch.active = form.elements.active.checked; }
        const batch = writeBatch(db);
        if (newId !== u.employeeId) {
          if ((await getDoc(doc(db, "loginMap", newId))).exists()) throw { message: "الرقم الوظيفي الجديد مستخدم قبل كده." };
          batch.delete(doc(db, "loginMap", u.employeeId));
          batch.set(doc(db, "loginMap", newId), { email: u.authEmail, uid: u.uid });
          patch.employeeId = newId;
        }
        batch.update(doc(db, "users", u.uid), patch);
        await batch.commit();
        await loadUsers(); renderUsers();
        toast("تم حفظ التعديل");
      }
    });
  }

  if (b.dataset.act === "pw") {
    modal(`كلمة مرور جديدة — ${u.name}`, `
      <p class="sub">الموظف هيدخل بالرقم الوظيفي <b class="mono">${esc(u.employeeId)}</b> وكلمة المرور الجديدة.</p>
      <div class="field"><label>كلمة المرور الجديدة</label><input name="pass" type="text" dir="ltr" minlength="6" required autocomplete="off"></div>`, {
      submitText: "تغيير",
      async onSubmit(form) {
        const pass = form.elements.pass.value;
        if (pass.length < 6) throw { message: "كلمة المرور لازم 6 على الأقل." };
        // Firebase مش بيسمح لأدمن من المتصفح يغيّر باسورد حد تاني،
        // فبنعمل حساب دخول جديد بالباسورد الجديد ونحوّل عليه نفس بيانات الموظف.
        const { uid: newUid, email } = await createAuthAccount(u.employeeId, pass);
        const batch = writeBatch(db);
        batch.set(doc(db, "users", newUid), { ...cleanUserData(u), uid: newUid, authEmail: email, passwordResetAt: serverTimestamp() });
        batch.delete(doc(db, "users", u.uid));
        batch.set(doc(db, "loginMap", u.employeeId), { email, uid: newUid });
        await batch.commit();
        await loadUsers(); renderUsers();
        toast("تم تغيير كلمة المرور");
      }
    });
  }

  if (b.dataset.act === "del") {
    modal("مسح مستخدم", `<p>هتمسح المستخدم <b>${esc(u.name)}</b> (<span class="mono">${esc(u.employeeId)}</span>) ومش هيقدر يدخل تاني. متأكد؟</p>
      <p class="sub">لو عايز بس تمنعه مؤقتًا، الأفضل "تعديل" وتشيل علامة "الحساب مفعّل".</p>`, {
      submitText: "مسح", danger: true,
      async onSubmit() {
        const batch = writeBatch(db);
        batch.delete(doc(db, "users", u.uid));
        batch.delete(doc(db, "loginMap", u.employeeId));
        await batch.commit();
        await loadUsers(); renderUsers();
        toast("تم مسح المستخدم");
      }
    });
  }
});

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
  ["tools", "users", "manage"].forEach(n => $("tab-" + n).classList.toggle("hidden", n !== btn.dataset.tab));
}));

try {
  $("whoName").textContent = me.name;
  $("whoRole").textContent = roleLabel(me.role);
  await loadTools();
  if (isAdmin) {
    document.querySelectorAll(".adm").forEach(el => el.classList.remove("hidden"));
    await loadUsers();
    renderUsers(); renderManage();
  }
  renderTools();
  $("boot").classList.add("hidden");
  $("app").classList.remove("hidden");
} catch (e) {
  console.error(e);
  $("boot").innerHTML = '<div class="msg err">' + esc(arErr(e)) + "</div>";
}
