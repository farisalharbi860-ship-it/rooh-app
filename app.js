/* ================= Data Layer (Firebase Firestore + local mirror) ================= */
const STORAGE_KEY = 'contracting_app_v1';
const AUTO_KEY = 'contracting_app_autobackup_v1';
const AUTO_MAX = 10; // عدد اللقطات اليومية المحفوظة
let state = { projects: [] };
let currentProjectId = null;
let currentUser = null;
let unsub = null; // إلغاء الاستماع للتزامن اللحظي

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* مرجع مجموعة مشاريع المستخدم الحالي في Firestore */
function projectsCol() {
  return db.collection('users').doc(currentUser.uid).collection('projects');
}

/* نسخة محلية احتياطية (تعمل دون إنترنت وللتصدير والنسخ التلقائية) */
function mirrorLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  autoBackup();
}

/* استبدال كل المشاريع في السحابة (يُستخدم للاستيراد والاستعادة) */
async function replaceAllProjects(projects) {
  const col = projectsCol();
  const existing = await col.get();
  const batch = db.batch();
  existing.docs.forEach(d => batch.delete(d.ref));
  (projects || []).forEach(p => {
    const id = p.id || uid();
    const data = Object.assign({}, p);
    delete data.id;
    if (!Array.isArray(data.expenses)) data.expenses = [];
    if (!Array.isArray(data.revenues)) data.revenues = [];
    batch.set(col.doc(id), data);
  });
  await batch.commit();
}

/* ---- Automatic local backups (one snapshot per day, rolling) ---- */
function loadAutoBackups() {
  try { return JSON.parse(localStorage.getItem(AUTO_KEY)) || []; }
  catch (e) { return []; }
}
function autoBackup() {
  try {
    const list = loadAutoBackups();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const snapshot = { ts: now.toISOString(), day, data: JSON.parse(JSON.stringify(state)) };
    if (list.length && list[list.length - 1].day === day) {
      list[list.length - 1] = snapshot; // حدّث لقطة اليوم
    } else {
      list.push(snapshot); // لقطة جديدة ليوم جديد
    }
    while (list.length > AUTO_MAX) list.shift();
    localStorage.setItem(AUTO_KEY, JSON.stringify(list));
  } catch (e) { console.error('auto backup failed', e); }
}

