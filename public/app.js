import { checkPlacement, computeForbiddenSlotsMap, validateFullSchedule } from './shared/validator.js';
import { saveLocalSnapshot, loadLocalSnapshot } from './lib/storage.js';

const DEFAULT_STATE = {
  config: {
    schoolId: 'smpn-1-nusantara',
    schoolName: 'SMP Negeri 1 Nusantara',
    academicYear: '2026/2027',
    days: ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'],
    periodsPerDay: 8,
    workerUrl: 'https://pembuat-jadwal.yhanedy.workers.dev'
  },
  subjects: [
    { id: 's1', name: 'Matematika', code: 'MTK', category: 'EXACT' },
    { id: 's2', name: 'Ilmu Pengetahuan Alam', code: 'IPA', category: 'EXACT' },
    { id: 's3', name: 'Ilmu Pengetahuan Sosial', code: 'IPS', category: 'SOCIAL' },
    { id: 's4', name: 'Bahasa Indonesia', code: 'IND', category: 'LANG' },
    { id: 's5', name: 'Bahasa Inggris', code: 'ING', category: 'LANG' },
    { id: 's6', name: 'Pendidikan Jasmani', code: 'PJOK', category: 'ART' }
  ],
  teachers: [
    { id: 't1', name: 'Pak Budi Santoso', code: 'BUD', timeOff: {} },
    { id: 't2', name: 'Bu Siti Aminah', code: 'SIT', timeOff: {} },
    { id: 't3', name: 'Pak Andi Wijaya', code: 'AND', timeOff: {} },
    { id: 't4', name: 'Bu Rina Marlina', code: 'RIN', timeOff: {} }
  ],
  classes: [
    { id: 'c1', name: '7A', timeOff: {} },
    { id: 'c2', name: '7B', timeOff: {} },
    { id: 'c3', name: '8A', timeOff: {} }
  ],
  rooms: [
    { id: 'r1', name: 'R.7A' },
    { id: 'r2', name: 'R.7B' },
    { id: 'r3', name: 'R.8A' },
    { id: 'r4', name: 'Lab IPA' }
  ],
  contracts: [
    { id: 'k1', teacherId: 't1', subjectId: 's1', classId: 'c1', roomId: 'r1', sessions: 2, duration: 2 },
    { id: 'k2', teacherId: 't1', subjectId: 's1', classId: 'c2', roomId: 'r2', sessions: 2, duration: 2 },
    { id: 'k3', teacherId: 't2', subjectId: 's4', classId: 'c1', roomId: 'r1', sessions: 2, duration: 2 },
    { id: 'k4', teacherId: 't2', subjectId: 's5', classId: 'c3', roomId: 'r3', sessions: 2, duration: 2 },
    { id: 'k5', teacherId: 't3', subjectId: 's2', classId: 'c1', roomId: 'r4', sessions: 2, duration: 2 },
    { id: 'k6', teacherId: 't3', subjectId: 's2', classId: 'c2', roomId: 'r4', sessions: 2, duration: 2 },
    { id: 'k7', teacherId: 't4', subjectId: 's3', classId: 'c2', roomId: 'r2', sessions: 2, duration: 1 },
    { id: 'k8', teacherId: 't4', subjectId: 's6', classId: 'c3', roomId: 'r3', sessions: 1, duration: 2 }
  ],
  cards: []
};

const CARD_STYLES = {
  EXACT: 'bg-blue-600 border-blue-800 text-white',
  SOCIAL: 'bg-emerald-600 border-emerald-800 text-white',
  LANG: 'bg-amber-400 border-amber-600 text-slate-950',
  ART: 'bg-purple-600 border-purple-800 text-white'
};

let state = null;
let serverVersion = 0;
let undoStack = [];
let draggingCard = null;
let forbiddenMap = new Map();
let zoomLevel = 100;
let activeMasterTab = 'SUBJECTS';
let solverWorker = null;

// ============================================================================
// 1. INISIALISASI & MUTASI DATA
// ============================================================================
async function init() {
  const saved = await loadLocalSnapshot(DEFAULT_STATE.config.schoolId);
  if (saved?.state) {
    state = saved.state;
    serverVersion = saved.serverVersion || 0;
  } else {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    rebuildCardsFromContracts();
  }

  refreshDayFilter();
  renderAll();
  lucide.createIcons();
}

function rebuildCardsFromContracts() {
  state.cards = [];
  state.contracts.forEach(k => {
    for (let i = 0; i < (k.sessions || 1); i++) {
      state.cards.push({
        cardId: `${k.id}_s${i + 1}`,
        contractId: k.id,
        dayIndex: null,
        startPeriod: null,
        isLocked: false
      });
    }
  });
}

