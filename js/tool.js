import { db } from "./firebase.js";
import { doc, getDoc, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { guard, canSee, esc, arErr, initThemeButton, getTheme } from "./common.js";
import { unpackText } from "./prices-core.js";

const $ = id => document.getElementById(id);
const fail = m => { $("frame").classList.add("hidden"); $("state").classList.remove("hidden"); $("state").innerHTML = '<div class="msg err">' + esc(m) + '</div>'; };

initThemeButton($("btnTheme"));
const api = await guard();
const id = new URLSearchParams(location.search).get("id");
const frame = $("frame");
let tool = null;

// الأدوات (ملفات tools/*.html) بتفهم الوضع من الـ hash وبتتغيّر لحظيًا بـ postMessage.
// أدوات الـ HTML الملصوقة بنقلب ألوانها بفلتر عشان تبان داكنة.
function applyTheme() {
  const dark = getTheme() === "dark";
  if (tool && tool.type === "html") frame.classList.toggle("invert", dark);
  try { frame.contentWindow && frame.contentWindow.postMessage({ type: "theme", dark }, "*"); } catch (_) {}
}
document.addEventListener("themechange", applyTheme);
frame.addEventListener("load", applyTheme);

// جسر قائمة الأسعار: أي أداة ممكن تطلب الأسعار برسالة {type:"need-prices"}.
// بنقراها من Firestore (من الكاش الأول)، وبنفكّها، وبنبعتها للأداة، وبنبعتها تاني لو الأدمن حدّثها.
let priceUnsub = null, latestPrices = null, lastPriceKey = null;
function postPrices() { if (latestPrices) try { frame.contentWindow.postMessage(latestPrices, "*"); } catch (_) {} }
function startPrices() {
  if (priceUnsub) return postPrices();
  priceUnsub = onSnapshot(collection(db, "prices"), async snap => {
    const docs = {}; snap.docs.forEach(d => { docs[d.id] = d.data(); });
    const meta = docs.meta;
    if (!meta) { latestPrices = { type: "prices", empty: true }; return postPrices(); }
    const key = meta.version + "|" + ((docs.ov && docs.ov.v) || "");
    if (key === lastPriceKey) return;
    const chunks = [];
    for (let i = 0; i < meta.chunks; i++) { if (!docs["b" + i]) return; chunks.push(docs["b" + i].data); }   // لسه كل القطع ما وصلتش
    try {
      const base = await unpackText(chunks);
      lastPriceKey = key;
      latestPrices = { type: "prices", version: meta.version, count: meta.count, updatedAt: meta.updatedAtMs || 0, source: meta.source || "", base, ov: (docs.ov && docs.ov.text) || "" };
    } catch (e) { latestPrices = { type: "prices", error: true }; }
    postPrices();
  }, () => { latestPrices = { type: "prices", error: true }; postPrices(); });
}
window.addEventListener("message", e => {
  if (e.source === frame.contentWindow && e.data && e.data.type === "need-prices") startPrices();
});

// لو صلاحية الأداة اتشالت منك وانت فاتحها
api.onProfile(p => { if (tool && !canSee(p, id)) location.replace("dashboard.html"); });

try {
  if (!id) throw { message: "الأداة غير محددة." };
  const snap = await getDoc(doc(db, "tools", id));
  if (!snap.exists()) throw { message: "الأداة دي مش موجودة." };
  tool = snap.data();
  if (!canSee(api.profile, id)) throw { message: "مفيش عندك صلاحية لفتح الأداة دي." };

  document.title = tool.name + " | بوابة أدوات Odoo";
  $("toolName").textContent = tool.name;
  if (/^fa-[a-z]+ fa-[a-z0-9-]+$/.test(tool.icon || "")) $("toolIcon").className = tool.icon;

  if (tool.type === "html") {
    const code = await getDoc(doc(db, "toolCode", id));
    if (!code.exists()) throw { message: "كود الأداة مش موجود." };
    frame.srcdoc = code.data().html;
  } else {
    if (!/^tools\/[A-Za-z0-9._-]+\.html$/.test(tool.path || "")) throw { message: "مسار الأداة غير صالح." };
    // بنفتح الأداة فورًا من غير ما نستنى أي فحص، والفحص بيتم بالتوازي
    frame.src = tool.path + "#" + (getTheme() === "dark" ? "dark" : "light");
    checkFile(tool.path);
  }
  frame.classList.remove("hidden");
  $("state").classList.add("hidden");
  applyTheme();
} catch (e) {
  fail(e.message && !e.code ? e.message : arErr(e));
}

// لو الملف مش موجود على GitHub (اترفع بالغلط برا فولدر tools مثلًا) نقولك السبب بدل صفحة فاضية
async function checkFile(path) {
  const miss = () => fail("ملف الأداة (" + path + ") مش موجود على الموقع. اتأكد إنك رفعته جوه فولدر tools على GitHub بنفس الاسم، وإن GitHub Pages خلّص نشر (ممكن ياخد دقيقة).");
  try {
    const r = await fetch(path, { method: "HEAD" });
    if (r.ok) return;
    miss();
  } catch (_) { /* مشكلة اتصال: سيب الأداة تفتح عادي */ }
}