/* ================= Helpers ================= */
function parseNum(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (v == null) return 0;
  let s = String(v).replace(/[,٬]/g, '').replace(/\u066B/g, '.');
  // Arabic-Indic digits (٠-٩)
  s = s.replace(/[\u0660-\u0669]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030));
  // Extended Arabic-Indic digits (۰-۹)
  s = s.replace(/[\u06f0-\u06f9]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x06f0 + 0x0030));
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}
function fmt(n) {
  return parseNum(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function sum(arr, key) { return arr.reduce((t, x) => t + Number(x[key] || 0), 0); }
function findProject(id) { return state.projects.find(p => p.id === id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ================= Invoices ================= */
let invoiceState = { items: [] };

function invoicesCol() {
  return db.collection('users').doc(currentUser.uid).collection('invoices');
}
function receiptsCol() {
  return db.collection('users').doc(currentUser.uid).collection('receipts');
}

/* ---- Invoice form rows ---- */
function addInvoiceRow() {
  const tbody = document.getElementById('invItemsBody');
  const idx = tbody.children.length + 1;
  const tr = document.createElement('tr');
  tr.dataset.id = uid();
  tr.innerHTML = `
    <td>${idx}</td>
    <td><input type="text" class="inv-item" placeholder="بيان الأعمال" style="width:100%;border:none;background:transparent" /></td>
    <td><input type="text" class="inv-unit" placeholder="م2" style="width:60px;border:none;background:transparent;text-align:center" /></td>
    <td><input type="number" class="inv-qty-contract" style="width:80px;border:none;background:transparent;text-align:center" step="0.01" /></td>
    <td><input type="number" class="inv-qty-prev" style="width:80px;border:none;background:transparent;text-align:center" step="0.01" /></td>
    <td><input type="number" class="inv-qty-curr" style="width:80px;border:none;background:transparent;text-align:center" step="0.01" /></td>
    <td class="inv-qty-total" style="text-align:center">0</td>
    <td><input type="number" class="inv-rate" style="width:90px;border:none;background:transparent;text-align:center" step="0.01" /></td>
    <td class="inv-amt-prev" style="text-align:center">0.00</td>
    <td class="inv-amt-curr" style="text-align:center">0.00</td>
    <td class="inv-amt-total" style="text-align:center;font-weight:700">0.00</td>
    <td class="no-print"><button class="btn btn-danger-ghost btn-sm" onclick="this.closest('tr').remove();recalcInvoice()">×</button></td>
  `;
  tbody.appendChild(tr);
  attachRowListeners(tr);
}

function attachRowListeners(tr) {
  const inputs = tr.querySelectorAll('input');
  inputs.forEach(inp => inp.addEventListener('input', () => recalcRow(tr)));
}

function recalcRow(tr) {
  const qtyContract = Number(tr.querySelector('.inv-qty-contract').value) || 0;
  const qtyPrev = Number(tr.querySelector('.inv-qty-prev').value) || 0;
  const qtyCurr = Number(tr.querySelector('.inv-qty-curr').value) || 0;
  const rate = Number(tr.querySelector('.inv-rate').value) || 0;

  const qtyTotal = qtyPrev + qtyCurr;
  const amtPrev = qtyPrev * rate;
  const amtCurr = qtyCurr * rate;
  const amtTotal = amtPrev + amtCurr;

  tr.querySelector('.inv-qty-total').textContent = fmt(qtyTotal);
  tr.querySelector('.inv-amt-prev').textContent = fmt(amtPrev);
  tr.querySelector('.inv-amt-curr').textContent = fmt(amtCurr);
  tr.querySelector('.inv-amt-total').textContent = fmt(amtTotal);

  recalcInvoice();
}

function recalcInvoice() {
  let taxable = 0;
  let prevTotal = 0;
  document.querySelectorAll('#invItemsBody tr').forEach(tr => {
    const prev = parseNum(tr.querySelector('.inv-amt-prev').textContent);
    const curr = parseNum(tr.querySelector('.inv-amt-curr').textContent);
    taxable += curr;
    prevTotal += prev;
  });
  const vat = taxable * 0.15;
  const total = taxable + vat;
  document.getElementById('invSubtotal').textContent = fmt(taxable);
  document.getElementById('invVat').textContent = fmt(vat);
  document.getElementById('invTotal').textContent = fmt(total);
}

/* ---- Create & Save Invoice ---- */
async function createInvoice(e) {
  e.preventDefault();
  let taxable = 0;
  const rows = [];
  document.querySelectorAll('#invItemsBody tr').forEach((tr, i) => {
    const qtyContract = parseNum(tr.querySelector('.inv-qty-contract').value);
    const qtyPrev = parseNum(tr.querySelector('.inv-qty-prev').value);
    const qtyCurr = parseNum(tr.querySelector('.inv-qty-curr').value);
    const rate = parseNum(tr.querySelector('.inv-rate').value);
    const qtyTotal = qtyPrev + qtyCurr;
    const amtPrev = qtyPrev * rate;
    const amtCurr = qtyCurr * rate;
    const amtTotal = amtPrev + amtCurr;
    taxable += amtCurr;
    rows.push({
      no: i + 1,
      desc: tr.querySelector('.inv-item').value.trim(),
      unit: tr.querySelector('.inv-unit').value.trim(),
      qtyContract, qtyPrev, qtyCurr, qtyTotal,
      rate, amtPrev, amtCurr, amtTotal,
    });
  });
  if (!rows.length || !rows[0].desc) { alert('أضف بنداً واحداً على الأقل.'); return false; }

  const vat = taxable * 0.15;
  const total = taxable + vat;

  // Gather data for preview
  const invNumber = document.getElementById('invNumber').value.trim() || ('INV-' + Date.now().toString().slice(-6));
  const projectSel = document.getElementById('invProject');
  const projectOpt = projectSel.options[projectSel.selectedIndex];
  const projectId = projectSel.value;
  const projectName = projectOpt.dataset.name || projectOpt.textContent;
  const subtotal = taxable;
  const invData = {
    number: invNumber,
    date: document.getElementById('invDate').value,
    customer: document.getElementById('invCustomer').value.trim(),
    project: projectName,
    vatNo: document.getElementById('invVatNo').value.trim(),
    payType: document.getElementById('invPayType').value,
    notes: document.getElementById('invNotes').value.trim(),
    items: rows,
    subtotal, vat, total,
    projectId
  };

  // Build receipt preview data
  const recData = {
    number: 'REC-' + invNumber.replace(/[^0-9]/g, ''),
    date: invData.date,
    customer: invData.customer,
    amount: total,
    amountWords: numberToArabicWords(Math.floor(total)),
    description: 'فاتورة ضريبية رقم ' + invNumber + ' — ' + invData.project,
    invoiceNumber: invNumber
  };

  // Show preview modal
  showPreviewModal(invData, recData);
  return false;
}

/* ---- Render Invoices List (real-time) ---- */
let invoicesUnsub = null;
function listenInvoices() {
  if (invoicesUnsub) { invoicesUnsub(); invoicesUnsub = null; }
  const wrap = document.getElementById('invoicesList');
  if (!wrap) return;
  invoicesUnsub = invoicesCol().orderBy('createdAt', 'desc').onSnapshot(snap => {
    if (snap.empty) {
      wrap.innerHTML = '<div class="empty"><div class="big">🧾</div>لا توجد فواتير بعد.</div>';
      return;
    }
    wrap.innerHTML = snap.docs.map(d => {
      const inv = d.data();
      const items = inv.items || [];
      let subtotal = 0;
      items.forEach(it => {
        const rate = parseNum(it.rate);
        const qtyCurr = parseNum(it.qtyCurr);
        subtotal += qtyCurr * rate;
      });
      const vat = subtotal * 0.15;
      const total = subtotal + vat;
      return `<div class="project-card" style="position:relative">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <h3 style="margin:0 0 4px">فاتورة ${esc(inv.number)}</h3>
            <div class="company">🏢 ${esc(inv.customer)}</div>
            <div class="meta">📅 ${fmtDate(inv.date)} • ${esc(inv.project)}</div>
          </div>
          <div style="text-align:left">
            <div style="font-size:20px;font-weight:700;color:var(--danger)">${fmt(total)} ر.س</div>
            <div style="font-size:12px;color:var(--muted)">شامل الضريبة</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px" class="no-print">
          <button class="btn btn-primary btn-sm" onclick="downloadInvoicePDF('${d.id}')">📄 تنزيل الفاتورة PDF</button>
          <button class="btn btn-success btn-sm" onclick="downloadReceiptPDF('${d.id}')">🧾 تنزيل سند القبض PDF</button>
          <button class="btn btn-danger-ghost btn-sm" onclick="deleteInvoice('${d.id}')">حذف</button>
        </div>
      </div>`;
    }).join('');
  }, err => {
    wrap.innerHTML = '<div class="empty">تعذّر تحميل الفواتير: ' + esc(err.message) + '</div>';
  });
}

function renderInvoicesList() {
  listenInvoices();
}

function deleteInvoice(id) {
  if (!confirm('هل تريد حذف هذه الفاتورة وسند القبض المرتبط بها؟')) return;
  invoicesCol().doc(id).delete().then(() => {
    return new Promise((resolve, reject) => {
      const unsub = receiptsCol().where('invoiceId', '==', id).onSnapshot(snap => {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        batch.commit().then(resolve).catch(reject);
        unsub();
      }, err => { unsub(); reject(err); });
      setTimeout(() => { unsub(); reject(new Error('timeout')); }, 10000);
    });
  }).catch(err => alert('تعذّر الحذف: ' + err.message));
}

/* ---- ZATCA TLV QR Code Generator ---- */
function toZATCAQR(data) {
  function hex(byte) { return byte.toString(16).padStart(2, '0').toUpperCase(); }
  const d = new Date(data.date || Date.now());
  const iso = d.toISOString().replace(/\..*Z$/, 'Z');
  const fields = [
    [1, 'مؤسسة روح المنافسه المحلية للمقاولات'],
    [2, '300144171600003'],
    [3, iso],
    [4, String(Number(data.total || 0).toFixed(2))],
    [5, String(Number(data.vat || 0).toFixed(2))]
  ];
  let hexStr = '';
  for (const [tag, val] of fields) {
    const bytes = new TextEncoder().encode(val);
    hexStr += hex(tag) + hex(bytes.length);
    for (const b of bytes) hexStr += hex(b);
  }
  // hex to base64
  let bin = '';
  for (let i = 0; i < hexStr.length; i += 2) {
    bin += String.fromCharCode(parseInt(hexStr.substr(i, 2), 16));
  }
  try { return btoa(bin); } catch(e) { return ''; }
}
function loadImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c.toDataURL());
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---- PDF Generation (jsPDF + html2canvas) ---- */
async function downloadInvoicePDF(invId) {
  // Use onSnapshot to get invoice data reliably
  const inv = await new Promise((resolve, reject) => {
    const unsub = invoicesCol().doc(invId).onSnapshot(doc => {
      if (doc.exists) { resolve(doc.data()); unsub(); }
      else { reject(new Error('not_found')); }
    }, err => reject(err));
    setTimeout(() => { unsub(); reject(new Error('timeout')); }, 10000);
  });

  // Recalculate all values from raw data for reliability
  const rawItems = (inv.items || []);
  const items = rawItems.map((it, i) => {
    const rate = parseNum(it.rate);
    const qtyContract = parseNum(it.qtyContract);
    const qtyPrev = parseNum(it.qtyPrev);
    const qtyCurr = parseNum(it.qtyCurr);
    const qtyTotal = qtyPrev + qtyCurr;
    const amtPrev = qtyPrev * rate;
    const amtCurr = qtyCurr * rate;
    const amtTotal = amtPrev + amtCurr;
    return { ...it, no: i + 1, qtyContract, qtyPrev, qtyCurr, qtyTotal, rate, amtPrev, amtCurr, amtTotal };
  });
  // Tax base is current amount only (progress claim)
  const subtotal = items.reduce((s, it) => s + it.amtCurr, 0);
  const vat = subtotal * 0.15;
  const total = subtotal + vat;

  // debug
  console.log('PDF totals:', { subtotal, vat, total });
  console.log('PDF items count:', items.length);
  console.log('PDF item 0:', items[0]);

  // Fill template
  document.getElementById('ptCustomer').textContent = inv.customer;
  document.getElementById('ptProject').textContent = inv.project;
  document.getElementById('ptVatNo').textContent = inv.vatNo || '-';
  document.getElementById('ptInvNo').textContent = inv.number;
  document.getElementById('ptDate').textContent = fmtDate(inv.date);
  document.getElementById('ptPayType').textContent = inv.payType;
  document.getElementById('ptNotes').textContent = inv.notes || '';
  document.getElementById('ptTotalWords').textContent = numberToArabicWords(total || 0);

  const tbody = document.getElementById('ptItems');
  tbody.innerHTML = items.map(it => `
    <tr>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${it.no}</td>
      <td style="border:1px solid #000;padding:5px;font-size:12px">${esc(it.desc)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${esc(it.unit)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyContract)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyPrev)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyCurr)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyTotal)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.rate)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtPrev)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtCurr)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtTotal)}</td>
    </tr>
  `).join('');
  document.getElementById('ptSubtotal').textContent = fmt(subtotal);
  document.getElementById('ptVat').textContent = fmt(vat);
  document.getElementById('ptTotal').textContent = fmt(total);

  /* QR Code - ZATCA TLV format */
  try {
    const qrEl = document.getElementById('ptBarcode');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      const qrData = toZATCAQR({
        date: inv.date,
        total: total,
        vat: vat
      });
      new QRCode(qrEl, {
        text: qrData,
        width: 120,
        height: 120,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  } catch(e) { console.warn('QR error', e); }

  const el = document.getElementById('invoicePrintTemplate');
  /* preload logo as base64 for html2canvas CORS */
  const logoImg = el.querySelector('img[src*="logo"]');
  if (logoImg) {
    try { logoImg.src = await loadImageAsBase64(logoImg.src); } catch(e) {}
  }
  el.style.display = 'block';
  try {
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    pdf.save(`فاتورة_${inv.number}.pdf`);
  } catch (err) {
    console.error(err);
    alert('تعذّر توليد PDF. جرّب الطباعة بدلاً من ذلك.');
  }
  el.style.display = 'none';
}

async function downloadReceiptPDF(invId) {
  const rec = await new Promise((resolve, reject) => {
    const unsub = receiptsCol().where('invoiceId', '==', invId).limit(1).onSnapshot(snap => {
      if (!snap.empty) { resolve(snap.docs[0].data()); unsub(); }
    }, err => reject(err));
    setTimeout(() => { unsub(); reject(new Error('timeout')); }, 10000);
  });

  document.getElementById('ptRecNo').textContent = rec.number;
  document.getElementById('ptRecDate').textContent = fmtDate(rec.date);
  document.getElementById('ptRecInvNo').textContent = rec.invoiceNumber;
  document.getElementById('ptRecAmount').textContent = fmt(rec.amount);
  document.getElementById('ptRecFrom').textContent = rec.customer;
  document.getElementById('ptRecAmountWords').textContent = rec.amountWords;
  document.getElementById('ptRecDesc').textContent = rec.description;

  /* QR Code - ZATCA TLV format for receipt */
  try {
    const qrEl = document.getElementById('ptRecBarcode');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      const recVat = rec.amount - (rec.amount / 1.15);
      const qrData = toZATCAQR({
        date: rec.date,
        total: rec.amount,
        vat: recVat
      });
      new QRCode(qrEl, {
        text: qrData,
        width: 120,
        height: 120,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  } catch(e) { console.warn('QR error', e); }

  const el = document.getElementById('receiptPrintTemplate');
  const logoImg = el.querySelector('img[src*="logo"]');
  if (logoImg) {
    try { logoImg.src = await loadImageAsBase64(logoImg.src); } catch(e) {}
  }
  el.style.display = 'block';
  try {
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    pdf.addImage(imgData, 'JPEG', 0, 0, imgWidth, Math.min(imgHeight, pageHeight));
    pdf.save(`سند_قبض_${rec.number}.pdf`);
  } catch (err) {
    console.error(err);
    alert('تعذّر توليد PDF.');
  }
  el.style.display = 'none';
}

/* ---- Arabic number to words (simplified) ---- */
function numberToArabicWords(n) {
  if (n === 0) return 'صفر';
  // Handle decimals (halalas)
  const hasDecimal = n % 1 !== 0;
  const riyals = Math.floor(n);
  const halalas = Math.round((n - riyals) * 100);
  let riyalWords = _intToArabicWords(riyals);
  let result = riyalWords + ' ﷼ سعودي';
  if (halalas > 0) {
    result += ' و ' + _intToArabicWords(halalas) + ' هللة';
  }
  return result;
}
function _intToArabicWords(n) {
  if (n === 0) return 'صفر';
  const ones = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة','عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
  const tens = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];
  const hundreds = ['','مائة','مائتان','ثلاثمائة','أربعمائة','خمسمائة','ستمائة','سبعمائة','ثمانمائة','تسعمائة'];
  const thousands = ['','ألف','ألفان','ثلاثة آلاف','أربعة آلاف','خمسة آلاف','ستة آلاف','سبعة آلاف','ثمانية آلاف','تسعة آلاف'];
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' و ' + ones[n % 10] : '');
  if (n < 1000) return hundreds[Math.floor(n / 100)] + (n % 100 ? ' و ' + _intToArabicWords(n % 100) : '');
  if (n < 10000) return thousands[Math.floor(n / 1000)] + (n % 1000 ? ' و ' + _intToArabicWords(n % 1000) : '');
  if (n < 1000000) {
    const k = Math.floor(n / 1000);
    const rest = n % 1000;
    let word = k === 1 ? 'ألف' : k === 2 ? 'ألفان' : _intToArabicWords(k) + ' آلاف';
    return word + (rest ? ' و ' + _intToArabicWords(rest) : '');
  }
  if (n < 1000000000) {
    const m = Math.floor(n / 1000000);
    const rest = n % 1000000;
    let word = m === 1 ? 'مليون' : m === 2 ? 'مليونان' : _intToArabicWords(m) + ' ملايين';
    return word + (rest ? ' و ' + _intToArabicWords(rest) : '');
  }
  return String(n);
}

/* ================= Tabs (updated) ================= */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-projects').style.display = name === 'projects' ? 'block' : 'none';
  document.getElementById('tab-reports').style.display = name === 'reports' ? 'block' : 'none';
  document.getElementById('tab-invoices').style.display = name === 'invoices' ? 'block' : 'none';
  document.getElementById('tab-completed').style.display = name === 'completed' ? 'block' : 'none';
  document.getElementById('tab-dashboard').style.display = name === 'dashboard' ? 'block' : 'none';
  if (name === 'reports') refreshReportSelect();
  if (name === 'invoices') { refreshInvoiceProjectSelect(); renderInvoicesList(); addInvoiceRow(); }
  if (name === 'completed') renderCompletedWorks();
  if (name === 'dashboard') renderDashboard();
}

function refreshInvoiceProjectSelect() {
  const sel = document.getElementById('invProject');
  if (!sel) return;
  const opts = state.projects.map(p => `<option value="${esc(p.id)}" data-name="${esc(p.name)}" data-company="${esc(p.company || '')}">${esc(p.name)} — ${esc(p.company || '')}</option>`).join('');
  sel.innerHTML = '<option value="">اختر مشروعاً...</option>' + opts;
  // auto-fill customer when project changes
  sel.onchange = () => {
    const opt = sel.options[sel.selectedIndex];
    document.getElementById('invCustomer').value = opt.dataset.company || '';
  };
}

/* ================= Projects ================= */
function addProject(e) {
  e.preventDefault();
  const id = uid();
  const project = {
    name: document.getElementById('pName').value.trim(),
    company: document.getElementById('pCompany').value.trim(),
    contractDate: document.getElementById('pDate').value,
    status: document.getElementById('pStatus').value,
    expenses: [], revenues: []
  };
  projectsCol().doc(id).set(project).catch(err => alert('تعذّر الحفظ: ' + err.message));
  document.getElementById('projectForm').reset();
  return false;
}

function deleteProject(id, ev) {
  ev.stopPropagation();
  if (!confirm('هل تريد حذف هذا المشروع وكل بياناته؟')) return;
  projectsCol().doc(id).delete().catch(err => alert('تعذّر الحذف: ' + err.message));
}

function renderProjects() {
  const wrap = document.getElementById('projectsList');
  if (!state.projects.length) {
    wrap.innerHTML = '<div class="empty"><div class="big">📋</div>لا توجد مشاريع بعد. أضف مشروعك الأول من الأعلى.</div>';
    return;
  }
  wrap.innerHTML = state.projects.map(p => {
    const exp = sum(p.expenses, 'amount');
    const rev = sum(p.revenues, 'amount');
    return `<div class="project-card" onclick="openProject('${p.id}')">
      <button class="btn btn-danger-ghost no-print" style="position:absolute;left:12px;top:12px" onclick="deleteProject('${p.id}',event)">حذف</button>
      <h3>${esc(p.name)}</h3>
      <div class="company">🏢 ${esc(p.company)}</div>
      <div class="meta">📅 ${fmtDate(p.contractDate)} • <span class="badge ${p.status==='حالي'?'rev':'exp'}">${esc(p.status||'')}</span></div>
      <div class="mini-stats">
        <div class="mini-stat exp">مصروفات<b>${fmt(exp)}</b></div>
        <div class="mini-stat rev">إيرادات<b>${fmt(rev)}</b></div>
      </div>
    </div>`;
  }).join('');
}

/* ================= Project Detail Modal ================= */
function openProject(id) {
  currentProjectId = id;
  renderModal();
  document.getElementById('projectModal').classList.add('open');
}
function closeModal() {
  document.getElementById('projectModal').classList.remove('open');
  currentProjectId = null;
}
document.getElementById('projectModal').addEventListener('click', e => {
  if (e.target.id === 'projectModal') closeModal();
});

function renderModal() {
  const p = findProject(currentProjectId);
  if (!p) return;
  const exp = sum(p.expenses, 'amount');
  const rev = sum(p.revenues, 'amount');
  const net = rev - exp;
  document.getElementById('mTitle').textContent = p.name;
  document.getElementById('mSub').innerHTML = `🏢 ${esc(p.company)} • 📅 ${fmtDate(p.contractDate)} • ${esc(p.status||'')}`;
  document.getElementById('mSummary').innerHTML = `
    <div class="summary-box"><div class="lbl">إجمالي المصروفات</div><div class="val neg">${fmt(exp)}</div></div>
    <div class="summary-box"><div class="lbl">إجمالي الإيرادات</div><div class="val pos">${fmt(rev)}</div></div>
    <div class="summary-box"><div class="lbl">الصافي</div><div class="val ${net>=0?'pos':'neg'}">${fmt(net)}</div></div>`;

  // Expenses table
  const et = document.getElementById('expTable');
  if (!p.expenses.length) {
    et.innerHTML = '<tr><td style="text-align:center;color:var(--muted)">لا توجد مصروفات</td></tr>';
  } else {
    et.innerHTML = `<thead><tr><th>التاريخ</th><th>الفئة</th><th>السبب</th><th>العمل المنجز</th><th>المبلغ</th><th class="no-print"></th></tr></thead><tbody>` +
      p.expenses.slice().sort((a,b)=> (a.date<b.date?1:-1)).map(x => `<tr>
        <td>${fmtDate(x.date)}</td><td>${esc(x.category)||'-'}</td><td>${esc(x.reason)}</td><td>${esc(x.work)||'-'}</td>
        <td class="num neg">${fmt(x.amount)}</td>
        <td class="no-print"><button class="btn btn-danger-ghost btn-sm" onclick="deleteExpense('${x.id}')">حذف</button></td>
      </tr>`).join('') +
      `</tbody><tfoot><tr><th colspan="4">الإجمالي</th><th class="num neg">${fmt(exp)}</th><th class="no-print"></th></tr></tfoot>`;
  }

  // Revenues table
  const vt = document.getElementById('revTable');
  if (!p.revenues.length) {
    vt.innerHTML = '<tr><td style="text-align:center;color:var(--muted)">لا توجد إيرادات</td></tr>';
  } else {
    vt.innerHTML = `<thead><tr><th>رقم الدفعة</th><th>التاريخ</th><th>المبلغ</th><th class="no-print"></th></tr></thead><tbody>` +
      p.revenues.slice().sort((a,b)=> (a.date<b.date?1:-1)).map(x => `<tr>
        <td>${esc(x.number)}</td><td>${fmtDate(x.date)}</td>
        <td class="num pos">${fmt(x.amount)}</td>
        <td class="no-print"><button class="btn btn-danger-ghost btn-sm" onclick="deleteRevenue('${x.id}')">حذف</button></td>
      </tr>`).join('') +
      `</tbody><tfoot><tr><th colspan="2">الإجمالي</th><th class="num pos">${fmt(rev)}</th><th class="no-print"></th></tr></tfoot>`;
  }
}

function addExpense(e) {
  e.preventDefault();
  const p = findProject(currentProjectId);
  if (!p) return false;
  const expenses = (p.expenses || []).concat([{
    id: uid(),
    amount: parseFloat(document.getElementById('eAmount').value),
    category: document.getElementById('eCategory').value,
    reason: document.getElementById('eReason').value.trim(),
    date: document.getElementById('eDate').value,
    work: document.getElementById('eWork').value.trim()
  }]);
  projectsCol().doc(p.id).update({ expenses }).catch(err => alert('تعذّر الحفظ: ' + err.message));
  document.getElementById('expForm').reset();
  return false;
}
function deleteExpense(eid) {
  const p = findProject(currentProjectId);
  if (!p) return;
  const expenses = (p.expenses || []).filter(x => x.id !== eid);
  projectsCol().doc(p.id).update({ expenses }).catch(err => alert('تعذّر الحذف: ' + err.message));
}

function addRevenue(e) {
  e.preventDefault();
  const p = findProject(currentProjectId);
  if (!p) return false;
  const revenues = (p.revenues || []).concat([{
    id: uid(),
    number: document.getElementById('vNumber').value.trim(),
    date: document.getElementById('vDate').value,
    amount: parseFloat(document.getElementById('vAmount').value)
  }]);
  projectsCol().doc(p.id).update({ revenues }).catch(err => alert('تعذّر الحفظ: ' + err.message));
  document.getElementById('revForm').reset();
  return false;
}
function deleteRevenue(vid) {
  const p = findProject(currentProjectId);
  if (!p) return;
  const revenues = (p.revenues || []).filter(x => x.id !== vid);
  projectsCol().doc(p.id).update({ revenues }).catch(err => alert('تعذّر الحذف: ' + err.message));
}

/* ================= Reports ================= */
function refreshReportSelect() {
  const sel = document.getElementById('rProject');
  const prev = sel.value;
  sel.innerHTML = state.projects.length
    ? state.projects.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.company)}</option>`).join('')
    : '<option value="">لا توجد مشاريع</option>';
  if (prev) sel.value = prev;
}

function inRange(date, from, to) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function generateReport() {
  const id = document.getElementById('rProject').value;
  const p = findProject(id);
  const out = document.getElementById('reportOutput');
  if (!p) { out.innerHTML = '<div class="card"><div class="empty">اختر مشروعاً أولاً.</div></div>'; return; }
  const from = document.getElementById('rFrom').value;
  const to = document.getElementById('rTo').value;

  const exps = p.expenses.filter(x => inRange(x.date, from, to)).sort((a,b)=> a.date<b.date?-1:1);
  const revs = p.revenues.filter(x => inRange(x.date, from, to)).sort((a,b)=> a.date<b.date?-1:1);
  const totalExp = sum(exps, 'amount');
  const totalRev = sum(revs, 'amount');
  const net = totalRev - totalExp;

  const rangeLabel = (from || to)
    ? `الفترة: ${from ? fmtDate(from) : '—'} إلى ${to ? fmtDate(to) : '—'}`
    : 'كل الفترات';

  lastReport = { project: p, from, to, exps, revs, totalExp, totalRev, net, rangeLabel };

  out.innerHTML = `<div class="card" id="reportCard">
    <div class="modal-head">
      <div>
        <h2>تقرير: ${esc(p.name)}</h2>
        <div class="sub">🏢 ${esc(p.company)} • ${rangeLabel}</div>
      </div>
      <div class="report-actions no-print">
        <button class="btn btn-success btn-sm" onclick="exportReportExcel()">📊 Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportReportCsvBtn()">📑 CSV</button>
        <button class="btn btn-danger-ghost btn-sm" style="background:var(--danger-soft)" onclick="exportReportPDF()">📄 PDF</button>
        <button class="btn btn-ghost btn-sm" onclick="window.print()">🖨️ طباعة</button>
      </div>
    </div>

    <div class="summary-row">
      <div class="summary-box"><div class="lbl">إجمالي المصروفات</div><div class="val neg">${fmt(totalExp)}</div></div>
      <div class="summary-box"><div class="lbl">إجمالي الإيرادات</div><div class="val pos">${fmt(totalRev)}</div></div>
      <div class="summary-box"><div class="lbl">الصافي (إيراد - مصروف)</div><div class="val ${net>=0?'pos':'neg'}">${fmt(net)}</div></div>
    </div>

    <div class="chart-wrap">
      <div class="section-title">الرسم البياني للمصروفات والإيرادات</div>
      <div class="chart-box"><canvas id="reportChartCanvas"></canvas></div>
    </div>

    <div class="section-title" style="color:var(--danger)">المصروفات (${exps.length})</div>
    ${renderCategoryBreakdown(exps)}
    <div class="table-wrap"><table>
      <thead><tr><th>التاريخ</th><th>الفئة</th><th>السبب</th><th>العمل المنجز</th><th>المبلغ</th></tr></thead>
      <tbody>${exps.length ? exps.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${esc(x.category)||'-'}</td><td>${esc(x.reason)}</td><td>${esc(x.work)||'-'}</td><td class="num neg">${fmt(x.amount)}</td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">لا توجد مصروفات في هذه الفترة</td></tr>'}</tbody>
      ${exps.length?`<tfoot><tr><th colspan="4">الإجمالي</th><th class="num neg">${fmt(totalExp)}</th></tr></tfoot>`:''}
    </table></div>

    <div class="chart-wrap">
      <div class="section-title">توزيع المصروفات حسب الفئة</div>
      <div class="chart-box"><canvas id="categoryChartCanvas"></canvas></div>
    </div>

    <div class="section-title" style="color:var(--success)">الإيرادات (${revs.length})</div>
    <div class="table-wrap"><table>
      <thead><tr><th>رقم الدفعة</th><th>التاريخ</th><th>المبلغ</th></tr></thead>
      <tbody>${revs.length ? revs.map(x=>`<tr><td>${esc(x.number)}</td><td>${fmtDate(x.date)}</td><td class="num pos">${fmt(x.amount)}</td></tr>`).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--muted)">لا توجد إيرادات في هذه الفترة</td></tr>'}</tbody>
      ${revs.length?`<tfoot><tr><th colspan="2">الإجمالي</th><th class="num pos">${fmt(totalRev)}</th></tr></tfoot>`:''}
    </table></div>
  </div>`;

  renderReportChart(exps, revs, totalExp, totalRev);
  renderCategoryPie(exps);
}

/* ---- Category Breakdown & Pie Chart ---- */
function groupByCategory(exps) {
  const map = {};
  exps.forEach(x => {
    const cat = x.category || 'أخرى';
    map[cat] = (map[cat] || 0) + Number(x.amount || 0);
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
function catBadge(cat) {
  const map = { 'مواد': '#9333ea', 'أجور': '#ca8a04', 'معدات': '#2563eb', 'أخرى': '#6b7280' };
  const color = map[cat] || '#6b7280';
  return `<span style="display:inline-block;background:${color}1a;color:${color};border:1px solid ${color}33;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600">${esc(cat)}</span>`;
}
function renderCategoryBreakdown(exps) {
  if (!exps.length) return '';
  const total = sum(exps, 'amount');
  const rows = groupByCategory(exps);
  return `<div class="table-wrap" style="margin-bottom:16px"><table style="font-size:13px">
    <thead><tr><th>الفئة</th><th>المجموع</th><th>النسبة</th></tr></thead>
    <tbody>${rows.map(([cat, val]) => {
      const pct = total ? ((val / total) * 100).toFixed(1) + '%' : '0%';
      return `<tr><td>${catBadge(cat)}</td><td class="num">${fmt(val)}</td><td>${pct}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><th>الكل</th><th class="num">${fmt(total)}</th><th>100%</th></tr></tfoot>
  </table></div>`;
}
let catChart = null;
function renderCategoryPie(exps) {
  const canvas = document.getElementById('categoryChartCanvas');
  if (!canvas) return;
  if (catChart) { catChart.destroy(); catChart = null; }
  if (typeof Chart === 'undefined' || !exps.length) {
    canvas.closest('.chart-wrap').style.display = 'none';
    return;
  }
  canvas.closest('.chart-wrap').style.display = 'block';
  const rows = groupByCategory(exps);
  const colors = { 'مواد': '#9333ea', 'أجور': '#ca8a04', 'معدات': '#2563eb', 'أخرى': '#6b7280' };
  const bg = rows.map(([cat]) => colors[cat] || '#6b7280');
  catChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels: rows.map(r => r[0]), datasets: [{ data: rows.map(r => r[1]), backgroundColor: bg, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { family: 'Cairo', size: 13 } } },
        tooltip: { titleFont: { family: 'Cairo' }, bodyFont: { family: 'Cairo' }, callbacks: { label: c => `${c.label}: ${fmt(c.parsed)}` } }
      }
    }
  });
}

/* ---- Report chart (Chart.js) ---- */
let reportChart = null;
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  const names = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${names[parseInt(m,10)-1]} ${y}`;
}
function groupByMonth(arr) {
  const map = {};
  arr.forEach(x => {
    const key = (x.date || '').slice(0, 7);
    if (!key) return;
    map[key] = (map[key] || 0) + Number(x.amount || 0);
  });
  return map;
}
function renderReportChart(exps, revs, totalExp, totalRev) {
  const canvas = document.getElementById('reportChartCanvas');
  if (!canvas) return;
  if (reportChart) { reportChart.destroy(); reportChart = null; }
  if (typeof Chart === 'undefined') {
    canvas.closest('.chart-wrap').innerHTML = '<div class="empty" style="padding:20px">تعذّر تحميل مكتبة الرسم البياني (تحقق من الاتصال بالإنترنت).</div>';
    return;
  }

  const expM = groupByMonth(exps);
  const revM = groupByMonth(revs);
  const months = Array.from(new Set([...Object.keys(expM), ...Object.keys(revM)])).sort();

  let labels, expData, revData;
  if (months.length > 1) {
    labels = months.map(monthLabel);
    expData = months.map(m => expM[m] || 0);
    revData = months.map(m => revM[m] || 0);
  } else {
    labels = ['الإجمالي'];
    expData = [totalExp];
    revData = [totalRev];
  }

  reportChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'المصروفات', data: expData, backgroundColor: 'rgba(220,38,38,.8)', borderRadius: 6 },
        { label: 'الإيرادات', data: revData, backgroundColor: 'rgba(22,163,74,.8)', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { labels: { font: { family: 'Cairo', size: 13 } } },
        tooltip: {
          titleFont: { family: 'Cairo' }, bodyFont: { family: 'Cairo' },
          callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}` }
        }
      },
      scales: {
        x: { ticks: { font: { family: 'Cairo' } } },
        y: { beginAtZero: true, ticks: { font: { family: 'Cairo' }, callback: v => fmt(v) } }
      }
    }
  });
}