function mutate(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 20) undoStack.shift();
  document.getElementById('btnUndo').disabled = false;

  fn(state);
  renderAll();
  saveLocalSnapshot(state.config.schoolId, state, serverVersion);
  document.getElementById('saveStatus').textContent = '● Tersimpan';
}

window.undoAction = () => {
  if (undoStack.length === 0) return;
  state = JSON.parse(undoStack.pop());
  document.getElementById('btnUndo').disabled = undoStack.length === 0;
  renderAll();
  saveLocalSnapshot(state.config.schoolId, state, serverVersion);
};

function renderAll() {
  document.getElementById('schoolTitleTop').textContent = state.config.schoolName;
  renderGrid();
  renderBottomDeck();
  updateConflictRibbon();
}

// ============================================================================
// 2. GRID MATRIKS KLASIK aSc TIMETABLES
// ============================================================================
window.renderGrid = () => {
  const mode = document.getElementById('viewModeSelect').value;
  const dayFilter = document.getElementById('dayFilterSelect').value;
  const thead = document.getElementById('matrixHead');
  const tbody = document.getElementById('matrixBody');

  const days = state.config.days
    .map((name, index) => ({ name, index }))
    .filter(d => dayFilter === 'ALL' || String(d.index) === dayFilter);
  const periods = state.config.periodsPerDay;

  let h1 = `<tr><th rowspan="2" class="bg-slate-800 text-white border border-slate-500 px-3 py-1.5 text-left min-w-[110px] sticky left-0 z-30">${
    mode === 'CLASS' ? 'Kelas' : mode === 'TEACHER' ? 'Guru' : 'Ruangan'
  }</th>`;
  let h2 = `<tr>`;

  days.forEach(d => {
    h1 += `<th colspan="${periods}" class="bg-slate-700 text-white border border-slate-500 py-1 text-center uppercase tracking-wider">${d.name}</th>`;
    for (let p = 0; p < periods; p++) {
      h2 += `<th class="bg-slate-200 text-slate-800 border border-slate-400 py-0.5 text-center font-bold min-w-[66px]">${p + 1}</th>`;
    }
  });
  thead.innerHTML = h1 + '</tr>' + h2 + '</tr>';

  const rows = mode === 'CLASS' ? state.classes : mode === 'TEACHER' ? state.teachers : state.rooms;

  tbody.innerHTML = rows.map(row => {
    let tr = `<tr><td class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 font-bold text-slate-900 sticky left-0 z-10">${row.name}</td>`;

    days.forEach(d => {
      for (let p = 0; p < periods; p++) {
        const slotKey = `${d.index}-${p}`;
        const isTimeOff = row.timeOff?.[slotKey];

        const cardsHere = state.cards.filter(c => {
          if (c.dayIndex !== d.index || c.startPeriod === null) return false;
          const k = state.contracts.find(x => x.id === c.contractId);
          if (!k) return false;
          const match = (mode === 'CLASS' && k.classId === row.id) ||
                        (mode === 'TEACHER' && k.teacherId === row.id) ||
                        (mode === 'ROOM' && k.roomId === row.id);
          return match && p >= c.startPeriod && p < (c.startPeriod + k.duration);
        });

        const startCard = cardsHere.find(c => c.startPeriod === p);
        const spanCard = cardsHere.find(c => c.startPeriod < p);
        if (spanCard) continue;

        if (startCard) {
          const k = state.contracts.find(x => x.id === startCard.contractId);
          const valid = checkPlacement(state, startCard, d.index, p, startCard.cardId).valid;
          tr += `<td colspan="${k.duration}" data-day="${d.index}" data-period="${p}"
            class="border border-slate-400 p-0.5 align-middle ${!valid ? 'bg-rose-200' : 'bg-white'}">
            ${createCardElement(startCard, !valid)}
          </td>`;
        } else {
          tr += `<td data-day="${d.index}" data-period="${p}" data-rowid="${row.id}"
            onclick="onEmptyCellClick(event, ${d.index}, ${p}, '${row.id}')"
            class="border border-slate-300 h-12 p-0.5 ${isTimeOff ? 'asc-cell-timeoff' : 'asc-cell-empty cursor-pointer'}">
            ${isTimeOff ? 'X' : ''}
          </td>`;
        }
      }
    });
    return tr + '</tr>';
  }).join('');
};

