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
    frame.src = tool.path;
  }
  frame.classList.remove("hidden");
  $("state").classList.add("hidden");
} catch (e) {
  fail(e.message && !e.code ? e.message : arErr(e));
}
