/**
 * ربط موقع المواعيد بشيت "End To End Branchs".
 *
 * الخطوات (مرة واحدة):
 * 1) افتح الشيت > Extensions > Apps Script، وامسح الكود وحط الملف ده.
 * 2) Project Settings > Script Properties > Add property:  SECRET = (أي كلمة سر طويلة عشوائية)
 * 3) Deploy > New deployment > النوع Web app:
 *      Execute as: Me   |   Who has access: Anyone
 *    وانسخ الرابط (بيخلص بـ /exec).
 * 4) في الموقع: إدارة مواعيد الفروع > ربط الشيت > الصق الرابط والمفتاح > اختبار الاتصال.
 * ملاحظة: لو عدّلت الكود بعد كده لازم Deploy > Manage deployments > Edit > New version.
 *
 * الأعمدة: B=In Docks  C=Out Docks  D=Fps Store Name  F=Arrival time  G=End time  M=Comment
 * السكربت بيكتب في الخانات دي بس (الوصول والانتهاء والتعليق والمخزن)، ومبيلمسش المعادلات.
 */
const COL = { IN: 2, OUT: 3, NAME: 4, ARR: 6, END: 7, COMMENT: 13 };

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || req.secret !== secret) return out_({ ok: false, error: 'unauthorized' });
    if (req.action === 'ping') return out_({ ok: true, pong: true });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return out_(write_(req)); } finally { lock.releaseLock(); }
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
const norm_ = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

function setTime_(cell, hhmm) {            // "06:33" -> قيمة وقت حقيقية عشان معادلات الشيت تشتغل
  const p = hhmm.split(':');
  cell.setNumberFormat('h:mm');
  cell.setValue((+p[0]) / 24 + (+p[1]) / 1440);
}
function setZero_(cell) { cell.setNumberFormat('General'); cell.setValue(0); }

function write_(req) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(req.tab);
  if (!sh) return { ok: false, error: 'tab-not-found', tab: req.tab };
  const last = Math.max(sh.getLastRow(), 2);
  const names = sh.getRange(1, COL.NAME, last, 1).getValues().map(r => norm_(r[0]));
  const rowOf = n => { const i = names.indexOf(norm_(n)); return i < 0 ? -1 : i + 1; };
  let written = 0;
  const notFound = [];

  (req.rows || []).forEach(r => {
    const row = rowOf(r.name);
    if (row < 0) { notFound.push(r.name); return; }
    if (r.holiday) {                       // الفرع إجازة: 0 في الوصول والانتهاء
      setZero_(sh.getRange(row, COL.ARR)); setZero_(sh.getRange(row, COL.END)); written += 2;
    } else {
      if (r.arrival) { setTime_(sh.getRange(row, COL.ARR), r.arrival); written++; }
      if (r.end) { setTime_(sh.getRange(row, COL.END), r.end); written++; }
    }
    if (r.comment) { sh.getRange(row, COL.COMMENT).setValue(r.comment); written++; }   // سبب التأخير بس
  });

  // مواعيد المخزن: مرة واحدة للعربية في أول صف من صفوفها
  (req.docks || []).forEach(d => {
    const rows = (d.names || []).map(rowOf).filter(x => x > 0);
    if (!rows.length) { notFound.push('عربية: ' + (d.names || []).join(' / ')); return; }
    const top = Math.min.apply(null, rows);
    if (d.in) { setTime_(sh.getRange(top, COL.IN), d.in); written++; }
    if (d.out) { setTime_(sh.getRange(top, COL.OUT), d.out); written++; }
  });
  SpreadsheetApp.flush();
  return { ok: true, written: written, notFound: notFound };
}
