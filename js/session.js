// قفل الجلسة على جهاز واحد (للمستخدم العادي؛ الأدمن مستثنى).
// الفكرة: مستند sessions/{uid} فيه رقم جلسة (sid) عشوائي مخزّن في المتصفح، وبيتجدّد بنبضة كل 30 ثانية.
// قواعد Firestore هي اللي بتمنع أي جهاز تاني ياخد الجلسة طول ما النبضة طازة (أقل من SESSION_TTL_S ثانية).
import { db } from "./firebase.js";
import {
  doc, runTransaction, updateDoc, onSnapshot, serverTimestamp, getDocFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const SESSION_TTL_S = 120;      // لازم تتطابق مع duration في firestore.rules
const HEARTBEAT_MS = 30000;
const RECENT_MS = 25000;               // لو آخر نبضة ناجحة من نفس المتصفح أحدث من كده نفتح الصفحة فورًا

let SID = null;
export function getSid() {
  if (SID) return SID;
  try { const s = localStorage.getItem("sid"); if (s && s.length >= 20) return (SID = s); } catch (_) {}
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  SID = [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem("sid", SID); } catch (_) {}
  return SID;
}

// وصف مختصر للجهاز بيظهر للأدمن (مش بنخزّن الـ User-Agent كامل)
export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "جهاز";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "متصفح";
  return br + " · " + os;
}

const stampKey = uid => "sidAt_" + uid;
function stamp(uid) { try { localStorage.setItem(stampKey(uid), String(Date.now())); } catch (_) {} }
function recent(uid) { try { return Date.now() - (+localStorage.getItem(stampKey(uid)) || 0) < RECENT_MS; } catch (_) { return false; } }

// بياخد الجلسة لو مفيش جلسة شغالة على جهاز تاني. النتيجة:
//   {ok:true} | {ok:false,busy:true} (جلسة شغالة على جهاز تاني) | {ok:false,bound:true,device} (الحساب مربوط بجهاز تاني) | {ok:false,error}
// lock=true: الربط الدايم — أول جهاز يدخل بيتربط بيه الحساب لحد ما الأدمن يفك الربط (devices/{uid}).
export async function claimSession(uid, lock = true) {
  const ref = doc(db, "sessions", uid), dev = doc(db, "devices", uid), sid = getSid();
  try {
    await runTransaction(db, async tx => {
      // لازم كل القراءات تيجي قبل أي كتابة (شرط في Firestore transactions)
      const d = lock ? await tx.get(dev) : null;
      const s = await tx.get(ref);
      if (lock) {
        if (!d.exists()) tx.set(dev, { sid, device: deviceLabel(), boundAt: serverTimestamp() });
        else if (d.data().sid !== sid) { const e = new Error("bound"); e.code = "bound-other"; e.device = d.data().device || ""; throw e; }
      }
      const base = { sid, device: deviceLabel(), lastSeen: serverTimestamp(), closed: false };
      if (!s.exists()) tx.set(ref, { ...base, startedAt: serverTimestamp() });
      else if (s.data().sid === sid) tx.update(ref, base);
      else tx.update(ref, { ...base, startedAt: serverTimestamp() });
    });
    stamp(uid);
    return { ok: true };
  } catch (e) {
    if (e && e.code === "bound-other") return { ok: false, bound: true, device: e.device };
    if (e && e.code === "permission-denied") {
      if (lock) {   // نفرّق بين "مربوط بجهاز تاني" و"جلسة شغالة"
        try { const d = await getDocFromServer(dev); if (d.exists() && d.data().sid !== sid) return { ok: false, bound: true, device: d.data().device || "" }; } catch (_) {}
      }
      return { ok: false, busy: true };
    }
    console.error("claimSession", e);
    return { ok: false, error: e };
  }
}

// بيبدأ النبضة + بيراقب لو الجلسة اتاخدت منك أو الأدمن أنهاها. onKick("taken" | "ended")
export function watchSession(uid, onKick) {
  const ref = doc(db, "sessions", uid), sid = getSid();
  let dead = false, tmr = null, unsub = () => {};
  const kick = why => { if (dead) return; dead = true; clearInterval(tmr); unsub(); onKick(why); };
  const beat = () => updateDoc(ref, { sid, device: deviceLabel(), lastSeen: serverTimestamp(), closed: false })
    .then(() => stamp(uid))
    .catch(e => { if (e && e.code === "permission-denied") kick("taken"); else if (e && e.code === "not-found") kick("ended"); });
  unsub = onSnapshot(ref, snap => {
    if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
    if (!snap.exists()) return kick("ended");
    if (snap.data().sid !== sid) kick("taken");
  }, () => {});
  tmr = setInterval(beat, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
  window.addEventListener("online", beat);
}

// للـ guard: بيتأكد إن الجلسة بتاعتك وبيبدأ المراقبة
export async function sessionGate(uid, onKick, lock = true) {
  if (recent(uid)) { watchSession(uid, onKick); return { ok: true }; }
  const r = await claimSession(uid, lock);
  if (r.ok) watchSession(uid, onKick);
  return r;
}

// عند تسجيل الخروج: بنعلّم الجلسة "مقفولة" فأي جهاز يقدر يدخل على طول
export async function releaseSession(uid) {
  try {
    await Promise.race([
      updateDoc(doc(db, "sessions", uid), { sid: getSid(), lastSeen: serverTimestamp(), closed: true }),
      new Promise(r => setTimeout(r, 2500))
    ]);
  } catch (_) {}
  try { localStorage.removeItem(stampKey(uid)); } catch (_) {}
}

// وقت آخر نبضة طازة؟ (للأدمن: مؤشر "متصل الآن")
export function isLive(s) {
  if (!s || s.closed === true || !s.lastSeen || !s.lastSeen.toMillis) return false;
  return Date.now() - s.lastSeen.toMillis() < SESSION_TTL_S * 1000;
}
