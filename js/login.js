import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normId, validId, arErr, esc } from "./common.js";

// رقم واتساب مدير النظام (للتواصل لما حد ينسى كلمة المرور)
const ADMIN_WHATSAPP = "201094264296";

const $ = id => document.getElementById(id);
const showErr = m => { $("error").textContent = m; $("error").classList.remove("hidden"); };
const hideErr = () => $("error").classList.add("hidden");

let timer = null;
let current = null;   // { id, data } بعد ما الرقم الوظيفي يتأكد

function setStatus(html, kind = "") { $("status").className = "status " + kind; $("status").innerHTML = html; }

function lockForm() {
  current = null;
  $("pass").disabled = true; $("pass").value = "";
  $("pass2").disabled = true; $("pass2").value = "";
  $("confirmField").classList.add("hidden");
  $("passLabel").textContent = "كلمة المرور";
  $("btnText").textContent = "دخول";
  $("btn").disabled = true;
}

if (new URLSearchParams(location.search).get("reason") === "disabled") {
  $("notice").textContent = "الحساب ده متوقف أو مش موجود. كلّم مسؤول النظام.";
  $("notice").classList.remove("hidden");
}

$("waLink").href = "https://wa.me/" + ADMIN_WHATSAPP;
$("btnForgot").onclick = () => $("forgotModal").classList.remove("hidden");
$("btnForgotClose").onclick = () => $("forgotModal").classList.add("hidden");
$("forgotModal").addEventListener("mousedown", e => { if (e.target === $("forgotModal")) $("forgotModal").classList.add("hidden"); });

// لو فيه جلسة شغالة وحساب مفعّل، ندخله على طول
onAuthStateChanged(auth, async user => {
  if (!user) return;
  try {
    const s = await getDoc(doc(db, "users", user.uid));
    if (s.exists() && s.data().active === true) location.replace("dashboard.html");
  } catch (_) { /* نسيبه يسجل دخول من جديد */ }
});

// ---- فحص الرقم الوظيفي لحظيًا ----
$("empId").addEventListener("input", () => {
  clearTimeout(timer);
  hideErr(); lockForm();
  const v = normId($("empId").value);
  if (!v) return setStatus("");
  setStatus('<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحقق...');
  timer = setTimeout(() => checkId(v), 500);
});

async function checkId(id) {
  if (!validId(id)) return setStatus('<i class="fa-solid fa-circle-xmark"></i> الرقم الوظيفي غير مسجل في النظام', "bad");
  try {
    const snap = await getDoc(doc(db, "loginMap", id));
    if (normId($("empId").value) !== id) return;       // الرقم اتغير أثناء الفحص
    if (!snap.exists()) return setStatus('<i class="fa-solid fa-circle-xmark"></i> الرقم الوظيفي غير مسجل في النظام', "bad");
    const d = snap.data();
    if (d.active === false) return setStatus('<i class="fa-solid fa-ban"></i> تم إيقاف هذا الحساب من الإدارة', "bad");

    current = { id, data: d };
    const name = d.first ? esc(d.first) : "";
    if (d.needsPassword) {
      setStatus(`<i class="fa-solid fa-circle-check"></i> أهلاً${name ? "، " + name : ""} — دي أول مرة تدخل، اختار كلمة مرور خاصة بيك`, "ok");
      $("passLabel").textContent = "اختار كلمة مرور جديدة";
      $("confirmField").classList.remove("hidden");
      $("pass2").disabled = false;
      $("pass2").required = true;
      $("btnText").textContent = "حفظ كلمة المرور ودخول";
      $("pass").setAttribute("autocomplete", "new-password");
    } else {
      setStatus(`<i class="fa-solid fa-circle-check"></i> أهلاً${name ? "، " + name : ""}`, "ok");
      $("pass").setAttribute("autocomplete", "current-password");
    }
    $("pass").disabled = false; $("btn").disabled = false;
    $("pass").focus();
  } catch (e) {
    console.error(e);
    setStatus('<i class="fa-solid fa-wifi"></i> تأكد من اتصال الإنترنت', "warn");
  }
}

// ---- تسجيل الدخول ----
$("form").addEventListener("submit", async e => {
  e.preventDefault();
  hideErr();
  if (!current) return;
  const { id, data: d } = current;
  const pass = $("pass").value;
  const btn = $("btn");

  if (d.needsPassword) {
    if (pass.length < 6) return showErr("كلمة المرور لازم تكون 6 حروف أو أرقام على الأقل.");
    if (pass !== $("pass2").value) return showErr("كلمتا المرور مش متطابقتين.");
  }

  btn.disabled = true;
  try {
    let cred;
    if (d.needsPassword) {
      try {
        // أول دخول: بندخل بالمفتاح المؤقت وبعدين نغيّر الباسورد للي الموظف اختاره
        cred = await signInWithEmailAndPassword(auth, d.email, d.initKey);
        await updatePassword(cred.user, pass);
      } catch (ex) {
        // ممكن يكون الباسورد اتغير قبل كده والعلامة لسه ما اتمسحتش
        if (ex && (ex.code === "auth/invalid-credential" || ex.code === "auth/wrong-password")) {
          cred = await signInWithEmailAndPassword(auth, d.email, pass);
        } else throw ex;
      }
      try {
        await updateDoc(doc(db, "loginMap", id), { needsPassword: false, initKey: deleteField() });
        await updateDoc(doc(db, "users", cred.user.uid), { pending: false });
      } catch (_) { /* مش مشكلة، هتتظبط في الدخول الجاي */ }
    } else {
      cred = await signInWithEmailAndPassword(auth, d.email, pass);
    }

    const snap = await getDoc(doc(db, "users", cred.user.uid));
    if (!snap.exists() || snap.data().active !== true) {
      await signOut(auth);
      throw { message: "الحساب ده متوقف. كلّم مسؤول النظام." };
    }
    location.replace("dashboard.html");
  } catch (err) {
    const wrong = err && (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password");
    showErr(wrong ? "كلمة المرور غير صحيحة." : arErr(err));
    btn.disabled = false;
  }
});
