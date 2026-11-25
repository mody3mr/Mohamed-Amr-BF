import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normId, arErr } from "./common.js";

const $ = id => document.getElementById(id);
const showErr = m => { $("error").textContent = m; $("error").classList.remove("hidden"); };

if (new URLSearchParams(location.search).get("reason") === "disabled") {
  $("notice").textContent = "الحساب ده متوقف أو مش موجود. كلّم مسؤول النظام.";
  $("notice").classList.remove("hidden");
}

// لو فيه جلسة شغالة وحساب مفعّل، ندخله على طول
onAuthStateChanged(auth, async user => {
  if (!user) return;
  try {
    const s = await getDoc(doc(db, "users", user.uid));
    if (s.exists() && s.data().active === true) location.replace("dashboard.html");
  } catch (_) { /* نسيبه يسجل دخول من جديد */ }
});

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  $("error").classList.add("hidden");
  const id = normId($("empId").value);
  const pass = $("pass").value;
  if (!id || !pass) return;
  const btn = $("btn"); btn.disabled = true;
  try {
    const map = await getDoc(doc(db, "loginMap", id));
    if (!map.exists()) throw { code: "auth/invalid-credential" };
    const cred = await signInWithEmailAndPassword(auth, map.data().email, pass);
    const snap = await getDoc(doc(db, "users", cred.user.uid));
    if (!snap.exists() || snap.data().active !== true) {
      await signOut(auth);
      throw { message: "الحساب ده متوقف. كلّم مسؤول النظام." };
    }
    location.replace("dashboard.html");
  } catch (err) {
    showErr(arErr(err));
    btn.disabled = false;
  }
});