function createCardElement(card, isConflict = false) {
  const k = state.contracts.find(x => x.id === card.contractId);
  if (!k) return '';
  const subj = state.subjects.find(s => s.id === k.subjectId);
  const teacher = state.teachers.find(t => t.id === k.teacherId);
  const cls = state.classes.find(c => c.id === k.classId);
  const room = state.rooms.find(r => r.id === k.roomId);

  const style = isConflict
    ? 'bg-rose-600 border-rose-900 text-white animate-pulse'
    : (CARD_STYLES[subj?.category] || CARD_STYLES.EXACT);

  return `
    <div draggable="true" data-cardid="${card.cardId}"
      onclick="event.stopPropagation(); onCardClick(event, '${card.cardId}')"
      class="asc-card rounded border px-1.5 py-0.5 leading-tight ${style}">
      <div class="flex justify-between items-center font-bold text-[11px]">
        <span>${subj?.code || '?'}</span>
        <span>${card.isLocked ? '🔒' : ''}</span>
      </div>
      <div class="text-[10px] truncate">${cls?.name} • ${teacher?.code}</div>
      <div class="text-[9px] opacity-85 truncate">${room?.name}</div>
    </div>
  `;
}

// Drag & Drop 60 FPS
const matrixTable = document.getElementById('matrixTable');
document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-cardid]');
  if (!el) return;
  draggingCard = state.cards.find(c => c.cardId === el.dataset.cardid);
  if (draggingCard) forbiddenMap = computeForbiddenSlotsMap(state, draggingCard);
});

matrixTable.addEventListener('dragover', e => {
  e.preventDefault();
  const td = e.target.closest('td[data-day]');
  if (!td || !draggingCard) return;
  document.querySelectorAll('.drop-valid, .drop-invalid').forEach(x => x.classList.remove('drop-valid', 'drop-invalid'));

  const key = `${td.dataset.day}-${td.dataset.period}`;
  const bar = document.getElementById('statusMessageBar');
  if (forbiddenMap.has(key)) {
    td.classList.add('drop-invalid');
    bar.innerHTML = `<span class="text-rose-600">❌ Tidak bisa: ${forbiddenMap.get(key)}</span>`;
  } else {
    td.classList.add('drop-valid');
    bar.innerHTML = `<span class="text-emerald-700">✅ Slot aman — lepaskan mouse untuk memasang kartu</span>`;
  }
});

matrixTable.addEventListener('drop', e => {
  e.preventDefault();
  document.querySelectorAll('.drop-valid, .drop-invalid').forEach(x => x.classList.remove('drop-valid', 'drop-invalid'));
  const td = e.target.closest('td[data-day]');
  if (!td || !draggingCard) return;

  const d = parseInt(td.dataset.day, 10);
  const p = parseInt(td.dataset.period, 10);
  mutate(draft => {
    const c = draft.cards.find(x => x.cardId === draggingCard.cardId);
    if (c) { c.dayIndex = d; c.startPeriod = p; }
  });
  draggingCard = null;
});

// ============================================================================
// 3. DOCK KARTU BAWAH & POPOVER KLIK KARTU / SEL KOSONG
// ============================================================================
window.renderBottomDeck = () => {
  const q = document.getElementById('deckSearchInput').value.toLowerCase();
  const unplaced = state.cards.filter(c => c.dayIndex === null);
  document.getElementById('unplacedCount').textContent = unplaced.length;

  const filtered = unplaced.filter(c => {
    const k = state.contracts.find(x => x.id === c.contractId);
    const text = [
      state.subjects.find(s => s.id === k?.subjectId)?.name,
      state.teachers.find(t => t.id === k?.teacherId)?.name,
      state.classes.find(cl => cl.id === k?.classId)?.name
    ].join(' ').toLowerCase();
    return text.includes(q);
  });

  document.getElementById('bottomCardDeck').innerHTML = filtered.map(c =>
    `<div class="w-28 shrink-0">${createCardElement(c)}</div>`
  ).join('') || `<div class="text-slate-400 italic px-2">Semua kartu pelajaran sudah terpasang di grid jadwal.</div>`;
};

