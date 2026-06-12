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
function fmt(n) {
  return Number(n || 0).toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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

/* ================= Tabs ================= */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-projects').style.display = name === 'projects' ? 'block' : 'none';
  document.getElementById('tab-reports').style.display = name === 'reports' ? 'block' : 'none';
  if (name === 'reports') refreshReportSelect();
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
    et.innerHTML = `<thead><tr><th>التاريخ</th><th>السبب</th><th>العمل المنجز</th><th>المبلغ</th><th class="no-print"></th></tr></thead><tbody>` +
      p.expenses.slice().sort((a,b)=> (a.date<b.date?1:-1)).map(x => `<tr>
        <td>${fmtDate(x.date)}</td><td>${esc(x.reason)}</td><td>${esc(x.work)||'-'}</td>
        <td class="num neg">${fmt(x.amount)}</td>
        <td class="no-print"><button class="btn btn-danger-ghost btn-sm" onclick="deleteExpense('${x.id}')">حذف</button></td>
      </tr>`).join('') +
      `</tbody><tfoot><tr><th colspan="3">الإجمالي</th><th class="num neg">${fmt(exp)}</th><th class="no-print"></th></tr></tfoot>`;
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
    <div class="table-wrap"><table>
      <thead><tr><th>التاريخ</th><th>السبب</th><th>العمل المنجز</th><th>المبلغ</th></tr></thead>
      <tbody>${exps.length ? exps.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${esc(x.reason)}</td><td>${esc(x.work)||'-'}</td><td class="num neg">${fmt(x.amount)}</td></tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted)">لا توجد مصروفات في هذه الفترة</td></tr>'}</tbody>
      ${exps.length?`<tfoot><tr><th colspan="3">الإجمالي</th><th class="num neg">${fmt(totalExp)}</th></tr></tfoot>`:''}
    </table></div>

    <div class="section-title" style="color:var(--success)">الإيرادات (${revs.length})</div>
    <div class="table-wrap"><table>
      <thead><tr><th>رقم الدفعة</th><th>التاريخ</th><th>المبلغ</th></tr></thead>
      <tbody>${revs.length ? revs.map(x=>`<tr><td>${esc(x.number)}</td><td>${fmtDate(x.date)}</td><td class="num pos">${fmt(x.amount)}</td></tr>`).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--muted)">لا توجد إيرادات في هذه الفترة</td></tr>'}</tbody>
      ${revs.length?`<tfoot><tr><th colspan="2">الإجمالي</th><th class="num pos">${fmt(totalRev)}</th></tr></tfoot>`:''}
    </table></div>
  </div>`;

  renderReportChart(exps, revs, totalExp, totalRev);
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

  const expRows = [['التاريخ', 'السبب', 'العمل المنجز', 'المبلغ']];
  r.exps.forEach(x => expRows.push([fmtDate(x.date), x.reason, x.work || '', Number(x.amount)]));
  expRows.push(['', '', 'الإجمالي', r.totalExp]);
  const wsE = XLSX.utils.aoa_to_sheet(expRows);
  wsE['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 24 }, { wch: 14 }];
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
  lines.push(['التاريخ', 'السبب', 'العمل المنجز', 'المبلغ'].map(q).join(','));
  r.exps.forEach(x => lines.push([fmtDate(x.date), x.reason, x.work || '', x.amount].map(q).join(',')));
  lines.push(['', '', 'الإجمالي', r.totalExp].map(q).join(','));
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
