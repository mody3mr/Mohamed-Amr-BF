import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// كاش محلي دايم في المتصفح: الصفحات بتفتح فورًا من الكاش وبعدين بتتحدّث من السيرفر.
let _db;
try {
  _db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  _db = getFirestore(app);   // لو المتصفح مش بيدعم الكاش (مثلًا وضع التصفح الخاص)
}
export const db = _db;

// نسخة تانية من Firebase بتستخدم بس عشان الأدمن يعمل حساب لموظف
// من غير ما يتسجل خروج من حسابه هو.
export function secondaryAuth() {
  const name = "secondary";
  const sec = getApps().find(a => a.name === name) || initializeApp(firebaseConfig, name);
  return getAuth(sec);
}
