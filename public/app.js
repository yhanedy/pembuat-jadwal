import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBZZxpHu8wq-ho66KPjrcn_5KugeerJt2o",
  authDomain: "pembuat-jadwal-sekolah.firebaseapp.com",
  projectId: "pembuat-jadwal-sekolah",
  storageBucket: "pembuat-jadwal-sekolah.firebasestorage.app",
  messagingSenderId: "205713744621",
  appId: "1:205713744621:web:5ca89216a45edc277322e4"
};

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
let currentUser = null;

// ============================================================================
// VALIDASI & PENYIMPANAN LOKAL
// ============================================================================
function checkPlacement(state, card, dayIndex, startPeriod, ignoreCardId = null) {
  const k = state.contracts.find(x => x.id === card.contractId);
  if (!k) return { valid: false, reason: 'Kontrak tidak ditemukan' };
  const dur = k.duration || 1;
  if (startPeriod + dur > state.config.periodsPerDay) {
    return { valid: false, reason: 'Melebihi jumlah jam per hari' };
  }

  const cls = state.classes.find(c => c.id === k.classId);
  const teacher = state.teachers.find(t => t.id === k.teacherId);

  for (let offset = 0; offset < dur; offset++) {
    const p = startPeriod + offset;
    const key = `${dayIndex}-${p}`;
    if (cls?.timeOff?.[key]) return { valid: false, reason: `Kelas ${cls.name} libur pada jam ini` };
    if (teacher?.timeOff?.[key]) return { valid: false, reason: `${teacher.name} tidak mengajar pada jam ini` };

    for (const other of state.cards) {
      if (other.cardId === ignoreCardId || other.dayIndex !== dayIndex || other.startPeriod === null) continue;
      const ok = state.contracts.find(x => x.id === other.contractId);
      if (!ok) continue;
      const oEnd = other.startPeriod + (ok.duration || 1);
      if (p >= other.startPeriod && p < oEnd) {
        if (ok.classId === k.classId) return { valid: false, reason: `Kelas ${cls?.name} sudah ada pelajaran` };
        if (ok.teacherId === k.teacherId) return { valid: false, reason: `${teacher?.name} sedang mengajar kelas lain` };
        if (k.roomId && ok.roomId && ok.roomId === k.roomId) return { valid: false, reason: 'Ruangan sedang dipakai' };
      }
    }
  }
  return { valid: true };
}

function computeForbiddenSlotsMap(state, card) {
  const map = new Map();
  for (let d = 0; d < state.config.days.length; d++) {
    for (let p = 0; p < state.config.periodsPerDay; p++) {
      const res = checkPlacement(state, card, d, p, card.cardId);
      if (!res.valid) map.set(`${d}-${p}`, res.reason);
    }
  }
  return map;
}

function validateFullSchedule(state) {
  const conflicts = [];
  for (const card of state.cards) {
    if (card.dayIndex === null || card.startPeriod === null) continue;
    const res = checkPlacement(state, card, card.dayIndex, card.startPeriod, card.cardId);
    if (!res.valid) {
      const k = state.contracts.find(x => x.id === card.contractId);
      const subj = state.subjects.find(s => s.id === k?.subjectId)?.name || 'Mapel';
      conflicts.push({ title: `${subj} (${state.config.days[card.dayIndex]} Jam ${card.startPeriod + 1})`, detail: res.reason });
    }
  }
  return { isValid: conflicts.length === 0, hardCount: conflicts.length, conflicts };
}

function saveLocalSnapshot(schoolId, stateObj, version) {
  try {
    localStorage.setItem(`asc_snap_${schoolId}`, JSON.stringify({ state: stateObj, serverVersion: version }));
  } catch (e) { console.warn(e); }
}