window.onEmptyCellClick = (event, dayIndex, period, rowId) => {
  const mode = document.getElementById('viewModeSelect').value;
  const unplaced = state.cards.filter(c => c.dayIndex === null);
  const matching = unplaced.filter(c => {
    const k = state.contracts.find(x => x.id === c.contractId);
    if (!k) return false;
    return mode === 'CLASS' ? k.classId === rowId : mode === 'TEACHER' ? k.teacherId === rowId : k.roomId === rowId;
  });

  const pool = matching.length > 0 ? matching : unplaced;
  if (pool.length === 0) {
    alert('Semua kartu sudah ditempatkan. Tambahkan pelajaran baru lewat menu "Pelajaran" jika diperlukan.');
    return;
  }

  const pop = document.getElementById('slotPopover');
  document.getElementById('popoverTitle').textContent = `${state.config.days[dayIndex]} • Jam ke-${period + 1}`;
  document.getElementById('popoverBody').innerHTML = `
    <select id="popCardSel" class="w-full border border-slate-300 rounded p-1.5 bg-white">
      ${pool.map(c => {
        const k = state.contracts.find(x => x.id === c.contractId);
        const s = state.subjects.find(x => x.id === k.subjectId)?.name;
        const cl = state.classes.find(x => x.id === k.classId)?.name;
        const t = state.teachers.find(x => x.id === k.teacherId)?.name;
        const ok = checkPlacement(state, c, dayIndex, period).valid;
        return `<option value="${c.cardId}">${ok ? '✅' : '⚠️'} ${s} - ${cl} (${t})</option>`;
      }).join('')}
    </select>
    <div class="flex justify-end gap-1.5 pt-1">
      <button onclick="closePopover()" class="px-2.5 py-1 bg-slate-200 rounded">Batal</button>
      <button onclick="placeFromPopover(${dayIndex}, ${period})" class="px-3 py-1 bg-blue-600 text-white font-bold rounded">Pasang</button>
    </div>
  `;
  positionPopover(pop, event);
};

window.onCardClick = (event, cardId) => {
  const card = state.cards.find(c => c.cardId === cardId);
  if (!card || card.dayIndex === null) return;
  const k = state.contracts.find(x => x.id === card.contractId);
  const subj = state.subjects.find(s => s.id === k?.subjectId)?.name;
  const teacher = state.teachers.find(t => t.id === k?.teacherId)?.name;
  const cls = state.classes.find(c => c.id === k?.classId)?.name;

  const pop = document.getElementById('slotPopover');
  document.getElementById('popoverTitle').textContent = `${subj} (${cls})`;
  document.getElementById('popoverBody').innerHTML = `
    <div class="text-slate-600">Guru: <b>${teacher}</b> • Durasi: <b>${k?.duration} Jam</b></div>
    <div class="grid grid-cols-2 gap-1.5 pt-1">
      <button onclick="toggleLockCard('${cardId}')" class="py-1.5 px-2 rounded border font-semibold ${card.isLocked ? 'bg-amber-100 border-amber-400 text-amber-900' : 'bg-slate-100'}">
        ${card.isLocked ? '🔓 Buka Kunci' : '🔒 Kunci Kartu'}
      </button>
      <button onclick="removeCardFromGrid('${cardId}')" class="py-1.5 px-2 rounded bg-rose-600 text-white font-semibold">
        Keluarkan
      </button>
    </div>
  `;
  positionPopover(pop, event);
};

function positionPopover(pop, event) {
  pop.style.left = `${Math.min(event.clientX + 8, window.innerWidth - 300)}px`;
  pop.style.top = `${Math.min(event.clientY + 8, window.innerHeight - 170)}px`;
  pop.classList.remove('hidden');
}

window.closePopover = () => document.getElementById('slotPopover').classList.add('hidden');

window.placeFromPopover = (dayIndex, period) => {
  const cardId = document.getElementById('popCardSel').value;
  mutate(d => {
    const c = d.cards.find(x => x.cardId === cardId);
    if (c) { c.dayIndex = dayIndex; c.startPeriod = period; }
  });
  closePopover();
};

window.toggleLockCard = (cardId) => {
  mutate(d => {
    const c = d.cards.find(x => x.cardId === cardId);
    if (c) c.isLocked = !c.isLocked;
  });
  closePopover();
};

window.removeCardFromGrid = (cardId) => {
  mutate(d => {
    const c = d.cards.find(x => x.cardId === cardId);
    if (c) { c.dayIndex = null; c.startPeriod = null; c.isLocked = false; }
  });
  closePopover();
};

// ============================================================================
// 4. MENU EDIT DATA MASTER (SEKOLAH, MAPEL, KELAS, RUANG, GURU, PELAJARAN)
// ============================================================================
window.openMasterModal = (tab = 'SUBJECTS') => {
  document.getElementById('modalMaster').classList.remove('hidden');
  switchMasterTab(tab);
};

window.closeMasterModal = () => {
  document.getElementById('modalMaster').classList.add('hidden');
  renderAll();
};

window.switchMasterTab = (tab) => {
  activeMasterTab = tab;
  ['SCHOOL', 'SUBJECTS', 'CLASSES', 'ROOMS', 'TEACHERS', 'CONTRACTS'].forEach(t => {
    const btn = document.getElementById(`mtab-${t}`);
    btn.className = t === tab
      ? 'px-3 py-1.5 rounded-t font-bold border border-b-0 bg-white text-blue-700'
      : 'px-3 py-1.5 rounded-t font-semibold text-slate-600 hover:bg-slate-200';
  });
  renderMasterTabContent();
};

