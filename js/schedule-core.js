// أدوات مشتركة لصفحات نظام المواعيد (الليدر / مندوب المخزن / الأدمن)
import { esc, arErr, initThemeButton, logout } from "./common.js";

export const $ = id => document.getElementById(id);

/* ---------- التاريخ والوقت (بتوقيت القاهرة) ---------- */
export const cairoToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const cairoNowHM = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
export function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const tabName = iso => { const [, m, d] = iso.split("-"); return `${+d}/${+m}`; };   // 2026-11-27 -> 27/11
export const toMin = t => { const [h, m] = String(t).split(":"); return +h * 60 + +m; };
// متأخر = وصل بعد الميعاد بأكتر من 30 دقيقة (الوصول المبكر عادي)
export const isLate = (arr, sched) => !!arr && !!sched && toMin(arr) > toMin(sched) + 30;
export const lateBy = (arr, sched) => toMin(arr) - toMin(sched);
export function fmt12(t) {
  if (!t) return "—";
  let [h, m] = t.split(":").map(Number); const ap = h < 12 ? "ص" : "م"; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
export const dayLabel = iso => new Date(iso + "T12:00:00").toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" });
export function tsLabel(ts) {
  if (!ts || !ts.toDate) return "—";
  return ts.toDate().toLocaleString("ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
export const tsMs = ts => (ts && ts.toMillis ? ts.toMillis() : 0);

/* ---------- حقل وقت: اختيار من ساعة النظام (مفيش كتابة حرة) + زرار "الآن" ---------- */
export function timeField(name, value = "", { disabled = false } = {}) {
  return `<span class="tf"><input type="time" name="${name}" value="${esc(value || "")}" ${disabled ? "disabled" : ""}>
    <button type="button" class="btn ghost sm" data-now ${disabled ? "disabled" : ""} title="الوقت دلوقتي">الآن</button></span>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-now]");
  if (!b) return;
  const inp = b.previousElementSibling;
  if (inp && !inp.disabled) { inp.value = cairoNowHM(); inp.dispatchEvent(new Event("input", { bubbles: true })); }
});

/* ---------- نافذة منبثقة (نفس شكل لوحة التحكم) ---------- */
export function modal(title, bodyHtml, { onSubmit, submitText = "حفظ", danger = false, onMount, wide = false } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<form class="modal" ${wide ? 'style="max-width:760px"' : ""}><h3>${esc(title)}</h3><div class="msg err hidden" data-err></div>${bodyHtml}
    <div class="actions"><button class="btn ${danger ? "danger" : ""}" type="submit">${esc(submitText)}</button>
    <button type="button" class="btn ghost" data-close>إلغاء</button></div></form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector("form");
  const close = () => ov.remove();
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  form.querySelector("[data-close]").addEventListener("click", close);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]"), err = form.querySelector("[data-err]");
    err.classList.add("hidden"); btn.disabled = true;
    try { await onSubmit(form); close(); }
    catch (ex) {
      err.textContent = ex && ex.code ? arErr(ex) : (ex && ex.message) || "حصل خطأ";
      err.classList.remove("hidden"); btn.disabled = false;
    }
  });
  if (onMount) onMount(form);
  return { form, close };
}
// تأكيد بنعم/لأ: بيرجّع Promise<boolean>
export function confirmBox(title, bodyHtml, { submitText = "تأكيد", danger = false } = {}) {
  return new Promise(res => {
    let done = false;
    const m = modal(title, bodyHtml, { submitText, danger, onSubmit: async () => { done = true; res(true); } });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.form)) { obs.disconnect(); if (!done) res(false); } });
    obs.observe(document.body, { childList: true });
  });
}

/* ---------- هيكل الصفحة (الاسم/الثيم/الخروج) ---------- */
export function initShell(api) {
  initThemeButton($("btnTheme"));
  $("btnOut").onclick = logout;
  $("whoName").textContent = api.profile.name;
  api.onProfile(p => { $("whoName").textContent = p.name; });
  $("boot").classList.add("hidden");
  $("app").classList.remove("hidden");
}
export function message(el, html, kind = "info") {
  el.className = "msg " + (kind === "ok" ? "okm" : kind);
  el.innerHTML = html;
  el.classList.remove("hidden");
}
