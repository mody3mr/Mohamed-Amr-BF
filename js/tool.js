import { db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, canSee, esc, arErr } from "./common.js";

const $ = id => document.getElementById(id);
const fail = m => { $("state").innerHTML = '<div class="msg err">' + esc(m) + '</div>'; };

const { profile } = await guard();
const id = new URLSearchParams(location.search).get("id");

try {
  if (!id) throw { message: "الأداة غير محددة." };
  const snap = await getDoc(doc(db, "tools", id));
  if (!snap.exists()) throw { message: "الأداة دي مش موجودة." };
  const tool = snap.data();
  if (!canSee(profile, id)) throw { message: "مفيش عندك صلاحية لفتح الأداة دي." };

  document.title = tool.name + " | بوابة أدوات Odoo";
  $("toolName").textContent = tool.name;
  if (/^fa-[a-z]+ fa-[a-z0-9-]+$/.test(tool.icon || "")) $("toolIcon").className = tool.icon;

  const frame = $("frame");
  if (tool.type === "html") {
    const code = await getDoc(doc(db, "toolCode", id));
    if (!code.exists()) throw { message: "كود الأداة مش موجود." };
    frame.srcdoc = code.data().html;
  } else {
    if (!/^tools\/[A-Za-z0-9._-]+\.html$/.test(tool.path || "")) throw { message: "مسار الأداة غير صالح." };
    // نتأكد إن الملف موجود فعلًا على GitHub (ولو اترفع بالغلط جنب الصفحات بدل فولدر tools نستخدمه من هناك)
    let src = tool.path, answered = false, found = false;
    for (const cand of [tool.path, tool.path.split("/").pop()]) {
      try {
        const r = await fetch(cand, { method: "HEAD", cache: "no-store" });
        answered = true;
        if (r.ok) { src = cand; found = true; break; }
      } catch (_) { /* مشكلة اتصال: هنجرب نفتح الملف عادي */ }
    }
    if (answered && !found) throw { message: "ملف الأداة (" + tool.path + ") مش موجود على الموقع. اتأكد إنك رفعته جوه فولدر tools على GitHub بنفس الاسم، وإن GitHub Pages خلّص نشر (ممكن ياخد دقيقة)." };
    frame.src = src;
  }
  frame.classList.remove("hidden");
  $("state").classList.add("hidden");
} catch (e) {
  fail(e.message && !e.code ? e.message : arErr(e));
}