function renderMasterTabContent() {
  const box = document.getElementById('masterModalBody');

  if (activeMasterTab === 'SCHOOL') {
    box.innerHTML = `
      <div class="grid grid-cols-2 gap-3 max-w-lg">
        <div>
          <label class="font-bold block mb-1">Nama Sekolah</label>
          <input id="mSchoolName" value="${state.config.schoolName}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">Tahun Ajaran</label>
          <input id="mAcademicYear" value="${state.config.academicYear}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">Jumlah Jam Pelajaran / Hari</label>
          <input id="mPeriods" type="number" min="4" max="12" value="${state.config.periodsPerDay}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">ID Sekolah (Untuk Link Siswa)</label>
          <input id="mSchoolId" value="${state.config.schoolId}" class="w-full border rounded p-1.5">
        </div>
      </div>
      <button onclick="saveSchoolSettings()" class="bg-blue-600 text-white px-4 py-1.5 rounded font-bold mt-2">Simpan Pengaturan Sekolah</button>
    `;
  } else if (activeMasterTab === 'SUBJECTS') {
    box.innerHTML = `
      <div class="flex gap-2 bg-slate-100 p-2 rounded border">
        <input id="newSubjName" placeholder="Nama Mata Pelajaran (mis: Matematika)" class="flex-1 border rounded px-2 py-1 bg-white">
        <input id="newSubjCode" placeholder="Singkatan (MTK)" class="w-28 border rounded px-2 py-1 bg-white">
        <select id="newSubjCat" class="border rounded px-2 py-1 bg-white">
          <option value="EXACT">Eksakta (Biru)</option>
          <option value="SOCIAL">Sosial (Hijau)</option>
          <option value="LANG">Bahasa (Kuning)</option>
          <option value="ART">Seni/PJOK (Ungu)</option>
        </select>
        <button onclick="addMasterSubject()" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah</button>
      </div>
      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200"><tr><th class="border p-1.5 text-left">Nama Mapel</th><th class="border p-1.5">Kode</th><th class="border p-1.5">Kategori</th><th class="border p-1.5 w-20">Aksi</th></tr></thead>
        <tbody>
          ${state.subjects.map(s => `
            <tr>
              <td class="border p-1.5"><input value="${s.name}" onchange="editEntityName('subjects','${s.id}',this.value)" class="w-full px-1"></td>
              <td class="border p-1.5 text-center font-bold">${s.code}</td>
              <td class="border p-1.5 text-center">${s.category}</td>
              <td class="border p-1.5 text-center"><button onclick="deleteEntity('subjects','${s.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  } else if (activeMasterTab === 'CLASSES' || activeMasterTab === 'ROOMS') {
    const key = activeMasterTab === 'CLASSES' ? 'classes' : 'rooms';
    const label = activeMasterTab === 'CLASSES' ? 'Kelas' : 'Ruangan';
    box.innerHTML = `
      <div class="flex gap-2 bg-slate-100 p-2 rounded border max-w-md">
        <input id="newSimpleName" placeholder="Nama ${label} baru..." class="flex-1 border rounded px-2 py-1 bg-white">
        <button onclick="addSimpleEntity('${key}')" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah ${label}</button>
      </div>
      <table class="w-full border-collapse border border-slate-300 max-w-md">
        <thead class="bg-slate-200"><tr><th class="border p-1.5 text-left">Nama ${label}</th><th class="border p-1.5 w-20">Aksi</th></tr></thead>
        <tbody>
          ${state[key].map(item => `
            <tr>
              <td class="border p-1.5"><input value="${item.name}" onchange="editEntityName('${key}','${item.id}',this.value)" class="w-full px-1"></td>
              <td class="border p-1.5 text-center"><button onclick="deleteEntity('${key}','${item.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  } else if (activeMasterTab === 'TEACHERS') {
    box.innerHTML = `
      <div class="flex gap-2 bg-slate-100 p-2 rounded border max-w-lg">
        <input id="newTeacherName" placeholder="Nama Lengkap Guru" class="flex-1 border rounded px-2 py-1 bg-white">
        <input id="newTeacherCode" placeholder="Kode (BUD)" class="w-28 border rounded px-2 py-1 bg-white">
        <button onclick="addMasterTeacher()" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah Guru</button>
      </div>
      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200"><tr><th class="border p-1.5 text-left">Nama Guru</th><th class="border p-1.5 w-28">Kode</th><th class="border p-1.5 w-20">Aksi</th></tr></thead>
        <tbody>
          ${state.teachers.map(t => `
            <tr>
              <td class="border p-1.5"><input value="${t.name}" onchange="editEntityName('teachers','${t.id}',this.value)" class="w-full px-1"></td>
              <td class="border p-1.5 text-center font-bold">${t.code}</td>
              <td class="border p-1.5 text-center"><button onclick="deleteEntity('teachers','${t.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  } else if (activeMasterTab === 'CONTRACTS') {
    box.innerHTML = `
      <div class="grid grid-cols-6 gap-1.5 bg-blue-50 p-2.5 rounded border border-blue-200">
        <select id="cTeacher" class="border rounded p-1 bg-white">${state.teachers.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <select id="cSubject" class="border rounded p-1 bg-white">${state.subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
        <select id="cClass" class="border rounded p-1 bg-white">${state.classes.map(c => `<option value="${c.id}">Kelas ${c.name}</option>`).join('')}</select>
        <select id="cRoom" class="border rounded p-1 bg-white">${state.rooms.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}</select>
        <div class="flex gap-1">
          <input id="cSessions" type="number" min="1" max="6" value="2" title="Jumlah Pertemuan/Minggu" class="w-1/2 border rounded p-1 bg-white">
          <select id="cDuration" class="w-1/2 border rounded p-1 bg-white"><option value="1">1 Jam</option><option value="2" selected>2 Jam</option></select>
        </div>
        <button onclick="addMasterContract()" class="bg-emerald-600 text-white rounded font-bold hover:bg-emerald-700">+ Buat Kartu</button>
      </div>
      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200">
          <tr><th class="border p-1.5 text-left">Guru</th><th class="border p-1.5 text-left">Mapel</th><th class="border p-1.5">Kelas</th><th class="border p-1.5">Ruang</th><th class="border p-1.5">Beban</th><th class="border p-1.5">Aksi</th></tr>
        </thead>
        <tbody>
          ${state.contracts.map(k => {
            const t = state.teachers.find(x => x.id === k.teacherId)?.name || '-';
            const s = state.subjects.find(x => x.id === k.subjectId)?.name || '-';
            const c = state.classes.find(x => x.id === k.classId)?.name || '-';
            const r = state.rooms.find(x => x.id === k.roomId)?.name || '-';
            return `<tr>
              <td class="border p-1.5">${t}</td>
              <td class="border p-1.5">${s}</td>
              <td class="border p-1.5 text-center font-bold">${c}</td>
              <td class="border p-1.5 text-center">${r}</td>
              <td class="border p-1.5 text-center">${k.sessions}x (${k.duration} jam)</td>
              <td class="border p-1.5 text-center"><button onclick="deleteContract('${k.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}

window.saveSchoolSettings = () => {
  mutate(d => {
    d.config.schoolName = document.getElementById('mSchoolName').value;
    d.config.academicYear = document.getElementById('mAcademicYear').value;
    d.config.periodsPerDay = parseInt(document.getElementById('mPeriods').value, 10) || 8;
    d.config.schoolId = document.getElementById('mSchoolId').value.trim();
  });
  alert('Pengaturan sekolah disimpan.');
};

window.addMasterSubject = () => {
  const name = document.getElementById('newSubjName').value.trim();
  const code = document.getElementById('newSubjCode').value.trim().toUpperCase();
  const category = document.getElementById('newSubjCat').value;
  if (!name || !code) return;
  mutate(d => d.subjects.push({ id: 's' + Date.now(), name, code, category }));
  renderMasterTabContent();
};

window.addSimpleEntity = (key) => {
  const name = document.getElementById('newSimpleName').value.trim();
  if (!name) return;
  mutate(d => d[key].push({ id: key[0] + Date.now(), name, timeOff: {} }));
  renderMasterTabContent();
};

window.addMasterTeacher = () => {
  const name = document.getElementById('newTeacherName').value.trim();
  const code = document.getElementById('newTeacherCode').value.trim().toUpperCase();
  if (!name || !code) return;
  mutate(d => d.teachers.push({ id: 't' + Date.now(), name, code, timeOff: {} }));
  renderMasterTabContent();
};

window.addMasterContract = () => {
  const k = {
    id: 'k' + Date.now(),
    teacherId: document.getElementById('cTeacher').value,
    subjectId: document.getElementById('cSubject').value,
    classId: document.getElementById('cClass').value,
    roomId: document.getElementById('cRoom').value,
    sessions: parseInt(document.getElementById('cSessions').value, 10) || 1,
    duration: parseInt(document.getElementById('cDuration').value, 10) || 1
  };
  mutate(d => {
    d.contracts.push(k);
    for (let i = 0; i < k.sessions; i++) {
      d.cards.push({ cardId: `${k.id}_s${i + 1}`, contractId: k.id, dayIndex: null, startPeriod: null, isLocked: false });
    }
  });
  renderMasterTabContent();
};

window.editEntityName = (key, id, newName) => {
  mutate(d => {
    const item = d[key].find(x => x.id === id);
    if (item && newName.trim()) item.name = newName.trim();
  });
};

window.deleteEntity = (key, id) => {
  if (!confirm('Hapus data ini?')) return;
  mutate(d => { d[key] = d[key].filter(x => x.id !== id); });
  renderMasterTabContent();
};

window.deleteContract = (contractId) => {
  mutate(d => {
    d.contracts = d.contracts.filter(x => x.id !== contractId);
    d.cards = d.cards.filter(c => c.contractId !== contractId);
  });
  renderMasterTabContent();
};

// ============================================================================
// 5. MENU UPLOAD (IMPORT CSV / COPY-PASTE EXCEL / JSON)
// ============================================================================
window.openUploadModal = () => document.getElementById('modalUpload').classList.remove('hidden');
window.closeUploadModal = () => document.getElementById('modalUpload').classList.add('hidden');

window.downloadCsvTemplate = () => {
  const csv = [
    'Guru,KodeGuru,Mapel,KodeMapel,Kelas,Ruang,Pertemuan,JamPerPertemuan',
    'Pak Budi Santoso,BUD,Matematika,MTK,7A,R.7A,2,2',
    'Bu Siti Aminah,SIT,Bahasa Indonesia,IND,7A,R.7A,2,2',
    'Pak Andi Wijaya,AND,IPA Terpadu,IPA,7B,Lab IPA,2,2'
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template_jadwal_sekolah.csv';
  a.click();
};

window.processUploadedFile = () => {
  const file = document.getElementById('uploadFileInput').files[0];
  if (!file) return alert('Pilih file CSV atau JSON terlebih dahulu.');
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    if (file.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.config && parsed.cards) {
          mutate(() => { state = parsed; });
          closeUploadModal();
          alert('✅ File backup JSON berhasil dimuat!');
        }
      } catch { alert('Format JSON tidak valid.'); }
    } else {
      importTabularRows(text);
    }
  };
  reader.readAsText(file);
};

