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
// VALIDASI & PENYIMPANAN LOKAL (TERMASUK BATAS JAM PER HARI SEPERTI JUMAT)
// ============================================================================
function getMaxPeriodForDay(state, dayIndex) {
  const dayName = state.config.days[dayIndex];
  if (state.config.dayMaxPeriods && state.config.dayMaxPeriods[dayName] !== undefined) {
    return state.config.dayMaxPeriods[dayName];
  }
  return state.config.periodsPerDay;
}

function checkPlacement(state, card, dayIndex, startPeriod, ignoreCardId = null) {
  const k = state.contracts.find(x => x.id === card.contractId);
  if (!k) return { valid: false, reason: 'Kontrak tidak ditemukan' };
  const dur = k.duration || 1;
  const maxForThisDay = getMaxPeriodForDay(state, dayIndex);
  const dayName = state.config.days[dayIndex] || '';

  if (startPeriod + dur > maxForThisDay) {
    return { valid: false, reason: `Hari ${dayName} hanya sampai jam ke-${maxForThisDay}` };
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
// PARSER CSV/TSV TAHAN KOMA & MULTI-BARIS DALAM SEL (RFC 4180)
// ============================================================================
function parseFullTableText(rawText) {
  const clean = rawText.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];

  // Deteksi pemisah dari baris pertama di luar tanda kutip
  let sep = ',';
  let inQ = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch === '\t') { sep = '\t'; break; }
    else if (!inQ && ch === ';') { sep = ';'; break; }
  }

  const rows = [];
  let row = [];
  let cell = '';
  inQ = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (ch === '"') {
      if (inQ && next === '"') {
        cell += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === sep && !inQ) {
      row.push(cell.replace(/\s+/g, ' ').trim());
      cell = '';
    } else if ((ch === '\r' || ch === '\n') && !inQ) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell.replace(/\s+/g, ' ').trim());
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.replace(/\s+/g, ' ').trim());
  if (row.some(c => c !== '')) rows.push(row);

  return rows;
}

// Membuat singkatan kode otomatis dari nama guru (mengabaikan gelar depan/belakang)
function generateTeacherCode(fullName, fallbackIndex) {
  const tanpaGelarBelakang = fullName.split(',')[0].trim();
  const bersih = tanpaGelarBelakang.replace(/^(Drs\.|Dra\.|Dr\.|Ir\.|H\.|Hj\.|Prof\.|S\.Pd\.?|M\.Pd\.?|M\.Si\.?)\s+/gi, '').trim();
  const words = bersih.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0].slice(0, 2) + words[1].slice(0, 2)).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 4).toUpperCase();
  }
  return `G${String(fallbackIndex).padStart(2, '0')}`;
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
    dayMaxPeriods: {
      Senin: 9,
      Selasa: 9,
      Rabu: 9,
      Kamis: 9,
      Jumat: 6,
      Sabtu: 8
    },
    workerUrl: 'https://pembuat-jadwal.yhanedy.workers.dev'
  },
  subjects: [],
  teachers: [],
  classes: [
    { id: 'c1', name: 'X1', timeOff: {} },
    { id: 'c2', name: 'X2', timeOff: {} }
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
// 1. LOGIN GMAIL & SINKRONISASI PENGATURAN HARI
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

function normalizeStateConfig(st) {
  if (!st.config.dayMaxPeriods) {
    st.config.dayMaxPeriods = {
      Senin: st.config.periodsPerDay || 9,
      Selasa: st.config.periodsPerDay || 9,
      Rabu: st.config.periodsPerDay || 9,
      Kamis: st.config.periodsPerDay || 9,
      Jumat: 6,
      Sabtu: Math.min(8, st.config.periodsPerDay || 8)
    };
  }
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
      normalizeStateConfig(state);
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

  normalizeStateConfig(state);
  refreshDayFilter();
  renderAll();
});