/* ================= Export & Backup ================= */
let lastReport = null;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function safeName(s) { return String(s || 'report').replace(/[\\/:*?"<>|]/g, '_').trim(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

/* ---- Report -> Excel (.xlsx via SheetJS, CSV fallback) ---- */
function exportReportExcel() {
  if (!lastReport) { alert('لا يوجد تقرير لتصديره. اعرض التقرير أولاً.'); return; }
  const r = lastReport;
  const fileBase = `تقرير_${safeName(r.project.name)}_${todayStr()}`;

  if (typeof XLSX === 'undefined') { exportReportCSV(r, fileBase); return; }

  const wb = XLSX.utils.book_new();

  const summary = [
    ['تقرير مشروع'],
    ['المشروع', r.project.name],
    ['الشركة', r.project.company],
    ['تاريخ العقد', fmtDate(r.project.contractDate)],
    ['الفترة', r.rangeLabel],
    [],
    ['إجمالي المصروفات', r.totalExp],
    ['إجمالي الإيرادات', r.totalRev],
    ['الصافي', r.net],
  ];
  const wsS = XLSX.utils.aoa_to_sheet(summary);
  wsS['!cols'] = [{ wch: 18 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsS, 'الملخص');

  const expRows = [['التاريخ', 'الفئة', 'السبب', 'العمل المنجز', 'المبلغ']];
  r.exps.forEach(x => expRows.push([fmtDate(x.date), x.category || '', x.reason, x.work || '', Number(x.amount)]));
  expRows.push(['', '', '', 'الإجمالي', r.totalExp]);
  const wsE = XLSX.utils.aoa_to_sheet(expRows);
  wsE['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 24 }, { wch: 24 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsE, 'المصروفات');

  const revRows = [['رقم الدفعة', 'التاريخ', 'المبلغ']];
  r.revs.forEach(x => revRows.push([x.number, fmtDate(x.date), Number(x.amount)]));
  revRows.push(['', 'الإجمالي', r.totalRev]);
  const wsR = XLSX.utils.aoa_to_sheet(revRows);
  wsR['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'الإيرادات');

  XLSX.writeFile(wb, fileBase + '.xlsx');
}

function exportReportCsvBtn() {
  if (!lastReport) { alert('لا يوجد تقرير لتصديره. اعرض التقرير أولاً.'); return; }
  const fileBase = `تقرير_${safeName(lastReport.project.name)}_${todayStr()}`;
  exportReportCSV(lastReport, fileBase);
}

function exportReportCSV(r, fileBase) {
  const lines = [];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  lines.push(['المشروع', r.project.name].map(q).join(','));
  lines.push(['الشركة', r.project.company].map(q).join(','));
  lines.push(['الفترة', r.rangeLabel].map(q).join(','));
  lines.push('');
  lines.push(['المصروفات'].map(q).join(','));
  lines.push(['التاريخ', 'الفئة', 'السبب', 'العمل المنجز', 'المبلغ'].map(q).join(','));
  r.exps.forEach(x => lines.push([fmtDate(x.date), x.category || '', x.reason, x.work || '', x.amount].map(q).join(',')));
  lines.push(['', '', '', 'الإجمالي', r.totalExp].map(q).join(','));
  lines.push('');
  lines.push(['الإيرادات'].map(q).join(','));
  lines.push(['رقم الدفعة', 'التاريخ', 'المبلغ'].map(q).join(','));
  r.revs.forEach(x => lines.push([x.number, fmtDate(x.date), x.amount].map(q).join(',')));
  lines.push(['', 'الإجمالي', r.totalRev].map(q).join(','));
  lines.push('');
  lines.push(['الصافي', r.net].map(q).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, fileBase + '.csv');
}

/* ---- Report -> PDF (html2pdf renders Arabic correctly via canvas) ---- */
function exportReportPDF() {
  if (!lastReport) { alert('لا يوجد تقرير لتصديره. اعرض التقرير أولاً.'); return; }
  const el = document.getElementById('reportCard');
  if (!el) return;
  const fileBase = `تقرير_${safeName(lastReport.project.name)}_${todayStr()}`;
  if (typeof html2pdf === 'undefined') { window.print(); return; }
  el.classList.add('pdf-mode');
  html2pdf().set({
    margin: 8,
    filename: fileBase + '.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(el).save().then(() => el.classList.remove('pdf-mode')).catch(() => el.classList.remove('pdf-mode'));
}

/* ---- Full data backup (JSON) ---- */
function exportBackup() {
  const data = JSON.stringify({ app: 'contracting', version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  downloadBlob(blob, `نسخة_احتياطية_${todayStr()}.json`);
}

function importBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = parsed && parsed.data ? parsed.data : parsed;
      if (!incoming || !Array.isArray(incoming.projects)) throw new Error('bad');
      if (!confirm('سيتم استبدال كل البيانات الحالية بمحتوى الملف. هل تريد المتابعة؟')) { ev.target.value = ''; return; }
      replaceAllProjects(incoming.projects)
        .then(() => {
          document.getElementById('reportOutput').innerHTML = '';
          lastReport = null;
          alert('تم استيراد البيانات بنجاح ✅');
        })
        .catch(e2 => alert('تعذّر الاستيراد إلى السحابة: ' + e2.message));
    } catch (e) {
      alert('الملف غير صالح. تأكد من اختيار ملف نسخة احتياطية صحيح.');
    }
    ev.target.value = '';
  };
  reader.readAsText(file);
}

/* ---- Automatic backups: view & restore ---- */
function openAutoBackups() {
  renderAutoBackups();
  document.getElementById('autoModal').classList.add('open');
}
function closeAutoModal() {
  document.getElementById('autoModal').classList.remove('open');
}
document.getElementById('autoModal').addEventListener('click', e => {
  if (e.target.id === 'autoModal') closeAutoModal();
});
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function renderAutoBackups() {
  const list = loadAutoBackups().slice().reverse();
  const wrap = document.getElementById('autoList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty"><div class="big">🕓</div>لا توجد نسخ تلقائية بعد. ستُحفظ تلقائياً عند أول تعديل على البيانات.</div>';
    return;
  }
  wrap.innerHTML = list.map(s => {
    const count = (s.data && s.data.projects) ? s.data.projects.length : 0;
    return `<div class="summary-box" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px">
      <div>
        <div class="val" style="font-size:15px">${fmtDateTime(s.ts)}</div>
        <div class="lbl">${count} مشروع</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="downloadAutoBackup('${s.ts}')">تنزيل</button>
        <button class="btn btn-primary btn-sm" onclick="restoreAutoBackup('${s.ts}')">استعادة</button>
      </div>
    </div>`;
  }).join('');
}
function restoreAutoBackup(ts) {
  const snap = loadAutoBackups().find(s => s.ts === ts);
  if (!snap) { alert('تعذّر العثور على هذه النسخة.'); return; }
  if (!confirm('سيتم استبدال كل البيانات الحالية بهذه النسخة (' + fmtDateTime(ts) + '). هل تريد المتابعة؟')) return;
  const projects = (snap.data && snap.data.projects) ? snap.data.projects : [];
  replaceAllProjects(projects)
    .then(() => {
      document.getElementById('reportOutput').innerHTML = '';
      lastReport = null;
      closeAutoModal();
      alert('تمت استعادة النسخة بنجاح ✅');
    })
    .catch(e => alert('تعذّر استعادة النسخة إلى السحابة: ' + e.message));
}
function downloadAutoBackup(ts) {
  const snap = loadAutoBackups().find(s => s.ts === ts);
  if (!snap) return;
  const data = JSON.stringify({ app: 'contracting', version: 1, exportedAt: snap.ts, data: snap.data }, null, 2);
  downloadBlob(new Blob([data], { type: 'application/json' }), `نسخة_تلقائية_${snap.day}.json`);
}

/* ================= Auth + Realtime Sync (Init) ================= */
function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
}
function showLogin() {
  document.getElementById('appRoot').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
}

function doLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errBox.style.display = 'none';
  btn.disabled = true; btn.textContent = 'جارٍ الدخول...';
  auth.signInWithEmailAndPassword(email, pass)
    .catch(err => {
      let msg = 'تعذّر تسجيل الدخول. تحقق من البريد وكلمة المرور.';
      if (err.code === 'auth/invalid-email') msg = 'صيغة البريد الإلكتروني غير صحيحة.';
      if (err.code === 'auth/network-request-failed') msg = 'لا يوجد اتصال بالإنترنت.';
      errBox.textContent = msg;
      errBox.style.display = 'block';
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'دخول'; });
  return false;
}

function doLogout() {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  auth.signOut();
}

/* بدء الاستماع للتزامن اللحظي بين الأجهزة */
function startSync() {
  if (unsub) { unsub(); unsub = null; }
  unsub = projectsCol().onSnapshot(
    snap => {
      state.projects = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      state.projects.sort((a, b) => (a.contractDate || '') < (b.contractDate || '') ? 1 : -1);
      mirrorLocal();
      renderProjects();
      refreshReportSelect();
      if (currentProjectId) renderModal();
    },
    err => console.error('sync error', err)
  );
}

/* مراقبة حالة تسجيل الدخول */
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    showApp();
    startSync();
  } else {
    if (unsub) { unsub(); unsub = null; }
    state = { projects: [] };
    currentProjectId = null;
    showLogin();
  }
});

/* ---- Preview Modal ---- */
let previewInvoiceData = null;
let previewReceiptData = null;

function showPreviewModal(invData, recData) {
  previewInvoiceData = invData;
  previewReceiptData = recData;
  // Fill invoice into preview invoice template
  fillInvoiceTemplate(invData);
  // Fill receipt into preview receipt template
  fillReceiptTemplate(recData);
  // Move templates into preview modal areas
  const invTmpl = document.getElementById('invoicePrintTemplate');
  const recTmpl = document.getElementById('receiptPrintTemplate');
  const invArea = document.getElementById('previewInvoiceArea');
  const recArea = document.getElementById('previewReceiptArea');
  invArea.innerHTML = '';
  recArea.innerHTML = '';
  invArea.appendChild(invTmpl);
  recArea.appendChild(recTmpl);
  invTmpl.style.display = 'block';
  recTmpl.style.display = 'block';
  document.getElementById('previewModal').style.display = 'flex';
}

function closePreviewModal() {
  document.getElementById('previewModal').style.display = 'none';
  const invTmpl = document.getElementById('invoicePrintTemplate');
  const recTmpl = document.getElementById('receiptPrintTemplate');
  invTmpl.style.display = 'none';
  recTmpl.style.display = 'none';
  // Return templates to body (hidden)
  document.body.appendChild(invTmpl);
  document.body.appendChild(recTmpl);
}

function fillInvoiceTemplate(inv) {
  const items = (inv.items || []);
  let subtotal = 0;
  items.forEach(it => subtotal += (Number(it.qtyPrev)||0 + Number(it.qtyCurr)||0) * (Number(it.rate)||0));
  const vat = subtotal * 0.15;
  const total = subtotal + vat;
  document.getElementById('ptCustomer').textContent = inv.customer;
  document.getElementById('ptProject').textContent = inv.project;
  document.getElementById('ptVatNo').textContent = inv.vatNo || '-';
  document.getElementById('ptInvNo').textContent = inv.number;
  document.getElementById('ptDate').textContent = fmtDate(inv.date);
  document.getElementById('ptPayType').textContent = inv.payType;
  document.getElementById('ptNotes').textContent = inv.notes || '';
  document.getElementById('ptTotalWords').textContent = numberToArabicWords(total);
  const tbody = document.getElementById('ptItems');
  tbody.innerHTML = items.map(it => `
    <tr>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${it.no}</td>
      <td style="border:1px solid #000;padding:5px;font-size:12px">${esc(it.desc)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${esc(it.unit)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyContract)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyPrev)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyCurr)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.qtyTotal)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.rate)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtPrev)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtCurr)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;font-size:12px">${fmt(it.amtTotal)}</td>
    </tr>
  `).join('');
  document.getElementById('ptSubtotal').textContent = fmt(subtotal);
  document.getElementById('ptVat').textContent = fmt(vat);
  document.getElementById('ptTotal').textContent = fmt(total);
  // QR Code
  try {
    const qrEl = document.getElementById('ptBarcode');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      const qrData = toZATCAQR({ date: inv.date, total: total, vat: vat });
      new QRCode(qrEl, { text: qrData, width: 120, height: 120, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    }
  } catch(e) { console.warn('QR error', e); }
}

function fillReceiptTemplate(rec) {
  document.getElementById('ptRecNo').textContent = rec.number;
  document.getElementById('ptRecDate').textContent = fmtDate(rec.date);
  document.getElementById('ptRecInvNo').textContent = rec.invoiceNumber;
  document.getElementById('ptRecAmount').textContent = fmt(rec.amount);
  document.getElementById('ptRecFrom').textContent = rec.customer;
  document.getElementById('ptRecAmountWords').textContent = rec.amountWords;
  document.getElementById('ptRecDesc').textContent = rec.description;
  try {
    const qrEl = document.getElementById('ptRecBarcode');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      const recVat = rec.amount - (rec.amount / 1.15);
      const qrData = toZATCAQR({ date: rec.date, total: rec.amount, vat: recVat });
      new QRCode(qrEl, { text: qrData, width: 120, height: 120, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    }
  } catch(e) { console.warn('QR error', e); }
}

function printPreview() {
  window.print();
}

async function downloadPreviewInvoicePDF() {
  const inv = previewInvoiceData;
  if (!inv) return;
  const el = document.getElementById('invoicePrintTemplate');
  const logoImg = el.querySelector('img[src*="logo"]');
  if (logoImg) { try { logoImg.src = await loadImageAsBase64(logoImg.src); } catch(e) {} }
  try {
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pdf.internal.pageSize.getHeight();
    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pdf.internal.pageSize.getHeight();
    }
    pdf.save(`فاتورة_${inv.number}.pdf`);
  } catch (err) {
    console.error(err);
    alert('تعذّر توليد PDF. جرّب الطباعة بدلاً من ذلك.');
  }
}

async function downloadPreviewReceiptPDF() {
  const rec = previewReceiptData;
  if (!rec) return;
  const el = document.getElementById('receiptPrintTemplate');
  const logoImg = el.querySelector('img[src*="logo"]');
  if (logoImg) { try { logoImg.src = await loadImageAsBase64(logoImg.src); } catch(e) {} }
  try {
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    pdf.addImage(imgData, 'JPEG', 0, 0, imgWidth, Math.min(imgHeight, pageHeight));
    pdf.save(`سند_قبض_${rec.number}.pdf`);
  } catch (err) {
    console.error(err);
    alert('تعذّر توليد PDF.');
  }
}

function confirmSaveInvoice() {
  if (!previewInvoiceData) return;
  const invData = { ...previewInvoiceData, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  const invId = uid();
  invoicesCol().doc(invId).set(invData).then(() => {
    const recId = uid();
    const recData = { ...previewReceiptData, invoiceId: invId, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    return receiptsCol().doc(recId).set(recData);
  }).then(() => {
    alert('تم حفظ الفاتورة وسند القبض ✅');
    closePreviewModal();
    document.getElementById('invoiceForm').reset();
    document.getElementById('invItemsBody').innerHTML = '';
    recalcInvoice();
    renderInvoicesList();
  }).catch(err => alert('تعذّر الحفظ: ' + err.message));
}

/* ================= Completed Works ================= */
function renderCompletedWorks() {
  const wrap = document.getElementById('completedList');
  if (!wrap) return;
  if (!state.projects.length) {
    wrap.innerHTML = '<p style="text-align:center;color:var(--muted)">لا توجد بيانات.</p>';
    return;
  }
  // Gather all works from expenses 'work' field
  const allWorks = [];
  state.projects.forEach(p => {
    (p.expenses || []).forEach(e => {
      if (e.work && e.work.trim()) {
        allWorks.push({
          projectName: p.name,
          company: p.company || '-',
          work: e.work.trim(),
          amount: Number(e.amount) || 0,
          date: e.date,
          reason: e.reason || '-'
        });
      }
    });
  });
  if (!allWorks.length) {
    wrap.innerHTML = '<p style="text-align:center;color:var(--muted)">لا توجد أعمال منجزة مسجلة. أضف عملاً منجزاً في بيان المصروفات.</p>';
    return;
  }
  // Sort by date desc
  allWorks.sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);

  wrap.innerHTML = '<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>المشروع</th><th>الشركة</th><th>العمل المنجز</th><th>المبلغ</th><th>البيان</th></tr></thead><tbody>' +
    allWorks.map(w => `<tr><td>${fmtDate(w.date)}</td><td>${esc(w.projectName)}</td><td>${esc(w.company)}</td><td>${esc(w.work)}</td><td>${fmt(w.amount)}</td><td>${esc(w.reason)}</td></tr>`).join('') +
    '</tbody></table></div>';
}

/* ================= Dashboard ================= */
let dashboardChartInstance = null;

function renderDashboard() {
  const statsWrap = document.getElementById('dashboardStats');
  const chartCanvas = document.getElementById('dashboardChart');
  const projectsWrap = document.getElementById('dashboardProjects');
  if (!statsWrap || !chartCanvas || !projectsWrap) return;

  if (!state.projects.length) {
    statsWrap.innerHTML = '<p style="text-align:center;color:var(--muted)">لا توجد بيانات.</p>';
    projectsWrap.innerHTML = '';
    return;
  }

  let totalExpenses = 0, totalRevenues = 0, totalWorks = 0;
  const projectStats = [];

  state.projects.forEach(p => {
    const exp = (p.expenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const rev = (p.revenues || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const works = (p.expenses || []).filter(e => e.work && e.work.trim()).length;
    totalExpenses += exp;
    totalRevenues += rev;
    totalWorks += works;
    projectStats.push({ name: p.name, company: p.company, expenses: exp, revenues: rev, works, profit: rev - exp });
  });

  // Stats cards
  statsWrap.innerHTML = `
    <div class="project-card" style="text-align:center"><div style="font-size:28px;color:var(--danger)">${fmt(totalExpenses)}</div><div style="font-size:13px;color:var(--muted)">إجمالي المصروفات</div></div>
    <div class="project-card" style="text-align:center"><div style="font-size:28px;color:var(--success)">${fmt(totalRevenues)}</div><div style="font-size:13px;color:var(--muted)">إجمالي الإيرادات</div></div>
    <div class="project-card" style="text-align:center"><div style="font-size:28px;color:${totalRevenues >= totalExpenses ? 'var(--success)' : 'var(--danger)'}">${fmt(totalRevenues - totalExpenses)}</div><div style="font-size:13px;color:var(--muted)">صافي الربح / الخسارة</div></div>
    <div class="project-card" style="text-align:center"><div style="font-size:28px;color:var(--primary)">${totalWorks}</div><div style="font-size:13px;color:var(--muted)">الأعمال المنجزة</div></div>
  `;

  // Chart.js bar chart
  const labels = projectStats.map(p => p.name);
  const expData = projectStats.map(p => p.expenses);
  const revData = projectStats.map(p => p.revenues);
  const ctx = chartCanvas.getContext('2d');
  if (dashboardChartInstance) dashboardChartInstance.destroy();
  dashboardChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'المصروفات', data: expData, backgroundColor: '#ef4444' },
        { label: 'الإيرادات', data: revData, backgroundColor: '#22c55e' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { y: { beginAtZero: true } }
    }
  });

  // Per-project cards
  projectsWrap.innerHTML = '<h3 style="margin-bottom:12px">تفاصيل المشاريع</h3>' +
    projectStats.map(p => `
      <div class="project-card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
          <div><strong>${esc(p.name)}</strong> <span style="color:var(--muted)">— ${esc(p.company)}</span></div>
          <div style="display:flex;gap:20px;font-size:13px;margin-top:4px">
            <span>💰 ${fmt(p.expenses)} مصروفات</span>
            <span>📥 ${fmt(p.revenues)} إيرادات</span>
            <span>✅ ${p.works} أعمال منجزة</span>
            <span style="color:${p.profit >= 0 ? 'var(--success)' : 'var(--danger)'}">📈 ${fmt(p.profit)} صافي</span>
          </div>
        </div>
      </div>
    `).join('');
}

/* ---- PWA: تسجيل الـ service worker للعمل دون إنترنت ---- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  });
}

/* ---- زر تثبيت التطبيق على الجهاز ---- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'inline-block';
});
async function installApp() {
  if (!deferredPrompt) {
    alert('لتثبيت التطبيق:\n• أندرويد (Chrome): القائمة ⋮ ثم "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية".\n• آيفون (Safari): زر المشاركة ثم "إضافة إلى الشاشة الرئيسية".');
    return;
  }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
}
window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
});
