// قايمة البروفايل (صورة بالحروف الأولى + الاسم + الدور) + الإعدادات (تغيير كلمة المرور) + تسجيل الخروج
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { esc, arErr, toast, logout, logActivity, initThemeButton } from "./common.js";

export function roleLabel(p) {
  if (p.role === "admin") return "مسؤول";
  return ({ leader: "ليدر", rep: "مندوب", dock: "مندوب مخزن" })[p.sched] || "مستخدم";
}
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + ((parts[1] || "")[0] || "")).toUpperCase();
}

function passwordModal(user) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<form class="modal"><h3>الإعدادات: تغيير كلمة المرور</h3><div class="msg err hidden" data-err></div>
    <div class="field"><label>كلمة المرور الحالية</label><input name="cur" type="password" dir="ltr" required autocomplete="current-password"></div>
    <div class="field"><label>كلمة المرور الجديدة</label><input name="n1" type="password" dir="ltr" minlength="6" required autocomplete="new-password"></div>
    <div class="field"><label>تأكيد كلمة المرور الجديدة</label><input name="n2" type="password" dir="ltr" minlength="6" required autocomplete="new-password"></div>
    <div class="actions"><button class="btn" type="submit">حفظ</button><button type="button" class="btn ghost" data-close>إلغاء</button></div></form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector("form"), close = () => ov.remove();
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  form.querySelector("[data-close]").onclick = close;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]"), err = form.querySelector("[data-err]");
    err.classList.add("hidden"); btn.disabled = true;
    try {
      if (form.elements.n1.value !== form.elements.n2.value) throw { message: "كلمتا المرور الجديدتان مش متطابقتين." };
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, form.elements.cur.value));
      await updatePassword(user, form.elements.n1.value);
      logActivity("password", "غيّر كلمة المرور");
      toast("تم تغيير كلمة المرور"); close();
    } catch (ex) { err.textContent = ex && ex.code ? arErr(ex) : (ex && ex.message) || "حصل خطأ"; err.classList.remove("hidden"); btn.disabled = false; }
  });
  form.querySelector("input").focus();
}

export function mountProfile(api) {
  const $ = id => document.getElementById(id);
  const render = p => { $("whoName").textContent = p.name; $("whoRole").textContent = roleLabel(p); $("pfAv").textContent = initials(p.name); };
  render(api.profile); api.onProfile(render);
  const menu = $("pfMenu");
  $("pfBtn").onclick = e => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  document.addEventListener("click", e => { if (!$("profile").contains(e.target)) menu.classList.add("hidden"); });
  $("btnOut").onclick = logout;
  $("pfSettings").onclick = () => { menu.classList.add("hidden"); passwordModal(api.user); };
  initThemeButton($("btnTheme"));
}