window.processPastedExcel = () => {
  const raw = document.getElementById('pasteExcelArea').value.trim();
  if (!raw) return alert('Tempel data dari Excel terlebih dahulu.');
  importTabularRows(raw);
};

function importTabularRows(rawText) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let importedCount = 0;

  mutate(d => {
    lines.forEach((line, idx) => {
      // Mendukung pemisah Tab (dari Copy-Paste Excel) maupun Koma (CSV)
      const cols = line.includes('\t') ? line.split('\t') : line.split(',');
      if (cols.length < 6) return;
      if (idx === 0 && cols[0].toLowerCase().includes('guru')) return; // Lewati baris judul

      const [tName, tCode, sName, sCode, cName, rName, sessStr, durStr] = cols.map(x => x.trim());
      if (!tName || !sName || !cName) return;

      let teacher = d.teachers.find(x => x.name.toLowerCase() === tName.toLowerCase());
      if (!teacher) {
        teacher = { id: 't' + Date.now() + idx, name: tName, code: tCode || tName.slice(0, 3).toUpperCase(), timeOff: {} };
        d.teachers.push(teacher);
      }

      let subject = d.subjects.find(x => x.name.toLowerCase() === sName.toLowerCase());
      if (!subject) {
        subject = { id: 's' + Date.now() + idx, name: sName, code: sCode || sName.slice(0, 3).toUpperCase(), category: 'EXACT' };
        d.subjects.push(subject);
      }

      let schoolClass = d.classes.find(x => x.name.toLowerCase() === cName.toLowerCase());
      if (!schoolClass) {
        schoolClass = { id: 'c' + Date.now() + idx, name: cName, timeOff: {} };
        d.classes.push(schoolClass);
      }

      let room = d.rooms.find(x => x.name.toLowerCase() === (rName || cName).toLowerCase());
      if (!room) {
        room = { id: 'r' + Date.now() + idx, name: rName || `R.${cName}` };
        d.rooms.push(room);
      }

      const sessions = parseInt(sessStr, 10) || 1;
      const duration = parseInt(durStr, 10) || 1;
      const k = { id: 'k' + Date.now() + idx, teacherId: teacher.id, subjectId: subject.id, classId: schoolClass.id, roomId: room.id, sessions, duration };
      d.contracts.push(k);

      for (let i = 0; i < sessions; i++) {
        d.cards.push({ cardId: `${k.id}_s${i + 1}`, contractId: k.id, dayIndex: null, startPeriod: null, isLocked: false });
      }
      importedCount++;
    });
  });

  closeUploadModal();
  alert(`✅ Berhasil mengimpor ${importedCount} baris pelajaran ke tumpukan kartu bawah!`);
}

