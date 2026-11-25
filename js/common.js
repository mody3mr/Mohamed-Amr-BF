import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const EMAIL_DOMAIN = "fps-portal.app";

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
    "permission-denied": "مفيش صلاحية للعملية دي (راجع قواعد Firestore).",
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

// بتحمي الصفحة: لازم يكون فيه مستخدم داخل وحسابه مفعّل.
export function guard({ admin = false } = {}) {
  return new Promise(resolve => {
    const off = onAuthStateChanged(auth, async user => {
      off();
      if (!user) return location.replace("index.html");
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists() || snap.data().active !== true) {
          await signOut(auth);
          return location.replace("index.html?reason=disabled");
        }
        const profile = { uid: user.uid, ...snap.data() };
        if (admin && profile.role !== "admin") return location.replace("dashboard.html");
        resolve({ user, profile });
      } catch (e) {
        console.error(e);
        document.body.innerHTML = '<div class="center-msg">تعذر تحميل الحساب: ' + esc(arErr(e)) + '</div>';
      }
    });
  });
}

export async function logout() {
  await signOut(auth);
  location.replace("index.html");
}

export function canSee(profile, toolId) {
  return profile.role === "admin" || profile.allTools === true || (profile.toolIds || []).includes(toolId);
}
