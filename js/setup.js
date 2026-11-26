import { auth, db } from "./firebase.js";
import { createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normId, validId, makeEmail, arErr, initThemeButton } from "./common.js";
initThemeButton(document.getElementById("btnTheme"));

const $ = id => document.getElementById(id);
const showErr = m => { $("error").textContent = m; $("error").classList.remove("hidden"); };

try {
  const s = await getDoc(doc(db, "meta", "setup"));
  $("loading").classList.add("hidden");
  if (s.exists()) $("locked").classList.remove("hidden");
  else $("form").classList.remove("hidden");
} catch (e) {
  $("loading").classList.add("hidden");
  showErr(arErr(e) + " — اتأكد من بيانات firebase-config.js ومن إنشاء Firestore ونشر القواعد.");
}

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  $("error").classList.add("hidden");
  const name = $("name").value.trim();
  const id = normId($("empId").value);
  const pass = $("pass").value;
  if (!validId(id)) return showErr("الرقم الوظيفي لازم يكون حروف إنجليزي/أرقام (2 إلى 32) ويقدر يحتوي . _ -");
  if (pass.length < 6) return showErr("كلمة المرور لازم 6 على الأقل.");
  if (pass !== $("pass2").value) return showErr("كلمتا المرور مش متطابقتين.");

  $("btn").disabled = true;
  let cred = null;
  try {
    const email = makeEmail(id);
    cred = await createUserWithEmailAndPassword(auth, email, pass);
    const uid = cred.user.uid;
    const batch = writeBatch(db);
    batch.set(doc(db, "users", uid), {
      uid, employeeId: id, name, role: "admin", active: true,
      allTools: true, toolIds: [], pending: false, authEmail: email, createdAt: serverTimestamp()
    });
    batch.set(doc(db, "loginMap", id), { email, uid, first: name.split(/\s+/)[0], active: true, needsPassword: false });
    batch.set(doc(db, "meta", "setup"), { doneAt: serverTimestamp(), by: uid });
    await batch.commit();
    location.replace("dashboard.html");
  } catch (err) {
    if (cred) { try { await deleteUser(cred.user); } catch (_) {} }   // نرجّع الحساب لو الكتابة فشلت
    showErr(arErr(err));
    $("btn").disabled = false;
  }
});