// ============================================================================
// 6. GENERATOR OTOMATIS, VALIDASI, SIMPAN CLOUD & PUBLISH
// ============================================================================
window.openGeneratorModal = () => {
  document.getElementById('modalGenerator').classList.remove('hidden');
  document.getElementById('genFormArea').classList.remove('hidden');
  document.getElementById('genProgressArea').classList.add('hidden');
};
window.closeGeneratorModal = () => {
  if (solverWorker) solverWorker.terminate();
  document.getElementById('modalGenerator').classList.add('hidden');
};

window.startWorkerGeneration = () => {
  const mode = document.querySelector('input[name="genMode"]:checked').value;
  document.getElementById('genFormArea').classList.add('hidden');
  document.getElementById('genProgressArea').classList.remove('hidden');

  solverWorker = new Worker('./solver.worker.js', { type: 'module' });
  solverWorker.onmessage = (e) => {
    if (e.data.type === 'PROGRESS') {
      const pct = Math.min(95, Math.round((e.data.iterations / e.data.maxIterations) * 100));
      document.getElementById('genProgressBar').style.width = `${pct}%`;
      document.getElementById('genProgressLabel').textContent = `Menyusun... (${e.data.placed}/${e.data.total} kartu terpasang)`;
    } else if (e.data.type === 'DONE') {
      mutate(d => { d.cards = e.data.cards; });
      closeGeneratorModal();
    }
  };
  solverWorker.postMessage({ type: 'START', state, options: { mode, respectLocks: true, maxIterations: 25000 } });
};