function loadLocalSnapshot(schoolId) {
  try {
    const raw = localStorage.getItem(`asc_snap_${schoolId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Pemecah total jam mingguan otomatis menjadi blok ala aSc TimeTables (misal 4 jam -> 2+2, 3 jam -> 2+1)
function splitHoursToBlocks(totalHours) {
  const h = parseInt(totalHours, 10) || 0;
  if (h <= 0) return [];
  if (h === 1) return [1];
  if (h === 2) return [2];
  if (h === 3) return [2, 1];
  if (h === 4) return [2, 2];
  if (h === 5) return [3, 2];
  if (h === 6) return [2, 2, 2];
  const blocks = [];
  let rem = h;
  while (rem > 0) {
    if (rem >= 2) { blocks.push(2); rem -= 2; }
    else { blocks.push(1); rem -= 1; }
  }
  return blocks;
}

// ============================================================================
// STATE UTAMA
// ============================================================================
const DEFAULT_STATE = {
  config: {
    schoolId: 'sman-2-karanganyar',
    schoolName: 'SMAN 2 Karanganyar',
    academicYear: '2026/2027',
    days: ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'],
    periodsPerDay: 9,
    workerUrl: 'https://pembuat-jadwal.yhanedy.workers.dev'
  },
  subjects: [
    { id: 's1', name: 'Matematika', code: 'MTK', category: 'EXACT' },
    { id: 's2', name: 'Fisika', code: 'FIS', category: 'EXACT' },
    { id: 's3', name: 'Bahasa Indonesia', code: 'IND', category: 'LANG' },
    { id: 's4', name: 'Bahasa Inggris', code: 'ING', category: 'LANG' },
    { id: 's5', name: 'Sejarah', code: 'SEJ', category: 'SOCIAL' },
    { id: 's6', name: 'PJOK', code: 'PJOK', category: 'ART' }
  ],
  teachers: [
    { id: 't1', name: 'Guru Matematika 1', code: 'G01', timeOff: {} },
    { id: 't2', name: 'Guru B. Indonesia 1', code: 'G02', timeOff: {} }
  ],
  classes: [
    { id: 'c1', name: 'X1', timeOff: {} },
    { id: 'c2', name: 'X2', timeOff: {} },
    { id: 'c3', name: 'X3', timeOff: {} }
  ],
  rooms: [],
  contracts: [],
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
let activeMasterTab = 'CONTRACTS';
let solverWorker = null;

// ============================================================================
// 1. LOGIN GMAIL & PEMBERSIH KARTU YATIM (ANTI-UNDEFINED)
// ============================================================================
window.loginWithGoogle = async () => {
  const errEl = document.getElementById('loginErrorMsg');
  errEl.classList.add('hidden');
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(auth, provider);
    } else {
      errEl.textContent = 'Gagal masuk: ' + err.message;
      errEl.classList.remove('hidden');
    }
  }
};

window.logoutGoogle = async () => {
  await signOut(auth);
  location.reload();
};

getRedirectResult(auth).catch(() => {});

function cleanOrphanRecords(st) {
  const validTeacherIds = new Set(st.teachers.map(t => t.id));
  const validSubjectIds = new Set(st.subjects.map(s => s.id));
  const validClassIds = new Set(st.classes.map(c => c.id));
  st.contracts = st.contracts.filter(k =>
    validTeacherIds.has(k.teacherId) && validSubjectIds.has(k.subjectId) && validClassIds.has(k.classId)
  );
  const validContractIds = new Set(st.contracts.map(k => k.id));
  st.cards = st.cards.filter(c => validContractIds.has(c.contractId));
}

onAuthStateChanged(auth, async (user) => {
  if (window.lucide) window.lucide.createIcons();
  if (!user) {
    document.getElementById('loginGateModal').classList.remove('hidden');
    return;
  }

  currentUser = user;
  document.getElementById('loginGateModal').classList.add('hidden');
  document.getElementById('userEmailBadge').textContent = user.email;

  const userSchoolId = `sch_${user.uid}`;
  const token = await user.getIdToken();
  const workerUrl = DEFAULT_STATE.config.workerUrl.replace(/\/$/, '');

  try {
    const res = await fetch(`${workerUrl}/api/admin/${userSchoolId}/load`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const cloudData = await res.json();
    if (cloudData && !cloudData.empty && cloudData.state) {
      state = cloudData.state;
      serverVersion = cloudData.version || 1;
      state.config.schoolId = userSchoolId;
      cleanOrphanRecords(state);
      refreshDayFilter();
      renderAll();
      return;
    }
  } catch (e) { console.warn(e); }

  const saved = loadLocalSnapshot(userSchoolId);
  if (saved?.state) {
    state = saved.state;
    serverVersion = saved.serverVersion || 0;
  } else {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    state.config.schoolId = userSchoolId;
  }

  cleanOrphanRecords(state);
  refreshDayFilter();
  renderAll();
});

function mutate(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 20) undoStack.shift();
  document.getElementById('btnUndo').disabled = false;

  fn(state);
  cleanOrphanRecords(state);
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
        <span>${subj?.code || '?'} (${k.duration}j)</span>
        <span>${card.isLocked ? '🔒' : ''}</span>
      </div>
      <div class="text-[10px] truncate">${cls?.name || '-'} • ${teacher?.code || '-'}</div>
      ${room ? `<div class="text-[9px] opacity-85 truncate">${room.name}</div>` : ''}
    </div>
  `;
}

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
    alert('Belum ada kartu pelajaran. Klik menu "Pelajaran" untuk mengisi pembagian jam.');
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
        return `<option value="${c.cardId}">${ok ? '✅' : '⚠️'} ${s} (${k.duration}j) - ${cl} (${t})</option>`;
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
// 4. MENU EDIT DATA MASTER (TERMASUK MATRIKS PEMBAGIAN JAM ALA EXCEL!)
// ============================================================================
window.openMasterModal = (tab = 'CONTRACTS') => {
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
          <input id="mPeriods" type="number" min="4" max="14" value="${state.config.periodsPerDay}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">ID Akun Sekolah (Otomatis)</label>
          <input value="${state.config.schoolId}" readonly class="w-full border rounded p-1.5 bg-slate-100 text-slate-500">
        </div>
      </div>
      <div class="flex gap-2 pt-3">
        <button onclick="saveSchoolSettings()" class="bg-blue-600 text-white px-4 py-1.5 rounded font-bold">Simpan Pengaturan</button>
        <button onclick="resetAllContracts()" class="bg-rose-100 text-rose-700 border border-rose-300 px-3 py-1.5 rounded font-semibold hover:bg-rose-200">Kosongkan Semua Pelajaran/Kartu</button>
      </div>
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
    const label = activeMasterTab === 'CLASSES' ? 'Kelas' : 'Ruangan (Opsional)';
    box.innerHTML = `
      <div class="flex gap-2 bg-slate-100 p-2 rounded border max-w-lg">
        <input id="newSimpleName" placeholder="Ketik nama ${label} (bisa pisah koma: X1, X2, X3)..." class="flex-1 border rounded px-2 py-1 bg-white">
        <button onclick="addSimpleEntity('${key}')" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah</button>
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
        <input id="newTeacherCode" placeholder="Kode (G01)" class="w-28 border rounded px-2 py-1 bg-white">
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
    // TAMPILAN MATRIKS PEMBAGIAN JAM ALA EXCEL ANDA!
    box.innerHTML = `
      <div class="bg-blue-50 border border-blue-200 rounded p-3 space-y-2">
        <div class="font-bold text-blue-900">Input Pembagian Jam Mengajar (Cukup isi total jam per minggu di masing-masing kelas):</div>
        <div class="flex flex-wrap items-center gap-2">
          <select id="mTeacher" class="border border-slate-300 rounded px-2 py-1.5 bg-white font-semibold">
            ${state.teachers.map(t => `<option value="${t.id}">${t.name} (${t.code})</option>`).join('')}
          </select>
          <select id="mSubject" class="border border-slate-300 rounded px-2 py-1.5 bg-white font-semibold">
            ${state.subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
          <button onclick="saveMatrixDistribution()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded font-bold ml-auto">
            + Simpan Pembagian Jam
          </button>
        </div>
        <div class="overflow-x-auto pt-1">
          <table class="border-collapse border border-slate-300 bg-white">
            <thead>
              <tr class="bg-slate-200">
                ${state.classes.map(c => `<th class="border border-slate-300 px-3 py-1 text-center min-w-[56px]">${c.name}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              <tr>
                ${state.classes.map(c => `
                  <td class="border border-slate-300 p-1 text-center">
                    <input type="number" min="0" max="12" placeholder="0" data-classid="${c.id}"
                      class="matrix-hour-input w-12 text-center border border-slate-300 rounded py-1 font-bold text-blue-700">
                  </td>`).join('')}
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-[11px] text-slate-600">*Otomatis dipecah menjadi kartu pertemuan (contoh: <b>4 jam</b> otomatis jadi <b>2+2 jam</b>, <b>3 jam</b> jadi <b>2+1 jam</b>).</p>
      </div>

      <div class="flex justify-between items-center pt-2">
        <span class="font-bold text-slate-700">Daftar Kartu Pelajaran Terdaftar (${state.cards.length} kartu):</span>
        <button onclick="resetAllContracts()" class="text-rose-600 hover:underline font-semibold">Hapus Semua Daftar</button>
      </div>

      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200">
          <tr><th class="border p-1.5 text-left">Guru</th><th class="border p-1.5 text-left">Mapel</th><th class="border p-1.5">Kelas</th><th class="border p-1.5">Pecahan Jam</th><th class="border p-1.5 w-20">Aksi</th></tr>
        </thead>
        <tbody>
          ${state.contracts.map(k => {
            const t = state.teachers.find(x => x.id === k.teacherId)?.name || '-';
            const s = state.subjects.find(x => x.id === k.subjectId)?.name || '-';
            const c = state.classes.find(x => x.id === k.classId)?.name || '-';
            return `<tr>
              <td class="border p-1.5">${t}</td>
              <td class="border p-1.5">${s}</td>
              <td class="border p-1.5 text-center font-bold">${c}</td>
              <td class="border p-1.5 text-center">${k.sessions}x (${k.duration} jam)</td>
              <td class="border p-1.5 text-center"><button onclick="deleteContract('${k.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}

window.saveMatrixDistribution = () => {
  const teacherId = document.getElementById('mTeacher').value;
  const subjectId = document.getElementById('mSubject').value;
  const inputs = document.querySelectorAll('.matrix-hour-input');
  let added = 0;

  mutate(d => {
    inputs.forEach((inp, idx) => {
      const hours = parseInt(inp.value, 10) || 0;
      if (hours <= 0) return;
      const classId = inp.dataset.classid;
      const blocks = splitHoursToBlocks(hours);

      // Kelompokkan blok berdurasi sama (misal [2, 2] -> 2x2 jam; [2, 1] -> 1x2 jam & 1x1 jam)
      const grouped = {};
      blocks.forEach(b => { grouped[b] = (grouped[b] || 0) + 1; });

      Object.entries(grouped).forEach(([durStr, sessCount], gIdx) => {
        const duration = parseInt(durStr, 10);
        const k = {
          id: `k${Date.now()}_${idx}_${gIdx}`,
          teacherId, subjectId, classId, roomId: '',
          sessions: sessCount, duration
        };
        d.contracts.push(k);
        for (let i = 0; i < sessCount; i++) {
          d.cards.push({ cardId: `${k.id}_s${i + 1}`, contractId: k.id, dayIndex: null, startPeriod: null, isLocked: false });
        }
        added++;
      });
    });
  });

  if (added === 0) return alert('Isi minimal satu angka jam pada kolom kelas.');
  renderMasterTabContent();
};

window.resetAllContracts = () => {
  if (!confirm('Hapus semua daftar pelajaran dan kartu?')) return;
  mutate(d => { d.contracts = []; d.cards = []; });
  renderMasterTabContent();
};

window.saveSchoolSettings = () => {
  mutate(d => {
    d.config.schoolName = document.getElementById('mSchoolName').value;
    d.config.academicYear = document.getElementById('mAcademicYear').value;
    d.config.periodsPerDay = parseInt(document.getElementById('mPeriods').value, 10) || 9;
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
  const raw = document.getElementById('newSimpleName').value.trim();
  if (!raw) return;
  const names = raw.split(',').map(x => x.trim()).filter(Boolean);
  mutate(d => {
    names.forEach((name, i) => {
      if (!d[key].some(x => x.name.toLowerCase() === name.toLowerCase())) {
        d[key].push({ id: key[0] + Date.now() + i, name, timeOff: {} });
      }
    });
  });
  renderMasterTabContent();
};

window.addMasterTeacher = () => {
  const name = document.getElementById('newTeacherName').value.trim();
  const code = document.getElementById('newTeacherCode').value.trim().toUpperCase();
  if (!name || !code) return;
  mutate(d => d.teachers.push({ id: 't' + Date.now(), name, code, timeOff: {} }));
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
// 5. MENU UPLOAD & COPY-PASTE MATRIKS EXCEL PEMBAGIAN JAM!
// ============================================================================
window.openUploadModal = () => document.getElementById('modalUpload').classList.remove('hidden');
window.closeUploadModal = () => document.getElementById('modalUpload').classList.add('hidden');

window.downloadCsvTemplate = () => {
  // Template Matriks Pembagian Jam Persis Seperti Excel Anda!
  const csv = [
    'Guru,Kode,Mapel,X1,X2,X3,X4,XI1,XI2',
    'Drs. Ahmad Fauzi,AFZ,Matematika,4,4,4,0,0,0',
    'Siti Rahmawati S.Pd,SRW,Bahasa Indonesia,4,4,0,0,4,4',
    'Budi Santoso M.Pd,BDS,Fisika,0,0,0,3,3,3'
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template_pembagian_jam_matriks.csv';
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
          const keepSchoolId = state.config.schoolId;
          mutate(() => { state = parsed; state.config.schoolId = keepSchoolId; });
          closeUploadModal();
          alert('✅ File backup JSON berhasil dimuat!');
        }
      } catch { alert('Format JSON tidak valid.'); }
    } else {
      importMatrixExcel(text);
    }
  };
  reader.readAsText(file);
};

window.processPastedExcel = () => {
  const raw = document.getElementById('pasteExcelArea').value.trim();
  if (!raw) return alert('Tempel tabel pembagian jam dari Excel terlebih dahulu.');
  importMatrixExcel(raw);
};

// Membaca Tabel Matriks: Kolom 1=Guru, Kolom 2=Kode, Kolom 3=Mapel, Kolom 4..N=Nama Kelas (isi angka jam)
function importMatrixExcel(rawText) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return alert('Minimal harus ada 1 baris judul kelas dan 1 baris data guru.');

  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map(h => h.trim());
  const classNames = headers.slice(3).filter(Boolean);
  if (classNames.length === 0) return alert('Pastikan baris pertama memuat judul kolom: Guru | Kode | Mapel | NamaKelas1 | NamaKelas2 ...');

  let cardCount = 0;

  mutate(d => {
    // Pastikan semua nama kelas dari header Excel terdaftar
    const classObjs = classNames.map((cName, idx) => {
      let cls = d.classes.find(x => x.name.toLowerCase() === cName.toLowerCase());
      if (!cls) {
        cls = { id: `c${Date.now()}_${idx}`, name: cName, timeOff: {} };
        d.classes.push(cls);
      }
      return cls;
    });

    for (let r = 1; r < lines.length; r++) {
      const cols = lines[r].split(sep).map(c => c.trim());
      const [tName, tCode, sName] = cols;
      if (!tName || !sName) continue;

      let teacher = d.teachers.find(x => x.name.toLowerCase() === tName.toLowerCase());
      if (!teacher) {
        teacher = { id: `t${Date.now()}_${r}`, name: tName, code: tCode || tName.slice(0, 3).toUpperCase(), timeOff: {} };
        d.teachers.push(teacher);
      }

      let subject = d.subjects.find(x => x.name.toLowerCase() === sName.toLowerCase());
      if (!subject) {
        subject = { id: `s${Date.now()}_${r}`, name: sName, code: sName.slice(0, 4).toUpperCase(), category: 'EXACT' };
        d.subjects.push(subject);
      }

      classObjs.forEach((cls, cIdx) => {
        const hours = parseInt(cols[3 + cIdx], 10) || 0;
        if (hours <= 0) return;

        const blocks = splitHoursToBlocks(hours);
        const grouped = {};
        blocks.forEach(b => { grouped[b] = (grouped[b] || 0) + 1; });

        Object.entries(grouped).forEach(([durStr, sessCount], gIdx) => {
          const duration = parseInt(durStr, 10);
          const k = {
            id: `k${Date.now()}_${r}_${cIdx}_${gIdx}`,
            teacherId: teacher.id, subjectId: subject.id, classId: cls.id, roomId: '',
            sessions: sessCount, duration
          };
          d.contracts.push(k);
          for (let i = 0; i < sessCount; i++) {
            d.cards.push({ cardId: `${k.id}_s${i + 1}`, contractId: k.id, dayIndex: null, startPeriod: null, isLocked: false });
            cardCount++;
          }
        });
      });
    }
  });

  closeUploadModal();
  alert(`✅ Berhasil mengimpor pembagian jam! Terbentuk ${cardCount} kartu pelajaran siap susun.`);
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
    alert('✅ Jadwal bersih! Tidak ditemukan bentrok guru maupun kelas.');
  } else {
    alert('Temuan Validasi:\n\n' + rep.conflicts.map(c => `• ${c.title}: ${c.detail}`).join('\n'));
  }
};

window.saveDraftToCloud = async () => {
  if (!currentUser) return alert('Silakan login dengan Gmail terlebih dahulu.');
  const url = state.config.workerUrl.replace(/\/$/, '');
  document.getElementById('saveStatus').textContent = '⏳ Menyimpan...';
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/save-draft`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': String(serverVersion),
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(state)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
    serverVersion = data.version;
    document.getElementById('saveStatus').textContent = `● Cloud v${serverVersion}`;
    alert('✅ Draft jadwal berhasil disimpan ke Cloud!');
  } catch (err) {
    document.getElementById('saveStatus').textContent = '● Gagal Cloud';
    alert('Gagal simpan cloud: ' + err.message);
  }
};

window.publishToStudents = async () => {
  if (!currentUser) return alert('Silakan login dengan Gmail terlebih dahulu.');
  const rep = validateFullSchedule(state);
  if (!rep.isValid) {
    alert(`Masih ada ${rep.hardCount} bentrok merah. Perbaiki dulu sebelum Publish ke siswa.`);
    return;
  }
  const url = state.config.workerUrl.replace(/\/$/, '');
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(state)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal publish');
    alert(`✅ Jadwal berhasil dipublikasikan!\n\nLink Siswa Khusus Sekolah Anda:\n${window.location.origin}/siswa.html?school=${state.config.schoolId}`);
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
