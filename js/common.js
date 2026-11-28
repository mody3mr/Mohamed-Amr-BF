import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, collection, getDocs, onSnapshot, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { sessionGate, releaseSession } from "./session.js";

export const EMAIL_DOMAIN = "fps-portal.app";

// سجل النشاط (الأدمن بس هو اللي بيقراه). بنسجّل بدون ما نستنى، وأي فشل مش بيعطّل حاجة.
let ME = null;
export function logActivity(type, detail = "", who = ME) {
  try {
    if (!who) return Promise.resolve();
    return addDoc(collection(db, "activity"), {
      uid: who.uid, name: String(who.name || "").slice(0, 80), type: String(type).slice(0, 30),
      detail: String(detail).slice(0, 300), page: (location.pathname.split("/").pop() || "index.html").slice(0, 40), at: serverTimestamp()
    }).catch(() => {});
  } catch (_) { return Promise.resolve(); }
}
export function setActivityUser(u) { ME = u; }

export const normId = s => String(s || "").trim().toLowerCase();
export const validId = s => /^[a-z0-9._-]{2,32}$/.test(s);

// الإيميل ده داخلي بس (Firebase بيطلب إيميل). المستخدم عمره ما بيشوفه.
// فيه جزء عشوائي عشان لو موظف اتمسح وإتعمل تاني بنفس الرقم ميحصلش تعارض.
export function makeEmail(id) {
  const rnd = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${id}.${rnd}@${EMAIL_DOMAIN}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function arErr(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/invalid-credential": "الرقم الوظيفي أو كلمة المرور غير صحيحة.",
    "auth/wrong-password": "الرقم الوظيفي أو كلمة المرور غير صحيحة.",
    "auth/user-not-found": "الرقم الوظيفي أو كلمة المرور غير صحيحة.",
    "auth/too-many-requests": "محاولات كتير غلط. استنى شوية وحاول تاني.",
    "auth/network-request-failed": "مشكلة في الاتصال بالإنترنت.",
    "auth/weak-password": "كلمة المرور ضعيفة، لازم 6 حروف أو أرقام على الأقل.",
    "auth/requires-recent-login": "سجّل خروج وادخل تاني وبعدين جرب.",
    "auth/operation-not-allowed": "تسجيل الدخول بالإيميل/الباسورد مش مفعّل في Firebase (Authentication > Sign-in method).",
    "permission-denied": "مفيش صلاحية للعملية دي (راجع قواعد Firestore، وغالبًا لازم تنشرها من جديد).",
    "unavailable": "السيرفر مش متاح دلوقتي، حاول تاني."
  };
  return map[code] || ("حصل خطأ: " + (e && e.message ? e.message : code || "غير معروف"));
}

