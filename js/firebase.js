import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// نسخة تانية من Firebase بتستخدم بس عشان الأدمن يعمل حساب لموظف
// من غير ما يتسجل خروج من حسابه هو.
export function secondaryAuth() {
  const name = "secondary";
  const sec = getApps().find(a => a.name === name) || initializeApp(firebaseConfig, name);
  return getAuth(sec);
}