function updateConflictRibbon() {
  const rep = validateFullSchedule(state);
  const el = document.getElementById('ribbonConflictText');
  el.innerHTML = rep.hardCount === 0
    ? `<span class="text-emerald-700 font-bold">0 Bentrok</span>`
    : `<span class="text-rose-600 font-bold">${rep.hardCount} Bentrok!</span>`;
}

window.checkAndShowConflicts = () => {
  const rep = validateFullSchedule(state);
  if (rep.conflicts.length === 0) {
    alert('✅ Jadwal bersih! Tidak ditemukan bentrok guru, kelas, maupun ruangan.');
  } else {
    alert('Temuan Validasi:\n\n' + rep.conflicts.map(c => `• ${c.title}: ${c.detail}`).join('\n'));
  }
};

window.saveDraftToCloud = async () => {
  const url = state.config.workerUrl.replace(/\/$/, '');
  document.getElementById('saveStatus').textContent = '⏳ Menyimpan...';
  try {
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/save-draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(serverVersion) },
      body: JSON.stringify(state)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
    serverVersion = data.version;
    document.getElementById('saveStatus').textContent = `● Cloud v${serverVersion}`;
    alert('✅ Draft jadwal berhasil disimpan ke Cloud!');
  } catch (err) {
    alert('Gagal simpan cloud: ' + err.message);
  }
};

window.publishToStudents = async () => {
  const rep = validateFullSchedule(state);
  if (!rep.isValid) {
    alert(`Masih ada ${rep.hardCount} bentrok merah. Perbaiki dulu sebelum Publish ke siswa.`);
    return;
  }
  const url = state.config.workerUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error('Gagal publish');
    alert(`✅ Jadwal berhasil dipublikasikan!\n\nLink Siswa:\n${window.location.origin}/siswa.html?school=${state.config.schoolId}`);
  } catch (err) {
    alert('Gagal publish: ' + err.message);
  }
};

window.exportBackupJson = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `asc_jadwal_${state.config.schoolId}.json`;
  a.click();
};

function refreshDayFilter() {
  const sel = document.getElementById('dayFilterSelect');
  sel.innerHTML = `<option value="ALL">Semua Hari</option>` +
    state.config.days.map((d, i) => `<option value="${i}">${d}</option>`).join('');
}

window.changeZoom = (delta) => {
  zoomLevel = Math.max(70, Math.min(130, zoomLevel + delta));
  document.getElementById('zoomLabel').textContent = `${zoomLevel}%`;
  document.getElementById('matrixTable').style.transform = `scale(${zoomLevel / 100})`;
};

init();