export function toast(msg, kind = "ok") {
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ------------------------------------------------------------------ الوضع الداكن / الفاتح */
export function getTheme() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
export function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (_) {}
  document.dispatchEvent(new CustomEvent("themechange", { detail: t }));
}
export function initThemeButton(btn) {
  if (!btn) return;
  const paint = () => { btn.innerHTML = getTheme() === "dark" ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>'; btn.title = getTheme() === "dark" ? "الوضع الفاتح" : "الوضع الداكن"; };
  btn.addEventListener("click", () => { setTheme(getTheme() === "dark" ? "light" : "dark"); paint(); });
  paint();
}

/* ------------------------------------------------------------------ تحديث الملفات من غير انتظار كاش GitHub */
// GitHub Pages بيخلّي المتصفح يحتفظ بالملفات 10 دقايق. لما الأدمن يضغط "تحديث الملفات للجميع"
// بنجبر المتصفح يجيب نسخة جديدة من كل الملفات وبعدين يعمل ريفريش مرة واحدة.
const CORE_ASSETS = [
  "index.html", "dashboard.html", "tool.html", "setup.html", "schedule.html", "schedule-admin.html", "css/style.css",
  "js/common.js", "js/session.js", "js/profile.js", "assets/logo.png", "js/prices-core.js", "js/prices-admin.js", "js/firebase.js", "js/firebase-config.js", "js/login.js", "js/dashboard.js", "js/tool.js", "js/setup.js", "js/schedule-core.js", "js/schedule.js", "js/schedule-admin.js"
];
async function refreshAssets() {
  const list = new Set(CORE_ASSETS);
  try {
    const snap = await getDocs(collection(db, "tools"));
    snap.docs.forEach(d => { const t = d.data(); if (t.type === "file" && t.path) list.add(t.path); });
  } catch (_) {}
  list.add("css/tools.css");
  await Promise.allSettled([...list].map(p => fetch(p, { cache: "reload" })));
}
async function checkVersion(v) {
  if (!v) return;
  let seen = null;
  try { seen = localStorage.getItem("assetsVersion"); } catch (_) {}
  if (seen === v) return;
  try { localStorage.setItem("assetsVersion", v); } catch (_) {}
  if (seen === null) return;                 // أول زيارة: الملفات أصلًا جديدة
  await refreshAssets();
  location.reload();
}

/* ------------------------------------------------------------------ شاشة الصيانة */
function showMaintenance(message) {
  document.body.innerHTML = `<div class="maint-screen"><div class="maint-card">
    <i class="fa-solid fa-screwdriver-wrench big"></i>
    <h2>الموقع تحت الصيانة</h2>
    <p>${esc(message || "بنعمل شوية تحديثات دلوقتي، ارجع كمان شوية.")}</p>
    <button class="btn ghost" id="maintOut"><i class="fa-solid fa-right-from-bracket"></i> تسجيل خروج</button>
  </div></div>`;
  document.getElementById("maintOut").onclick = logout;
}

/* ------------------------------------------------------------------ حماية الصفحات (لحظية) */
// بتسمع لحسابك ولإعدادات الموقع لحظيًا: لو اتحظرت أو الموقع اتقفل بتتنفّذ على طول من غير ما تعمل ريفريش.
export function guard({ admin = false } = {}) {
  return new Promise(resolve => {
    const off = onAuthStateChanged(auth, user => {
      off();
      if (!user) return location.replace("index.html");

      let profile = null, site = null, done = false, first = null;
      const api = {
        user,
        get profile() { return profile; },
        get site() { return site || {}; },
        _p: new Set(), _s: new Set(),
        onProfile(cb) { this._p.add(cb); },
        onSite(cb) { this._s.add(cb); }
      };

      const evaluate = () => {
        if (profile === null || site === null) return;
        if (!profile.exists || profile.active !== true) {
          signOut(auth).finally(() => location.replace("index.html?reason=disabled"));
          return;
        }
        if (admin && profile.role !== "admin") return location.replace("dashboard.html");
        if (site.maintenance === true && profile.role !== "admin") return showMaintenance(site.message);
        if (!done) {
          done = true; first = { role: profile.role };
          ME = { uid: user.uid, name: profile.name };
          logActivity("page", document.title.replace(/\s*\|.*$/, ""));
          if (profile.role === "admin") return resolve(api);        // الأدمن مستثنى من قفل الجهاز الواحد
          // المستخدم العادي: جلسة واحدة نشطة بس
          sessionGate(user.uid, why => signOut(auth).finally(() => location.replace("index.html?reason=session-" + why)), profile.deviceLock !== false).then(r => {
            if (r.ok) return resolve(api);
            if (r.bound) return signOut(auth).finally(() => location.replace("index.html?reason=session-bound"));
            if (r.busy) return signOut(auth).finally(() => location.replace("index.html?reason=session-busy"));
            document.body.innerHTML = `<div class="center-msg">تعذر التحقق من الجلسة، اتأكد من الإنترنت.<br><small style="opacity:.7" dir="ltr">${esc((r.error && (r.error.code || r.error.message)) || "")}</small><br><br><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div>`;
          });
        } else if (profile.role !== first.role) {
          location.reload();
        }
      };

      onSnapshot(doc(db, "users", user.uid), snap => {
        const was = profile;
        profile = snap.exists() ? { exists: true, uid: user.uid, ...snap.data() } : { exists: false };
        evaluate();
        if (done && was) api._p.forEach(cb => cb(profile));
      }, err => { console.error(err); document.body.innerHTML = '<div class="center-msg">تعذر تحميل الحساب: ' + esc(arErr(err)) + '</div>'; });

      onSnapshot(doc(db, "meta", "site"), snap => {
        const wasMaint = site && site.maintenance === true;
        site = snap.exists() ? snap.data() : {};
        // الصيانة خلصت: المستخدم العادي يرجع للموقع (الأدمن هو اللي قافلها فمحتاجش ريفريش)
        if (wasMaint && site.maintenance !== true && !(profile && profile.role === "admin")) return location.reload();
        evaluate();
        checkVersion(site.version);
        if (done) api._s.forEach(cb => cb(site));
      }, err => { console.error(err); site = {}; evaluate(); });
    });
  });
}

export async function logout() {
  try { await Promise.race([logActivity("logout"), new Promise(r => setTimeout(r, 1500))]); } catch (_) {}
  try { if (auth.currentUser) await releaseSession(auth.currentUser.uid); } catch (_) {}
  try { await signOut(auth); } catch (_) {}
  location.replace("index.html");
}

export function canSee(profile, toolId) {
  return profile.role === "admin" || profile.allTools === true || (profile.toolIds || []).includes(toolId);
}
