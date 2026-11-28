// ============================================================================
// aSc Web TimeTables - app.js (BAGIAN 1/2)
// ============================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

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
// UTIL: ATURAN JAM
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
    if (state.config.globalBlocked?.[key]) {
      return { valid: false, reason: `Jam diblokir sekolah (${state.config.globalBlocked[key]})` };
    }
    if (cls?.timeOff?.[key]) return { valid: false, reason: `Kelas ${cls.name} libur pada jam ini` };
    if (teacher?.timeOff?.[key]) return { valid: false, reason: `${teacher.name} minta libur pada jam ini` };

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

// ============================================================================
// UTIL: SNAPSHOT & SPLIT JAM
// ============================================================================
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
// UTIL: PARSER TABEL (CSV/TSV/semicolon)
// ============================================================================
function parseFullTableText(rawText) {
  const clean = rawText.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
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
      if (inQ && next === '"') { cell += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === sep && !inQ) {
      row.push(cell.replace(/\s+/g, ' ').trim()); cell = '';
    } else if ((ch === '\r' || ch === '\n') && !inQ) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell.replace(/\s+/g, ' ').trim());
      if (row.some(c => c !== '')) rows.push(row);
      row = []; cell = '';
    } else { cell += ch; }
  }
  row.push(cell.replace(/\s+/g, ' ').trim());
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

function detectImportFormat(headerRow) {
  const norm = headerRow.map(c => String(c || '').toLowerCase().trim());
  const hasKelas = norm.some(c => /^(kelas|class)$/.test(c));
  const hasMapel = norm.some(c => /^(mapel|mata\s*pelajaran|subject)$/.test(c));
  const hasJam = norm.some(c => /^(jam|jamperpertemuan|durasi|pertemuan|sks|jtm)$/.test(c));
  if (hasKelas && hasMapel && hasJam) return 'LONG';
  const hasGuru = norm.some(c => /^(guru|nama\s*guru|pengajar|teacher)$/.test(c));
  if (hasGuru) return 'MATRIX';
  return 'UNKNOWN';
}

function findColIndex(headerRow, aliases) {
  const norm = headerRow.map(c => String(c || '').toLowerCase().replace(/\s+/g, ' ').trim());
  for (let i = 0; i < norm.length; i++) {
    if (aliases.some(a => norm[i] === a || norm[i].includes(a))) return i;
  }
  return -1;
}

function generateTeacherCode(fullName, fallbackIndex) {
  const tanpaGelarBelakang = fullName.split(',')[0].trim();
  const bersih = tanpaGelarBelakang.replace(/^(Drs\.|Dra\.|Dr\.|Ir\.|H\.|Hj\.|Prof\.|S\.Pd\.?|M\.Pd\.?|M\.Si\.?)\s+/gi, '').trim();
  const words = bersih.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0].slice(0, 2) + words[1].slice(0, 2)).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return `G${String(fallbackIndex).padStart(2, '0')}`;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/matematika|fisika|kimia|biologi|ipa|informatika|komputer|tik|statistika/.test(n)) return 'EXACT';
  if (/sejarah|geografi|ekonomi|sosiologi|ips|ppkn|pkn|kewarganegaraan/.test(n)) return 'SOCIAL';
  if (/indonesia|inggris|arab|jepang|mandarin|bahasa|sastra/.test(n)) return 'LANG';
  if (/seni|pjok|olahraga|penjas|prakarya|budaya|musik|tari|rupa/.test(n)) return 'ART';
  return 'EXACT';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
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
    periodsPerDay: 10,
    dayMaxPeriods: { Senin: 10, Selasa: 10, Rabu: 10, Kamis: 10, Jumat: 6, Sabtu: 8 },
    globalBlocked: { '0-0': 'Upacara' },
    workerUrl: 'https://pembuat-jadwal.yhanedy.workers.dev'
  },
  subjects: [], teachers: [],
  classes: [{ id: 'c1', name: 'X1', timeOff: {} }, { id: 'c2', name: 'X2', timeOff: {} }],
  rooms: [], contracts: [], cards: []
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
let editingTeacherTimeOffId = null;
let solverWorker = null;

// ============================================================================
// 1. LOGIN GMAIL
// ============================================================================
window.loginWithGoogle = async () => {
  const errEl = document.getElementById('loginErrorMsg');
  errEl.classList.add('hidden');
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(auth, provider);
    } else {
      errEl.textContent = 'Gagal masuk: ' + err.message;
      errEl.classList.remove('hidden');
    }
  }
};

window.logoutGoogle = async () => { await signOut(auth); location.reload(); };
getRedirectResult(auth).catch(() => {});

function normalizeStateConfig(st) {
  if (!st.config.dayMaxPeriods) {
    st.config.dayMaxPeriods = {
      Senin: st.config.periodsPerDay || 10, Selasa: st.config.periodsPerDay || 10,
      Rabu: st.config.periodsPerDay || 10, Kamis: st.config.periodsPerDay || 10,
      Jumat: 6, Sabtu: Math.min(8, st.config.periodsPerDay || 8)
    };
  }
  if (!st.config.globalBlocked) st.config.globalBlocked = {};
  const validTeacherIds = new Set(st.teachers.map(t => t.id));
  const validSubjectIds = new Set(st.subjects.map(s => s.id));
  const validClassIds = new Set(st.classes.map(c => c.id));
  st.contracts = st.contracts.filter(k =>
    validTeacherIds.has(k.teacherId) && validSubjectIds.has(k.subjectId) && validClassIds.has(k.classId));
  const validContractIds = new Set(st.contracts.map(k => k.id));
  st.cards = st.cards.filter(c => validContractIds.has(c.contractId));
}