function mutate(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 20) undoStack.shift();
  document.getElementById('btnUndo').disabled = false;

  fn(state);
  normalizeStateConfig(state);
  renderAll();
  saveLocalSnapshot(state.config.schoolId, state, serverVersion);
  document.getElementById('saveStatus').textContent = '● Tersimpan';
}

window.undoAction = () => {
  if (undoStack.length === 0) return;
  state = JSON.parse(undoStack.pop());
  document.getElementById('btnUndo').disabled = undoStack.length === 0;
  refreshDayFilter();
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
// 2. GRID MATRIKS KLASIK (OTOMATIS BLOKIR JAM > 6 PADA HARI JUMAT)
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
    const maxP = getMaxPeriodForDay(state, d.index);
    h1 += `<th colspan="${periods}" class="bg-slate-700 text-white border border-slate-500 py-1 text-center uppercase tracking-wider">${d.name} <span class="text-[10px] font-normal text-slate-300">(s.d. Jam ${maxP})</span></th>`;
    for (let p = 0; p < periods; p++) {
      const isClosed = p >= maxP;
      h2 += `<th class="${isClosed ? 'bg-slate-300 text-slate-500' : 'bg-slate-200 text-slate-800'} border border-slate-400 py-0.5 text-center font-bold min-w-[66px]">${p + 1}</th>`;
    }
  });
  thead.innerHTML = h1 + '</tr>' + h2 + '</tr>';

  const rows = mode === 'CLASS' ? state.classes : mode === 'TEACHER' ? state.teachers : state.rooms;

  tbody.innerHTML = rows.map(row => {
    let tr = `<tr><td class="bg-slate-100 border border-slate-400 px-2.5 py-1.5 font-bold text-slate-900 sticky left-0 z-10">${row.name}</td>`;

    days.forEach(d => {
      const maxP = getMaxPeriodForDay(state, d.index);
      for (let p = 0; p < periods; p++) {
        const slotKey = `${d.index}-${p}`;
        const isDayClosed = p >= maxP;
        const isTimeOff = isDayClosed || row.timeOff?.[slotKey];

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
        } else if (isDayClosed) {
          tr += `<td data-day="${d.index}" data-period="${p}"
            title="Hari ${d.name} hanya sampai jam ke-${maxP}"
            class="border border-slate-300 h-12 p-0.5 asc-cell-timeoff text-[10px]">
            Libur
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
    alert('Belum ada kartu pelajaran. Klik menu "Pelajaran" atau "Upload Data" untuk mengisi pembagian jam.');
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
// 4. MENU EDIT DATA MASTER
// ============================================================================
window.openMasterModal = (tab = 'CONTRACTS') => {
  document.getElementById('modalMaster').classList.remove('hidden');
  switchMasterTab(tab);
};

window.closeMasterModal = () => {
  document.getElementById('modalMaster').classList.add('hidden');
  refreshDayFilter();
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
    const hasSabtu = state.config.days.includes('Sabtu');
    const allPossibleDays = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

    box.innerHTML = `
      <div class="grid grid-cols-2 gap-3 max-w-xl">
        <div>
          <label class="font-bold block mb-1">Nama Sekolah</label>
          <input id="mSchoolName" value="${state.config.schoolName}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">Tahun Ajaran</label>
          <input id="mAcademicYear" value="${state.config.academicYear}" class="w-full border rounded p-1.5">
        </div>
        <div>
          <label class="font-bold block mb-1">Sistem Hari Sekolah</label>
          <select id="mSchoolDaysCount" onchange="onChangeDaysPreset()" class="w-full border rounded p-1.5 bg-white font-semibold">
            <option value="5" ${!hasSabtu ? 'selected' : ''}>5 Hari Kerja (Senin – Jumat)</option>
            <option value="6" ${hasSabtu ? 'selected' : ''}>6 Hari Kerja (Senin – Sabtu)</option>
          </select>
        </div>
        <div>
          <label class="font-bold block mb-1">Maksimal Jam Pelajaran / Hari</label>
          <input id="mPeriods" type="number" min="4" max="14" value="${state.config.periodsPerDay}" class="w-full border rounded p-1.5">
        </div>
      </div>

      <div class="bg-slate-100 border border-slate-300 rounded p-3 max-w-xl mt-2">
        <div class="font-bold text-slate-800 mb-2">Batas Jam Pelajaran Per Hari (Contoh: Jumat sampai jam ke-6):</div>
        <div class="grid grid-cols-6 gap-2 text-center">
          ${allPossibleDays.map(day => {
            const active = state.config.days.includes(day);
            const val = state.config.dayMaxPeriods?.[day] ?? (day === 'Jumat' ? 6 : state.config.periodsPerDay);
            return `
              <div class="p-2 rounded border ${active ? 'bg-white border-slate-300' : 'bg-slate-200 border-slate-300 opacity-50'}">
                <div class="font-bold text-xs mb-1">${day}</div>
                <input type="number" min="1" max="14" data-daymax="${day}" value="${val}" ${!active ? 'disabled' : ''}
                  class="day-max-input w-12 text-center border rounded py-1 font-bold text-blue-700">
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="flex gap-2 pt-3">
        <button onclick="saveSchoolSettings()" class="bg-blue-600 text-white px-4 py-1.5 rounded font-bold">Simpan Pengaturan Sekolah</button>
        <button onclick="resetAllSchoolData()" class="bg-rose-600 text-white px-3 py-1.5 rounded font-bold hover:bg-rose-700">Reset Total Semua Data</button>
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
        <input id="newTeacherName" placeholder="Nama Lengkap Guru & Gelar" class="flex-1 border rounded px-2 py-1 bg-white">
        <input id="newTeacherCode" placeholder="Kode (G01)" class="w-28 border rounded px-2 py-1 bg-white">
        <button onclick="addMasterTeacher()" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah Guru</button>
      </div>
      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200"><tr><th class="border p-1.5 text-left">Nama Guru & Gelar</th><th class="border p-1.5 w-28">Kode</th><th class="border p-1.5 w-20">Aksi</th></tr></thead>
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
      <div class="bg-blue-50 border border-blue-200 rounded p-3 space-y-2">
        <div class="font-bold text-blue-900">Input Pembagian Jam Mengajar (Isi total jam per minggu di masing-masing kelas):</div>
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

window.onChangeDaysPreset = () => {
  const count = document.getElementById('mSchoolDaysCount').value;
  mutate(d => {
    d.config.days = count === '6'
      ? ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
      : ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
  });
  refreshDayFilter();
  renderMasterTabContent();
};

window.saveSchoolSettings = () => {
  const daysCount = document.getElementById('mSchoolDaysCount').value;
  const maxPeriods = parseInt(document.getElementById('mPeriods').value, 10) || 9;
  const dayInputs = document.querySelectorAll('.day-max-input');

  mutate(d => {
    d.config.schoolName = document.getElementById('mSchoolName').value;
    d.config.academicYear = document.getElementById('mAcademicYear').value;
    d.config.periodsPerDay = maxPeriods;
    d.config.days = daysCount === '6'
      ? ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
      : ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];

    if (!d.config.dayMaxPeriods) d.config.dayMaxPeriods = {};
    dayInputs.forEach(inp => {
      const dayName = inp.dataset.daymax;
      d.config.dayMaxPeriods[dayName] = Math.min(maxPeriods, parseInt(inp.value, 10) || maxPeriods);
    });
  });

  refreshDayFilter();
  alert('✅ Pengaturan hari & batas jam per hari berhasil disimpan.');
};

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

window.resetAllSchoolData = () => {
  if (!confirm('Hapus SEMUA data Guru, Mapel, Kelas, dan Kartu agar mulai dari nol?')) return;
  mutate(d => {
    d.teachers = [];
    d.subjects = [];
    d.classes = [];
    d.rooms = [];
    d.contracts = [];
    d.cards = [];
  });
  renderMasterTabContent();
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
  if (!name) return;
  mutate(d => d.teachers.push({ id: 't' + Date.now(), name, code: code || generateTeacherCode(name, d.teachers.length + 1), timeOff: {} }));
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
// 5. UPLOAD EXCEL (.XLSX/.XLS), CSV & COPY-PASTE TAHAN GELAR KOMA
// ============================================================================
window.openUploadModal = () => document.getElementById('modalUpload').classList.remove('hidden');
window.closeUploadModal = () => document.getElementById('modalUpload').classList.add('hidden');

window.downloadCsvTemplate = () => {
  if (window.XLSX) {
    const wsData = [
      ['Guru', 'Kode', 'Mapel', 'X1', 'X2', 'X3', 'X4', 'XI1', 'XI2'],
      ['Drs. Ahmad Fauzi, M.Si', 'AFZ', 'Matematika', 4, 4, 4, 0, 0, 0],
      ['Dra. Hi. Nurhasanah, M.Pd', 'NUR', 'Bahasa Indonesia', 4, 4, 0, 0, 4, 4],
      ['Budi Santoso, S.Pd., M.Si', 'BDS', 'Fisika', 0, 0, 0, 3, 3, 3]
    ];
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.aoa_to_sheet(wsData);
    window.XLSX.utils.book_append_sheet(wb, ws, 'PembagianJam');
    window.XLSX.writeFile(wb, 'template_pembagian_jam_sekolah.xlsx');
    return;
  }
  const csv = [
    'Guru;Kode;Mapel;X1;X2;X3;X4;XI1;XI2',
    '"Drs. Ahmad Fauzi, M.Si";AFZ;Matematika;4;4;4;0;0;0',
    '"Dra. Hi. Nurhasanah, M.Pd";NUR;Bahasa Indonesia;4;4;0;0;4;4'
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template_pembagian_jam_matriks.csv';
  a.click();
};

window.processUploadedFile = () => {
  const file = document.getElementById('uploadFileInput').files[0];
  if (!file) return alert('Pilih file Excel (.xlsx/.xls), CSV, atau JSON terlebih dahulu.');
  const nameLower = file.name.toLowerCase();

  // A. BACA LANGSUNG FILE EXCEL ASLI (.XLSX / .XLS) — GELAR KOMA DIJAMIN UTUH!
  if (nameLower.endsWith('.xlsx') || nameLower.endsWith('.xls')) {
    if (!window.XLSX) {
      return alert('Library Excel belum termuat. Silakan muat ulang halaman (Ctrl+Shift+R) atau gunakan Copy-Paste dari Excel.');
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const workbook = window.XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' })
        .map(r => r.map(cell => String(cell ?? '').replace(/\s+/g, ' ').trim()))
        .filter(r => r.some(c => c !== ''));
      importMatrixRows(rows);
    };
    reader.readAsArrayBuffer(file);
    return;
  }

  // B. BACA FILE JSON ATAU CSV
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    if (nameLower.endsWith('.json')) {
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
      const rows = parseFullTableText(text);
      importMatrixRows(rows);
    }
  };
  reader.readAsText(file);
};

window.processPastedExcel = () => {
  const raw = document.getElementById('pasteExcelArea').value.trim();
  if (!raw) return alert('Tempel tabel pembagian jam dari Excel terlebih dahulu.');
  const rows = parseFullTableText(raw);
  importMatrixRows(rows);
};

function importMatrixRows(rows) {
  if (!rows || rows.length < 2) {
    return alert('Minimal harus ada 1 baris judul kelas dan 1 baris data guru.');
  }

  // Cari baris header (yang memuat kata Guru / Nama / Mapel)
  let headerRowIdx = rows.findIndex(r =>
    r.some(c => /^(guru|nama\s*guru|pengajar)$/i.test(c))
  );
  if (headerRowIdx === -1) headerRowIdx = 0;

  const headers = rows[headerRowIdx];
  // Auto-deteksi apakah formatnya 3 kolom awal (Guru | Kode | Mapel | Kelas...) atau 2 kolom awal (Guru | Mapel | Kelas...)
  const col2Lower = (headers[1] || '').toLowerCase();
  const hasExplicitCodeCol = col2Lower.includes('kode') || col2Lower.includes('inisial') || col2Lower === '';
  const subjColIdx = hasExplicitCodeCol ? 2 : 1;
  const classStartIdx = subjColIdx + 1;

  const classNames = headers.slice(classStartIdx).filter(Boolean);
  if (classNames.length === 0) {
    return alert('Judul kolom kelas tidak ditemukan. Pastikan baris pertama berisi: Guru | Kode | Mapel | X1 | X2 | ...');
  }

  const replaceAll = confirm(
    `Terbaca ${classNames.length} kelas (${classNames.slice(0, 6).join(', ')}...) dan ${rows.length - headerRowIdx - 1} baris data.\n\n` +
    `Klik OK untuk MENGGANTI BERSIH seluruh kelas, mapel, guru & jadwal lama dengan data baru ini.\n` +
    `Klik Batal untuk menambahkan ke data yang sudah ada.`
  );

  let cardCount = 0;

  mutate(d => {
    if (replaceAll) {
      d.teachers = [];
      d.subjects = [];
      d.classes = [];
      d.contracts = [];
      d.cards = [];
    }

    const classObjs = classNames.map((cName, idx) => {
      let cls = d.classes.find(x => x.name.toLowerCase() === cName.toLowerCase());
      if (!cls) {
        cls = { id: `c${Date.now()}_${idx}`, name: cName, timeOff: {} };
        d.classes.push(cls);
      }
      return cls;
    });

    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const cols = rows[r];
      const tName = (cols[0] || '').trim();
      const rawCode = hasExplicitCodeCol ? (cols[1] || '').trim() : '';
      const sName = (cols[subjColIdx] || '').trim();

      if (!tName || !sName) continue;
      if (/^(jumlah|total)$/i.test(tName)) continue;

      let teacher = d.teachers.find(x => x.name.toLowerCase() === tName.toLowerCase());
      if (!teacher) {
        teacher = {
          id: `t${Date.now()}_${r}`,
          name: tName,
          code: rawCode || generateTeacherCode(tName, d.teachers.length + 1),
          timeOff: {}
        };
        d.teachers.push(teacher);
      }

      let subject = d.subjects.find(x => x.name.toLowerCase() === sName.toLowerCase());
      if (!subject) {
        subject = {
          id: `s${Date.now()}_${r}`,
          name: sName,
          code: sName.length <= 6 ? sName.toUpperCase() : sName.slice(0, 5).toUpperCase(),
          category: 'EXACT'
        };
        d.subjects.push(subject);
      }

      classObjs.forEach((cls, cIdx) => {
        const hours = parseInt(cols[classStartIdx + cIdx], 10) || 0;
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
  alert(`✅ Berhasil mengimpor!\n• ${state.classes.length} Kelas\n• ${state.subjects.length} Mata Pelajaran\n• ${state.teachers.length} Guru (gelar utuh)\n• ${cardCount} Kartu Pelajaran siap susun.`);
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

  const workerState = JSON.parse(JSON.stringify(state));
  workerState.days = workerState.config.days.map((name, idx) => ({ id: `d${idx}`, name }));
  workerState.classes.forEach(cls => {
    if (!cls.timeOff) cls.timeOff = {};
    workerState.config.days.forEach((dayName, dIdx) => {
      const maxP = getMaxPeriodForDay(workerState, dIdx);
      for (let p = maxP; p < workerState.config.periodsPerDay; p++) {
        cls.timeOff[`${dIdx}-${p}`] = true;
      }
    });
  });

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
  solverWorker.postMessage({ type: 'START', state: workerState, options: { mode, respectLocks: true, maxIterations: 25000 } });
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