onAuthStateChanged(auth, async (user) => {
  if (window.lucide) window.lucide.createIcons();
  if (!user) { document.getElementById('loginGateModal').classList.remove('hidden'); return; }

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
      window.state = state;
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
    state = saved.state; window.state = state;
    serverVersion = saved.serverVersion || 0;
  } else {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    state.config.schoolId = userSchoolId;
    window.state = state;
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
  window.state = state;
  document.getElementById('btnUndo').disabled = undoStack.length === 0;
  refreshDayFilter(); renderAll();
  saveLocalSnapshot(state.config.schoolId, state, serverVersion);
};

function renderAll() {
  if (!state) return;
  document.getElementById('schoolTitleTop').textContent = state.config.schoolName;
  renderGrid(); renderBottomDeck(); updateConflictRibbon();
}

// ============================================================================
// 2. GRID MATRIKS
// ============================================================================
window.renderGrid = () => {
  if (!state) return;
  const mode = document.getElementById('viewModeSelect').value;
  const dayFilter = document.getElementById('dayFilterSelect').value;
  const thead = document.getElementById('matrixHead');
  const tbody = document.getElementById('matrixBody');

  const days = state.config.days.map((name, index) => ({ name, index }))
    .filter(d => dayFilter === 'ALL' || String(d.index) === dayFilter);
  const periods = state.config.periodsPerDay;

  let h1 = `<tr><th rowspan="2" class="bg-slate-800 text-white border border-slate-500 px-3 py-1.5 text-left min-w-[110px] sticky left-0 z-30">${
    mode === 'CLASS' ? 'Kelas' : mode === 'TEACHER' ? 'Guru' : 'Ruangan'}</th>`;
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
        const globalBlockLabel = state.config.globalBlocked?.[slotKey];
        const isRowTimeOff = row.timeOff?.[slotKey];

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
          tr += `<td data-day="${d.index}" data-period="${p}" title="Hari ${d.name} hanya sampai jam ke-${maxP}"
            class="border border-slate-300 h-12 p-0.5 asc-cell-timeoff text-[10px]">Libur</td>`;
        } else if (globalBlockLabel) {
          tr += `<td data-day="${d.index}" data-period="${p}" title="Jam diblokir sekolah: ${globalBlockLabel}"
            class="border border-slate-300 h-12 p-0.5 bg-amber-100 text-amber-900 font-bold text-center text-[10px] select-none">
            ${globalBlockLabel}</td>`;
        } else if (isRowTimeOff) {
          tr += `<td data-day="${d.index}" data-period="${p}" title="${row.name} tidak mengajar / libur pada jam ini"
            class="border border-slate-300 h-12 p-0.5 asc-cell-timeoff text-[10px]">X (Libur)</td>`;
        } else {
          tr += `<td data-day="${d.index}" data-period="${p}" data-rowid="${row.id}"
            onclick="onEmptyCellClick(event, ${d.index}, ${p}, '${row.id}')"
            class="border border-slate-300 h-12 p-0.5 asc-cell-empty cursor-pointer"></td>`;
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

// ============================================================================
// DRAG & DROP
// ============================================================================
const matrixTable = document.getElementById('matrixTable');

document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-cardid]');
  if (!el || !state) return;
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
// 3. DOCK KARTU BAWAH & POPOVER
// ============================================================================
window.renderBottomDeck = () => {
  if (!state) return;
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
  if (!state) return;
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
      <button onclick="removeCardFromGrid('${cardId}')" class="py-1.5 px-2 rounded bg-rose-600 text-white font-semibold">Keluarkan</button>
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
// 4. MODAL EDIT DATA MASTER
// ============================================================================
window.openMasterModal = (tab = 'CONTRACTS') => {
  editingTeacherTimeOffId = null;
  document.getElementById('modalMaster').classList.remove('hidden');
  switchMasterTab(tab);
};

window.closeMasterModal = () => {
  editingTeacherTimeOffId = null;
  document.getElementById('modalMaster').classList.add('hidden');
  refreshDayFilter();
  renderAll();
};

window.switchMasterTab = (tab) => {
  activeMasterTab = tab;
  editingTeacherTimeOffId = null;
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
    const periods = state.config.periodsPerDay;

    box.innerHTML = `
      <div class="grid grid-cols-2 gap-3 max-w-2xl">
        <div><label class="font-bold block mb-1">Nama Sekolah</label>
          <input id="mSchoolName" value="${state.config.schoolName}" class="w-full border rounded p-1.5"></div>
        <div><label class="font-bold block mb-1">Tahun Ajaran</label>
          <input id="mAcademicYear" value="${state.config.academicYear}" class="w-full border rounded p-1.5"></div>
        <div><label class="font-bold block mb-1">Sistem Hari Sekolah</label>
          <select id="mSchoolDaysCount" onchange="onChangeDaysPreset()" class="w-full border rounded p-1.5 bg-white font-semibold">
            <option value="5" ${!hasSabtu ? 'selected' : ''}>5 Hari Kerja (Senin – Jumat)</option>
            <option value="6" ${hasSabtu ? 'selected' : ''}>6 Hari Kerja (Senin – Sabtu)</option>
          </select></div>
        <div><label class="font-bold block mb-1">Maksimal Jam Pelajaran / Hari</label>
          <input id="mPeriods" type="number" min="4" max="14" value="${periods}" class="w-full border rounded p-1.5"></div>
      </div>

      <div class="bg-slate-100 border border-slate-300 rounded p-3 max-w-2xl mt-2">
        <div class="font-bold text-slate-800 mb-2">Batas Jam Pelajaran Per Hari (Contoh: Jumat sampai jam ke-6):</div>
        <div class="grid grid-cols-6 gap-2 text-center">
          ${allPossibleDays.map(day => {
            const active = state.config.days.includes(day);
            const val = state.config.dayMaxPeriods?.[day] ?? (day === 'Jumat' ? 6 : periods);
            return `<div class="p-2 rounded border ${active ? 'bg-white border-slate-300' : 'bg-slate-200 border-slate-300 opacity-50'}">
                <div class="font-bold text-xs mb-1">${day}</div>
                <input type="number" min="1" max="14" data-daymax="${day}" value="${val}" ${!active ? 'disabled' : ''}
                  class="day-max-input w-12 text-center border rounded py-1 font-bold text-blue-700">
              </div>`;
          }).join('')}
        </div>
      </div>

      <div class="bg-amber-50 border border-amber-300 rounded p-3 max-w-2xl mt-2">
        <div class="font-bold text-amber-900 mb-1">Blokir Jam Seluruh Sekolah (Upacara Bendera / Pembinaan / Kultum):</div>
        <p class="text-[11px] text-amber-800 mb-2">Klik kotak di bawah untuk memblokir jam bagi seluruh kelas & guru (misal: <b>Senin Jam ke-1 = Upacara</b>).</p>
        <div class="overflow-x-auto">
          <table class="border-collapse border border-slate-400 bg-white text-center text-xs">
            <thead><tr class="bg-slate-200">
              <th class="border border-slate-400 px-2 py-1 text-left">Hari</th>
              ${Array.from({ length: periods }, (_, p) => `<th class="border border-slate-400 px-2 py-1 w-12">Jam ${p + 1}</th>`).join('')}
            </tr></thead>
            <tbody>
              ${state.config.days.map((dayName, dIdx) => {
                const maxP = getMaxPeriodForDay(state, dIdx);
                return `<tr>
                  <td class="border border-slate-400 px-2 py-1 font-bold text-left bg-slate-100">${dayName}</td>
                  ${Array.from({ length: periods }, (_, p) => {
                    if (p >= maxP) return `<td class="border border-slate-400 bg-slate-200 text-slate-400">Libur</td>`;
                    const key = `${dIdx}-${p}`;
                    const label = state.config.globalBlocked?.[key];
                    return `<td onclick="toggleGlobalBlock(${dIdx}, ${p})"
                      class="border border-slate-400 py-1.5 cursor-pointer font-bold select-none ${
                        label ? 'bg-amber-400 text-slate-950' : 'hover:bg-blue-50 text-emerald-700'}">
                      ${label ? label : '✓'}</td>`;
                  }).join('')}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
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
          ${state.subjects.map(s => `<tr>
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
          ${state[key].map(item => `<tr>
            <td class="border p-1.5"><input value="${item.name}" onchange="editEntityName('${key}','${item.id}',this.value)" class="w-full px-1"></td>
            <td class="border p-1.5 text-center"><button onclick="deleteEntity('${key}','${item.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  } else if (activeMasterTab === 'TEACHERS') {
    const editingTeacher = editingTeacherTimeOffId ? state.teachers.find(t => t.id === editingTeacherTimeOffId) : null;
    const periods = state.config.periodsPerDay;

    box.innerHTML = `
      ${editingTeacher ? `
        <div class="bg-rose-50 border-2 border-rose-400 rounded p-3 mb-3">
          <div class="flex justify-between items-center mb-2">
            <div>
              <span class="font-bold text-rose-900 text-sm">Atur Jam Libur: ${editingTeacher.name} (${editingTeacher.code})</span>
              <p class="text-[11px] text-rose-800">Klik sel untuk tandai <b>X (Libur)</b>, klik <b>Nama Hari</b> untuk libur 1 hari, atau klik <b>Nomor Jam</b> untuk blokir jam tertentu di semua hari.</p>
            </div>
            <button onclick="closeTeacherTimeOff()" class="bg-slate-800 text-white px-3 py-1 rounded font-bold">Selesai</button>
          </div>
          <div class="overflow-x-auto">
            <table class="border-collapse border border-slate-400 bg-white text-center text-xs w-full">
              <thead><tr class="bg-slate-200">
                <th class="border border-slate-400 px-2 py-1 text-left">Hari (Klik untuk 1 hari)</th>
                ${Array.from({ length: periods }, (_, p) => `<th onclick="toggleTeacherPeriodAllDays('${editingTeacher.id}', ${p})"
                  title="Klik untuk memblokir Jam ke-${p + 1} di semua hari"
                  class="border border-slate-400 px-2 py-1 cursor-pointer hover:bg-rose-200">Jam ${p + 1}</th>`).join('')}
              </tr></thead>
              <tbody>
                ${state.config.days.map((dayName, dIdx) => {
                  const maxP = getMaxPeriodForDay(state, dIdx);
                  return `<tr>
                    <td onclick="toggleTeacherFullDay('${editingTeacher.id}', ${dIdx})"
                      title="Klik untuk meliburkan hari ${dayName} penuh"
                      class="border border-slate-400 px-2 py-1.5 font-bold text-left bg-slate-100 cursor-pointer hover:bg-rose-200">${dayName}</td>
                    ${Array.from({ length: periods }, (_, p) => {
                      if (p >= maxP) return `<td class="border border-slate-400 bg-slate-200 text-slate-400">-</td>`;
                      const key = `${dIdx}-${p}`;
                      const isOff = editingTeacher.timeOff?.[key];
                      return `<td onclick="toggleTeacherSlot('${editingTeacher.id}', ${dIdx}, ${p})"
                        class="border border-slate-400 py-1.5 cursor-pointer font-bold select-none ${
                          isOff ? 'bg-rose-600 text-white' : 'hover:bg-rose-100 text-emerald-700'}">${isOff ? 'X' : '✓'}</td>`;
                    }).join('')}
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      <div class="flex gap-2 bg-slate-100 p-2 rounded border max-w-xl">
        <input id="newTeacherName" placeholder="Nama Lengkap Guru & Gelar" class="flex-1 border rounded px-2 py-1 bg-white">
        <input id="newTeacherCode" placeholder="Kode (G01)" class="w-28 border rounded px-2 py-1 bg-white">
        <button onclick="addMasterTeacher()" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">+ Tambah Guru</button>
      </div>
      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200"><tr>
          <th class="border p-1.5 text-left">Nama Guru & Gelar</th><th class="border p-1.5 w-24">Kode</th>
          <th class="border p-1.5 w-44">Permintaan Jam Libur</th><th class="border p-1.5 w-20">Aksi</th>
        </tr></thead>
        <tbody>
          ${state.teachers.map(t => {
            const offCount = Object.keys(t.timeOff || {}).filter(k => t.timeOff[k]).length;
            return `<tr>
              <td class="border p-1.5"><input value="${t.name}" onchange="editEntityName('teachers','${t.id}',this.value)" class="w-full px-1"></td>
              <td class="border p-1.5 text-center font-bold">${t.code}</td>
              <td class="border p-1.5 text-center">
                <button onclick="openTeacherTimeOff('${t.id}')"
                  class="px-2.5 py-1 rounded font-semibold border ${offCount > 0 ? 'bg-rose-100 border-rose-400 text-rose-800' : 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200'}">
                  ${offCount > 0 ? `🚫 ${offCount} Jam Libur` : 'Atur Jam Libur'}</button>
              </td>
              <td class="border p-1.5 text-center"><button onclick="deleteEntity('teachers','${t.id}')" class="text-rose-600 font-bold hover:underline">Hapus</button></td>
            </tr>`;
          }).join('')}
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
          <button onclick="saveMatrixDistribution()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded font-bold ml-auto">+ Simpan Pembagian Jam</button>
        </div>
        <div class="overflow-x-auto pt-1">
          <table class="border-collapse border border-slate-300 bg-white">
            <thead><tr class="bg-slate-200">
              ${state.classes.map(c => `<th class="border border-slate-300 px-3 py-1 text-center min-w-[56px]">${c.name}</th>`).join('')}
            </tr></thead>
            <tbody><tr>
              ${state.classes.map(c => `<td class="border border-slate-300 p-1 text-center">
                <input type="number" min="0" max="12" placeholder="0" data-classid="${c.id}"
                  class="matrix-hour-input w-12 text-center border border-slate-300 rounded py-1 font-bold text-blue-700">
              </td>`).join('')}
            </tr></tbody>
          </table>
        </div>
        <p class="text-[11px] text-slate-600">*Otomatis dipecah menjadi kartu pertemuan (contoh: <b>4 jam</b> jadi <b>2+2</b>, <b>3 jam</b> jadi <b>2+1</b>).</p>
      </div>

      <div class="flex justify-between items-center pt-2">
        <span class="font-bold text-slate-700">Daftar Kartu Pelajaran (${state.cards.length} kartu):</span>
        <button onclick="resetAllContracts()" class="text-rose-600 hover:underline font-semibold">Hapus Semua Daftar</button>
      </div>

      <table class="w-full border-collapse border border-slate-300">
        <thead class="bg-slate-200"><tr>
          <th class="border p-1.5 text-left">Guru</th><th class="border p-1.5 text-left">Mapel</th>
          <th class="border p-1.5">Kelas</th><th class="border p-1.5">Pecahan Jam</th><th class="border p-1.5 w-20">Aksi</th>
        </tr></thead>
        <tbody>
          ${state.contracts.map(k => {
            const t = state.teachers.find(x => x.id === k.teacherId)?.name || '-';
            const s = state.subjects.find(x => x.id === k.subjectId)?.name || '-';
            const c = state.classes.find(x => x.id === k.classId)?.name || '-';
            return `<tr>
              <td class="border p-1.5">${t}</td><td class="border p-1.5">${s}</td>
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

// ---- Aksi Data Master ----
window.toggleGlobalBlock = (dayIndex, period) => {
  const key = `${dayIndex}-${period}`;
  mutate(d => {
    if (!d.config.globalBlocked) d.config.globalBlocked = {};
    if (d.config.globalBlocked[key]) delete d.config.globalBlocked[key];
    else d.config.globalBlocked[key] = dayIndex === 0 && period === 0 ? 'Upacara' : 'Blokir';
  });
  renderMasterTabContent();
};

window.openTeacherTimeOff = (teacherId) => { editingTeacherTimeOffId = teacherId; renderMasterTabContent(); };
window.closeTeacherTimeOff = () => { editingTeacherTimeOffId = null; renderMasterTabContent(); };

window.toggleTeacherSlot = (teacherId, dayIndex, period) => {
  const key = `${dayIndex}-${period}`;
  mutate(d => {
    const t = d.teachers.find(x => x.id === teacherId);
    if (!t) return;
    if (!t.timeOff) t.timeOff = {};
    if (t.timeOff[key]) delete t.timeOff[key]; else t.timeOff[key] = true;
  });
  renderMasterTabContent();
};

window.toggleTeacherFullDay = (teacherId, dayIndex) => {
  mutate(d => {
    const t = d.teachers.find(x => x.id === teacherId);
    if (!t) return;
    if (!t.timeOff) t.timeOff = {};
    const maxP = getMaxPeriodForDay(d, dayIndex);
    let anyOpen = false;
    for (let p = 0; p < maxP; p++) if (!t.timeOff[`${dayIndex}-${p}`]) anyOpen = true;
    for (let p = 0; p < maxP; p++) {
      if (anyOpen) t.timeOff[`${dayIndex}-${p}`] = true;
      else delete t.timeOff[`${dayIndex}-${p}`];
    }
  });
  renderMasterTabContent();
};

window.toggleTeacherPeriodAllDays = (teacherId, period) => {
  mutate(d => {
    const t = d.teachers.find(x => x.id === teacherId);
    if (!t) return;
    if (!t.timeOff) t.timeOff = {};
    let anyOpen = false;
    d.config.days.forEach((_, dIdx) => {
      if (period < getMaxPeriodForDay(d, dIdx) && !t.timeOff[`${dIdx}-${period}`]) anyOpen = true;
    });
    d.config.days.forEach((_, dIdx) => {
      if (period < getMaxPeriodForDay(d, dIdx)) {
        if (anyOpen) t.timeOff[`${dIdx}-${period}`] = true;
        else delete t.timeOff[`${dIdx}-${period}`];
      }
    });
  });
  renderMasterTabContent();
};

window.onChangeDaysPreset = () => {
  const count = document.getElementById('mSchoolDaysCount').value;
  mutate(d => {
    d.config.days = count === '6'
      ? ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
      : ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
  });
  refreshDayFilter(); renderMasterTabContent();
};

window.saveSchoolSettings = () => {
  const daysCount = document.getElementById('mSchoolDaysCount').value;
  const maxPeriods = parseInt(document.getElementById('mPeriods').value, 10) || 10;
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
  alert('✅ Pengaturan hari, batas jam per hari, & blokir upacara berhasil disimpan.');
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
        const k = { id: `k${Date.now()}_${idx}_${gIdx}`, teacherId, subjectId, classId, roomId: '', sessions: sessCount, duration };
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
  mutate(d => { d.teachers = []; d.subjects = []; d.classes = []; d.rooms = []; d.contracts = []; d.cards = []; });
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
// 5. UPLOAD EXCEL / CSV / JSON & COPY-PASTE
// ============================================================================
window.openUploadModal = () => document.getElementById('modalUpload').classList.remove('hidden');
window.closeUploadModal = () => document.getElementById('modalUpload').classList.add('hidden');

window.downloadCsvTemplate = () => {
  if (window.XLSX) {
    const wb = window.XLSX.utils.book_new();

    const matrixData = [
      ['Guru', 'Kode', 'Mapel', 'Kode Mapel', 'Kategori', 'X1', 'X2', 'X3', 'XI1', 'XI2'],
      ['Drs. Ahmad Fauzi, M.Si', 'AFZ', 'Matematika', 'MTK', 'EXACT', 4, 4, 4, 0, 0],
      ['Dra. Hi. Nurhasanah, M.Pd', 'NUR', 'Bahasa Indonesia', 'IND', 'LANG', 4, 4, 0, 4, 4],
      ['Budi Santoso, S.Pd., M.Si', 'BDS', 'Fisika', 'FIS', 'EXACT', 0, 0, 0, 3, 3]
    ];
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(matrixData), 'Format Matriks');

    const longData = [
      ['Guru', 'Kode Guru', 'Mapel', 'Kode Mapel', 'Kategori', 'Kelas', 'JamPerPertemuan', 'Pertemuan', 'Ruang'],
      ['Drs. Ahmad Fauzi, M.Si', 'AFZ', 'Matematika', 'MTK', 'EXACT', 'X1', 2, 2, ''],
      ['Drs. Ahmad Fauzi, M.Si', 'AFZ', 'Matematika', 'MTK', 'EXACT', 'X2', 2, 2, ''],
      ['Dra. Hi. Nurhasanah, M.Pd', 'NUR', 'Bahasa Indonesia', 'IND', 'LANG', 'X1', 2, 2, '']
    ];
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(longData), 'Format Long');

    window.XLSX.writeFile(wb, 'template_import_jadwal.xlsx');
    return;
  }
  const csv = [
    'Guru;Kode;Mapel;Kode Mapel;Kategori;X1;X2;X3;XI1;XI2',
    '"Drs. Ahmad Fauzi, M.Si";AFZ;Matematika;MTK;EXACT;4;4;4;0;0',
    '"Dra. Hi. Nurhasanah, M.Pd";NUR;Bahasa Indonesia;IND;LANG;4;4;0;4;4'
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template_import_jadwal.csv';
  a.click();
};

window.processUploadedFile = () => {
  const file = document.getElementById('uploadFileInput').files[0];
  if (!file) return alert('Pilih file Excel (.xlsx/.xls), CSV, atau JSON terlebih dahulu.');
  const nameLower = file.name.toLowerCase();

  if (nameLower.endsWith('.xlsx') || nameLower.endsWith('.xls')) {
    if (!window.XLSX) return alert('Library Excel belum termuat. Muat ulang halaman (Ctrl+Shift+R).');
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

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    if (nameLower.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.config && parsed.cards) {
          const keepSchoolId = state.config.schoolId;
          mutate(() => { state = parsed; window.state = state; state.config.schoolId = keepSchoolId; });
          closeUploadModal();
          alert('✅ File backup JSON berhasil dimuat!');
        } else alert('File JSON tidak berisi data jadwal yang valid.');
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
  if (!rows || rows.length < 2) return alert('❌ Minimal 1 baris judul + 1 baris data.');

  let headerRowIdx = rows.findIndex(r =>
    r.some(c => /^(guru|nama\s*guru|pengajar|kelas|class|mapel|mata\s*pelajaran)$/i.test(String(c || '').trim()))
  );
  if (headerRowIdx === -1) headerRowIdx = 0;

  const headerRow = rows[headerRowIdx].map(c => String(c || '').trim());
  const dataRows = rows.slice(headerRowIdx + 1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const format = detectImportFormat(headerRow);

  if (format === 'UNKNOWN') {
    return alert('❌ Format kolom tidak dikenali.\n\nFormat A (MATRIKS): Guru | Kode | Mapel | X1 | X2 | X3 ...\nFormat B (LONG): Guru | Kode | Mapel | Kelas | JamPerPertemuan | Pertemuan | Ruang');
  }

  const newSubjects = new Map();
  const newTeachers = new Map();
  const newClasses = new Set();
  const distribution = [];

  if (format === 'MATRIX') {
    const iGuru = findColIndex(headerRow, ['guru', 'nama guru', 'pengajar', 'teacher']);
    const iKode = findColIndex(headerRow, ['kode', 'kode guru', 'code']);
    const iMapel = findColIndex(headerRow, ['mapel', 'mata pelajaran', 'subject']);
    const iKodeMapel = findColIndex(headerRow, ['kode mapel']);
    const iKategori = findColIndex(headerRow, ['kategori', 'category', 'kelompok']);

    if (iGuru === -1 || iMapel === -1) return alert('❌ Format MATRIKS butuh kolom "Guru" dan "Mapel".');

    const metaCols = new Set([iGuru, iKode, iMapel, iKodeMapel, iKategori].filter(x => x >= 0));
    const classCols = [];
    for (let i = 0; i < headerRow.length; i++) {
      if (!metaCols.has(i) && headerRow[i]) classCols.push({ index: i, name: headerRow[i] });
    }
    if (classCols.length === 0) return alert('❌ Format MATRIKS butuh minimal satu kolom nama kelas (mis: X1, X2).');

    classCols.forEach(cc => newClasses.add(cc.name));

    dataRows.forEach(row => {
      const teacherName = String(row[iGuru] || '').trim();
      const teacherCode = (iKode >= 0 ? String(row[iKode] || '').trim().toUpperCase() : '') || generateTeacherCode(teacherName, newTeachers.size + 1);
      const subjectName = String(row[iMapel] || '').trim();
      if (!teacherName || !subjectName) return;

      const subjectCode = (iKodeMapel >= 0 ? String(row[iKodeMapel] || '').trim().toUpperCase() : '') || subjectName.slice(0, 3).toUpperCase();
      const category = (iKategori >= 0 ? String(row[iKategori] || '').trim().toUpperCase() : '') || guessCategory(subjectName);

      if (!newTeachers.has(teacherCode)) newTeachers.set(teacherCode, { name: teacherName, code: teacherCode });
      if (!newSubjects.has(subjectCode)) newSubjects.set(subjectCode, { name: subjectName, code: subjectCode, category });

      classCols.forEach(cc => {
        const hours = parseInt(String(row[cc.index] || '0').replace(/[^\d-]/g, ''), 10) || 0;
        if (hours > 0) distribution.push({ teacherCode, subjectCode, className: cc.name, hours });
      });
    });

  } else if (format === 'LONG') {
    const iGuru = findColIndex(headerRow, ['guru', 'nama guru', 'pengajar', 'teacher']);
    const iKode = findColIndex(headerRow, ['kode guru', 'kode', 'code']);
    const iMapel = findColIndex(headerRow, ['mapel', 'mata pelajaran', 'subject']);
    const iKodeMapel = findColIndex(headerRow, ['kode mapel']);
    const iKategori = findColIndex(headerRow, ['kategori', 'category']);
    const iKelas = findColIndex(headerRow, ['kelas', 'class']);
    const iJam = findColIndex(headerRow, ['jam per pertemuan', 'jamperpertemuan', 'durasi', 'jam', 'sks']);
    const iPertemuan = findColIndex(headerRow, ['pertemuan', 'sessions', 'jumlah pertemuan']);

    if (iGuru === -1 || iMapel === -1 || iKelas === -1) return alert('❌ Format LONG butuh kolom "Guru", "Mapel", dan "Kelas".');

    dataRows.forEach(row => {
      const teacherName = String(row[iGuru] || '').trim();
      const teacherCode = (iKode >= 0 ? String(row[iKode] || '').trim().toUpperCase() : '') || generateTeacherCode(teacherName, newTeachers.size + 1);
      const subjectName = String(row[iMapel] || '').trim();
      const className = String(row[iKelas] || '').trim();
      if (!teacherName || !subjectName || !className) return;

      const subjectCode = (iKodeMapel >= 0 ? String(row[iKodeMapel] || '').trim().toUpperCase() : '') || subjectName.slice(0, 3).toUpperCase();
      const category = (iKategori >= 0 ? String(row[iKategori] || '').trim().toUpperCase() : '') || guessCategory(subjectName);

      const jamPerPertemuan = parseInt(String(row[iJam] || '2').replace(/[^\d]/g, ''), 10) || 2;
      const jumlahPertemuan = parseInt(String(row[iPertemuan] || '1').replace(/[^\d]/g, ''), 10) || 1;

      newClasses.add(className);
      if (!newTeachers.has(teacherCode)) newTeachers.set(teacherCode, { name: teacherName, code: teacherCode });
      if (!newSubjects.has(subjectCode)) newSubjects.set(subjectCode, { name: subjectName, code: subjectCode, category });

      distribution.push({
        teacherCode, subjectCode, className,
        hours: jamPerPertemuan * jumlahPertemuan,
        fixedDuration: jamPerPertemuan,
        fixedSessions: jumlahPertemuan
      });
    });
  }

  if (distribution.length === 0) return alert('❌ Tidak ada data pembagian jam yang valid untuk diimpor.');

  mutate(d => {
    newSubjects.forEach(s => {
      if (!d.subjects.some(x => x.code.toUpperCase() === s.code)) {
        d.subjects.push({ id: 's' + Date.now() + Math.random().toString(36).slice(2, 6), name: s.name, code: s.code, category: s.category });
      }
    });
    newTeachers.forEach(t => {
      if (!d.teachers.some(x => x.code.toUpperCase() === t.code)) {
        d.teachers.push({ id: 't' + Date.now() + Math.random().toString(36).slice(2, 6), name: t.name, code: t.code, timeOff: {} });
      }
    });
    newClasses.forEach(name => {
      if (!d.classes.some(x => x.name.toLowerCase() === name.toLowerCase())) {
        d.classes.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), name, timeOff: {} });
      }
    });

    distribution.forEach((dist, idx) => {
      const teacher = d.teachers.find(x => x.code.toUpperCase() === dist.teacherCode);
      const subject = d.subjects.find(x => x.code.toUpperCase() === dist.subjectCode);
      const cls = d.classes.find(x => x.name.toLowerCase() === dist.className.toLowerCase());
      if (!teacher || !subject || !cls) return;

      const blocks = dist.fixedDuration && dist.fixedSessions
        ? Array(dist.fixedSessions).fill(dist.fixedDuration)
        : splitHoursToBlocks(dist.hours);

      const grouped = {};
      blocks.forEach(b => { grouped[b] = (grouped[b] || 0) + 1; });

      let gIdx = 0;
      Object.entries(grouped).forEach(([durStr, sessCount]) => {
        const duration = parseInt(durStr, 10);
        const contractId = `k${Date.now()}_${idx}_${gIdx++}`;
        const k = { id: contractId, teacherId: teacher.id, subjectId: subject.id, classId: cls.id, roomId: '', sessions: sessCount, duration };
        d.contracts.push(k);
        for (let i = 0; i < sessCount; i++) {
          d.cards.push({ cardId: `${contractId}_s${i + 1}`, contractId, dayIndex: null, startPeriod: null, isLocked: false });
        }
      });
    });
  });

  closeUploadModal();
  document.getElementById('pasteExcelArea').value = '';
  document.getElementById('uploadFileInput').value = '';

  alert(
    `✅ Import berhasil!\n\nFormat: ${format}\nGuru baru: ${newTeachers.size}\nMapel baru: ${newSubjects.size}\nKelas baru: ${newClasses.size}\nBaris pembagian: ${distribution.length}\n\nCek menu "Pelajaran" untuk melihat kartu yang dihasilkan.`
  );
}

// ============================================================================
// 6. GENERATOR OTOMATIS
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
  const checked = document.querySelector('input[name="genMode"]:checked');
  if (!checked) { alert('Pilih mode generate terlebih dahulu.'); return; }
  const mode = checked.value;
  document.getElementById('genFormArea').classList.add('hidden');
  document.getElementById('genProgressArea').classList.remove('hidden');

  const workerState = JSON.parse(JSON.stringify(state));
  workerState.days = workerState.config.days.map((name, idx) => ({ id: `d${idx}`, name }));

  workerState.classes.forEach(cls => {
    if (!cls.timeOff) cls.timeOff = {};
    workerState.config.days.forEach((dayName, dIdx) => {
      const maxP = getMaxPeriodForDay(workerState, dIdx);
      for (let p = 0; p < workerState.config.periodsPerDay; p++) {
        const key = `${dIdx}-${p}`;
        if (p >= maxP || workerState.config.globalBlocked?.[key]) cls.timeOff[key] = true;
      }
    });
  });

  if (mode === 'ALL') {
    workerState.cards.forEach(c => {
      if (!c.isLocked) { c.dayIndex = null; c.startPeriod = null; }
    });
  }

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
  solverWorker.onerror = (err) => {
    alert('Error solver: ' + err.message + '\n\nPastikan file solver.worker.js tersedia.');
    closeGeneratorModal();
  };
  solverWorker.postMessage({ type: 'START', state: workerState, options: { mode, respectLocks: true, maxIterations: 30000 } });
};

// ============================================================================
// 7. CLOUD SAVE & PUBLISH
// ============================================================================
function updateConflictRibbon() {
  if (!state) return;
  const rep = validateFullSchedule(state);
  const el = document.getElementById('ribbonConflictText');
  if (!el) return;
  el.innerHTML = rep.hardCount === 0
    ? `<span class="text-emerald-700 font-bold">0 Bentrok</span>`
    : `<span class="text-rose-600 font-bold">${rep.hardCount} Bentrok!</span>`;
}

window.checkAndShowConflicts = () => {
  const rep = validateFullSchedule(state);
  if (rep.conflicts.length === 0) alert('✅ Jadwal bersih! Tidak ditemukan bentrok guru maupun kelas.');
  else alert('Temuan Validasi:\n\n' + rep.conflicts.map(c => `• ${c.title}: ${c.detail}`).join('\n'));
};

window.saveDraftToCloud = async () => {
  if (!currentUser) return alert('Silakan login dengan Gmail terlebih dahulu.');
  const url = state.config.workerUrl.replace(/\/$/, '');
  document.getElementById('saveStatus').textContent = '⏳ Menyimpan...';
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/save-draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(serverVersion), 'Authorization': `Bearer ${token}` },
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
  if (!rep.isValid) { alert(`Masih ada ${rep.hardCount} bentrok merah. Perbaiki dulu sebelum Publish ke siswa.`); return; }
  const url = state.config.workerUrl.replace(/\/$/, '');
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${url}/api/admin/${state.config.schoolId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(state)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal publish');
    alert(`✅ Jadwal berhasil dipublikasikan!\n\nLink Siswa:\n${window.location.origin}/siswa.html?school=${state.config.schoolId}`);
  } catch (err) { alert('Gagal publish: ' + err.message); }
};

window.exportBackupJson = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `asc_jadwal_${state.config.schoolId}.json`;
  a.click();
};

// ============================================================================
// 8. ASISTEN AI GEMINI
// ============================================================================
window.toggleAiPanel = function() {
  const panel = document.getElementById('aiAssistantPanel');
  if (!panel) return;
  if (panel.style.display === 'none' || panel.style.display === '') {
    panel.style.display = 'flex';
    const inp = document.getElementById('aiPromptInput');
    if (inp) inp.focus();
  } else panel.style.display = 'none';
};

window.sendAiCommand = async function() {
  const input = document.getElementById('aiPromptInput');
  const log = document.getElementById('aiChatLog');
  const btnSend = document.getElementById('btnSendAi');
  const prompt = input.value.trim();
  if (!prompt) return;

  if (!window.state) {
    log.innerHTML += `<div class="bg-rose-100 text-rose-800 p-2.5 rounded-lg mr-6">⚠️ Data jadwal belum siap. Tunggu login selesai.</div>`;
    log.scrollTop = log.scrollHeight;
    return;
  }

  log.innerHTML += `<div class="bg-slate-200 text-slate-800 p-2.5 rounded-lg ml-6">${escapeHtml(prompt)}</div>`;
  input.value = '';
  log.scrollTop = log.scrollHeight;

  const loadingId = 'loading_' + Date.now();
  log.innerHTML += `<div id="${loadingId}" class="text-slate-500 italic p-2 text-xs">AI sedang memproses...</div>`;
  log.scrollTop = log.scrollHeight;
  btnSend.disabled = true;
  btnSend.classList.add('opacity-50');

  try {
    const workerBase = (window.state?.config?.workerUrl || 'https://pembuat-jadwal.yhanedy.workers.dev').replace(/\/$/, '');

    const context = {
      days: window.state.config.days || [],
      periodsPerDay: window.state.config.periodsPerDay || 10,
      teachers: (window.state.teachers || []).map(t => ({ id: t.id, name: t.name, code: t.code })),
      subjects: (window.state.subjects || []).map(s => ({ id: s.id, name: s.name }))
    };

    const response = await fetch(`${workerBase}/api/ai-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context })
    });

    const data = await response.json();
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    let teksBalasan = data.reply || (data.error ? '⚠️ ' + data.error : 'Tidak ada balasan.');
    log.innerHTML += `<div class="bg-blue-100 text-blue-950 p-2.5 rounded-lg mr-6">${escapeHtml(teksBalasan)}</div>`;

    if (Array.isArray(data.actions) && data.actions.length > 0 && window.mutate) {
      const aksiTerlaksana = [];
      data.actions.forEach(action => {
        try {
          if (action.type === 'SET_GLOBAL_BLOCK' && Array.isArray(action.periodIndexes)) {
            window.mutate(d => {
              if (!d.config.globalBlocked) d.config.globalBlocked = {};
              action.periodIndexes.forEach(p => { d.config.globalBlocked[`${action.dayIndex}-${p}`] = action.label || 'Blokir AI'; });
            });
            aksiTerlaksana.push(`blokir ${action.label || 'jam'} hari ${context.days[action.dayIndex]}`);
          } else if (action.type === 'CLEAR_GLOBAL_BLOCK' && Array.isArray(action.periodIndexes)) {
            window.mutate(d => {
              action.periodIndexes.forEach(p => { delete d.config.globalBlocked?.[`${action.dayIndex}-${p}`]; });
            });
            aksiTerlaksana.push(`hapus blokir hari ${context.days[action.dayIndex]}`);
          } else if (action.type === 'SET_TEACHER_TIMEOFF' && Array.isArray(action.teacherIds) && Array.isArray(action.periodIndexes)) {
            window.mutate(d => {
              action.teacherIds.forEach(tid => {
                const t = d.teachers.find(x => x.id === tid);
                if (!t) return;
                if (!t.timeOff) t.timeOff = {};
                action.periodIndexes.forEach(p => { t.timeOff[`${action.dayIndex}-${p}`] = true; });
              });
            });
            aksiTerlaksana.push(`libur ${action.teacherIds.length} guru`);
          } else if (action.type === 'CLEAR_TEACHER_TIMEOFF' && Array.isArray(action.teacherIds) && Array.isArray(action.periodIndexes)) {
            window.mutate(d => {
              action.teacherIds.forEach(tid => {
                const t = d.teachers.find(x => x.id === tid);
                if (!t?.timeOff) return;
                action.periodIndexes.forEach(p => { delete t.timeOff[`${action.dayIndex}-${p}`]; });
              });
            });
            aksiTerlaksana.push(`hapus libur guru`);
          } else if (action.type === 'SET_DAY_MAX_PERIOD' && action.maxPeriod) {
            window.mutate(d => {
              const dayName = d.config.days[action.dayIndex];
              if (!d.config.dayMaxPeriods) d.config.dayMaxPeriods = {};
              d.config.dayMaxPeriods[dayName] = action.maxPeriod;
            });
            aksiTerlaksana.push(`batasi ${context.days[action.dayIndex]} sampai jam ${action.maxPeriod}`);
          } else if (action.type === 'RUN_GENERATE' && typeof window.startWorkerGeneration === 'function') {
            window.startWorkerGeneration();
            aksiTerlaksana.push('jalankan generator otomatis');
          }
        } catch (e) {
          aksiTerlaksana.push(`gagal: ${action.type} (${e.message})`);
        }
      });
      if (aksiTerlaksana.length > 0) {
        log.innerHTML += `<div class="text-emerald-600 text-[10px] italic p-1 ml-2">✓ ${escapeHtml(aksiTerlaksana.join(', '))}</div>`;
        if (window.renderGrid) window.renderGrid();
      }
    }
  } catch (error) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    log.innerHTML += `<div class="bg-rose-100 text-rose-800 p-2.5 rounded-lg mr-6">⚠️ Koneksi error: ${escapeHtml(error.message)}</div>`;
    console.error('[AI] Error:', error);
  } finally {
    btnSend.disabled = false;
    btnSend.classList.remove('opacity-50');
    log.scrollTop = log.scrollHeight;
  }
};

// ============================================================================
// 9. UTIL AKHIR
// ============================================================================
function refreshDayFilter() {
  if (!state) return;
  const sel = document.getElementById('dayFilterSelect');
  sel.innerHTML = `<option value="ALL">Semua Hari</option>` +
    state.config.days.map((d, i) => `<option value="${i}">${d}</option>`).join('');
}

window.changeZoom = (delta) => {
  zoomLevel = Math.max(70, Math.min(130, zoomLevel + delta));
  document.getElementById('zoomLabel').textContent = `${zoomLevel}%`;
  document.getElementById('matrixTable').style.transform = `scale(${zoomLevel / 100})`;
};
