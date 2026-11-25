// ============================================================================
// STATE & DATA DEFAULT (Dapat disimpan di LocalStorage & Cloud API)
// ============================================================================
const STORAGE_KEY = 'asc_web_timetable_v1';

const defaultState = {
  config: {
    schoolId: 'sman2karanganyar',
    schoolName: 'SMA N 2 Karanganyar',
    academicYear: '2026/2027',
    days: ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],
    periodsPerDay: 8,
    workerUrl: 'pembuat-jadwal.yhanedy.workers.dev' // Isi URL Cloudflare Worker Anda di menu Pengaturan
  },
  subjects: [
    { id: 's1', name: 'Matematika', code: 'MTK' },
    { id: 's2', name: 'Bahasa Indonesia', code: 'IND' },
    { id: 's3', name: 'Bahasa Inggris', code: 'ING' },
    { id: 's4', name: 'Ilmu Pengetahuan Alam', code: 'IPA' },
    { id: 's5', name: 'Pendidikan Jasmani', code: 'PJOK' }
  ],
  teachers: [
    { id: 't1', name: 'Budi Santoso, S.Pd', code: 'BUD', color: '#2563eb', timeOff: {} },
    { id: 't2', name: 'Siti Aminah, M.Pd', code: 'SIT', color: '#059669', timeOff: {} },
    { id: 't3', name: 'Andi Wijaya, S.Si', code: 'AND', color: '#d97706', timeOff: {} },
    { id: 't4', name: 'Rina Marlina, S.Pd', code: 'RIN', color: '#7c3aed', timeOff: {} }
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
    { id: 'r4', name: 'Lab IPA' },
    { id: 'r5', name: 'Lapangan' }
  ],
  contracts: [
    { id: 'k1', teacherId: 't1', subjectId: 's1', classId: 'c1', roomId: 'r1', sessions: 2, duration: 2 },
    { id: 'k2', teacherId: 't1', subjectId: 's1', classId: 'c2', roomId: 'r2', sessions: 2, duration: 2 },
    { id: 'k3', teacherId: 't2', subjectId: 's2', classId: 'c1', roomId: 'r1', sessions: 2, duration: 2 },
    { id: 'k4', teacherId: 't2', subjectId: 's2', classId: 'c3', roomId: 'r3', sessions: 2, duration: 2 },
    { id: 'k5', teacherId: 't3', subjectId: 's4', classId: 'c1', roomId: 'r4', sessions: 2, duration: 2 },
    { id: 'k6', teacherId: 't3', subjectId: 's4', classId: 'c2', roomId: 'r4', sessions: 2, duration: 2 },
    { id: 'k7', teacherId: 't4', subjectId: 's3', classId: 'c2', roomId: 'r2', sessions: 2, duration: 1 },
    { id: 'k8', teacherId: 't4', subjectId: 's3', classId: 'c3', roomId: 'r3', sessions: 2, duration: 2 }
  ],
  // Daftar kartu aktual yang dihasilkan dari contracts
  // { cardId, contractId, dayIndex, startPeriod, isLocked }
  cards: []
};

let appState = loadState();
let draggedCardId = null;

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch (e) { console.error(e); }
  }
  const initial = JSON.parse(JSON.stringify(defaultState));
  initial.cards = buildCardsFromContracts(initial.contracts);
  return initial;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function buildCardsFromContracts(contracts) {
  const result = [];
  contracts.forEach(c => {
    for (let i = 0; i < c.sessions; i++) {
      result.push({
        cardId: `${c.id}_s${i + 1}`,
        contractId: c.id,
        dayIndex: null,
        startPeriod: null,
        isLocked: false
      });
    }
  });
  return result;
}

// ============================================================================
// NAVIGASI TAB & UI HELPERS
// ============================================================================
function switchTab(tabName) {
  ['board', 'master', 'lessons', 'settings'].forEach(t => {
    document.getElementById(`view-${t}`).classList.add('hidden');
    const btn = document.getElementById(`tab-${t}`);
    btn.classList.remove('bg-blue-600', 'text-white');
    btn.classList.add('hover:bg-blue-800');
  });
  document.getElementById(`view-${tabName}`).classList.remove('hidden');
  const activeBtn = document.getElementById(`tab-${tabName}`);
  activeBtn.classList.add('bg-blue-600', 'text-white');
  activeBtn.classList.remove('hover:bg-blue-800');

  if (tabName === 'board') renderScheduleBoard();
  if (tabName === 'master') renderMasterLists();
  if (tabName === 'lessons') renderLessonsTab();
  if (tabName === 'settings') renderSettingsTab();
}

function showAlert(message, type = 'info') {
  const bar = document.getElementById('statusBar');
  const box = document.getElementById('statusAlert');
  bar.classList.remove('hidden');
  const styles = {
    success: 'bg-emerald-50 border-emerald-300 text-emerald-800',
    error: 'bg-rose-50 border-rose-300 text-rose-800',
    info: 'bg-blue-50 border-blue-300 text-blue-800'
  };
  box.className = `p-3 rounded-lg border text-sm flex items-center justify-between ${styles[type] || styles.info}`;
  box.innerHTML = `<span>${message}</span><button onclick="document.getElementById('statusBar').classList.add('hidden')" class="font-bold ml-4">✕</button>`;
}

// ============================================================================
// ALGORITMA GENERATOR JADWAL (CONSTRAINT SATISFACTION + BACKTRACKING)
// ============================================================================
function canPlaceCard(cardsList, targetCard, dayIndex, startPeriod) {
  const contract = appState.contracts.find(c => c.id === targetCard.contractId);
  if (!contract) return false;

  const teacher = appState.teachers.find(t => t.id === contract.teacherId);
  const schoolClass = appState.classes.find(c => c.id === contract.classId);

  // Cek batas akhir jam hari tersebut
  if (startPeriod + contract.duration > appState.config.periodsPerDay) {
    return false;
  }

  for (let offset = 0; offset < contract.duration; offset++) {
    const p = startPeriod + offset;
    const slotKey = `${dayIndex}-${p}`;

    // 1. Cek Time-Off Guru & Kelas
    if (teacher?.timeOff?.[slotKey]) return false;
    if (schoolClass?.timeOff?.[slotKey]) return false;

    // 2. Cek Bentrok dengan kartu lain yang sudah terpasang
    for (const other of cardsList) {
      if (other.cardId === targetCard.cardId) continue;
      if (other.dayIndex !== dayIndex || other.startPeriod === null) continue;

      const otherContract = appState.contracts.find(c => c.id === other.contractId);
      if (!otherContract) continue;

      const otherEnd = other.startPeriod + otherContract.duration;
      const isOverlap = p >= other.startPeriod && p < otherEnd;

      if (isOverlap) {
        // Bentrok Guru, Kelas, atau Ruangan
        if (otherContract.teacherId === contract.teacherId) return false;
        if (otherContract.classId === contract.classId) return false;
        if (otherContract.roomId === contract.roomId) return false;
      }
    }
  }
  return true;
}

function generateTimetable() {
  // Pertahankan kartu yang sudah di-Lock, reset sisanya
  const workingCards = appState.cards.map(c =>
    c.isLocked ? { ...c } : { ...c, dayIndex: null, startPeriod: null }
  );

  // Urutkan kartu yang belum terjadwal: Double lesson (durasi 2) diprioritaskan lebih dulu (Heuristik MRV)
  const unplaced = workingCards
    .filter(c => c.dayIndex === null)
    .sort((a, b) => {
      const durA = appState.contracts.find(x => x.id === a.contractId)?.duration || 1;
      const durB = appState.contracts.find(x => x.id === b.contractId)?.duration || 1;
      return durB - durA;
    });

  // Buat daftar semua kemungkinan slot (Hari, Jam) dan acak sedikit agar distribusi merata
  const allSlots = [];
  for (let d = 0; d < appState.config.days.length; d++) {
    for (let p = 0; p < appState.config.periodsPerDay; p++) {
      allSlots.push({ d, p });
    }
  }

  let iterations = 0;
  const MAX_ITERATIONS = 25000;

  function backtrack(index) {
    if (index >= unplaced.length) return true;
    if (++iterations > MAX_ITERATIONS) return false;

    const currentCard = unplaced[index];
    // Acak urutan slot untuk menghindari penumpukan di hari Senin jam ke-1
    const shuffledSlots = [...allSlots].sort(() => Math.random() - 0.5);

    for (const slot of shuffledSlots) {
      if (canPlaceCard(workingCards, currentCard, slot.d, slot.p)) {
        currentCard.dayIndex = slot.d;
        currentCard.startPeriod = slot.p;

        if (backtrack(index + 1)) return true;

        // Backtrack jika menemui jalan buntu
        currentCard.dayIndex = null;
        currentCard.startPeriod = null;
      }
    }
    return false;
  }

  const success = backtrack(0);
  appState.cards = workingCards;
  saveState();
  renderScheduleBoard();

  const remaining = appState.cards.filter(c => c.dayIndex === null).length;
  if (success && remaining === 0) {
    showAlert('✅ Berhasil! Seluruh kartu pelajaran berhasil dijadwalkan tanpa bentrok.', 'success');
  } else {
    showAlert(`⚠️ Selesai sebagian: ${remaining} kartu belum mendapatkan slot kosong. Coba kurangi Time-Off atau klik Generate ulang.`, 'error');
  }
}

function runTestAndVerify() {
  const conflicts = [];
  const placed = appState.cards.filter(c => c.dayIndex !== null);

  placed.forEach(card => {
    if (!canPlaceCard(placed, card, card.dayIndex, card.startPeriod)) {
      const contract = appState.contracts.find(c => c.id === card.contractId);
      const subj = appState.subjects.find(s => s.id === contract?.subjectId)?.name;
      const cls = appState.classes.find(c => c.id === contract?.classId)?.name;
      conflicts.push(`${subj} (${cls}) di ${appState.config.days[card.dayIndex]} Jam ke-${card.startPeriod + 1}`);
    }
  });

  if (conflicts.length === 0) {
    showAlert(`✅ Verifikasi Lolos! ${placed.length} kartu terpasang dan 0 bentrok ditemukan.`, 'success');
  } else {
    showAlert(`❌ Ditemukan ${conflicts.length} bentrok jadwal: ${conflicts.slice(0, 3).join(', ')}...`, 'error');
  }
}

// ============================================================================
// RENDER PAPAN JADWAL & DRAG-AND-DROP MANUAL
// ============================================================================
function renderScheduleBoard() {
  const mode = document.getElementById('boardViewMode').value;
  const thead = document.getElementById('scheduleTableHead');
  const tbody = document.getElementById('scheduleTableBody');
  const unplacedList = document.getElementById('unplacedCardsList');

  const days = appState.config.days;
  const periods = appState.config.periodsPerDay;

  // 1. Render Kartu Belum Terjadwal
  const unplaced = appState.cards.filter(c => c.dayIndex === null);
  document.getElementById('unplacedCount').textContent = unplaced.length;
  unplacedList.innerHTML = unplaced.map(card => createCardHTML(card)).join('');

  // 2. Render Header Tabel (Hari & Jam ke-1..N)
  let headRow1 = `<tr><th rowspan="2" class="p-2.5 border border-slate-700 bg-slate-900 text-left min-w-[130px] sticky left-0 z-10">${
    mode === 'CLASS' ? 'Kelas' : mode === 'TEACHER' ? 'Guru' : 'Ruangan'
  }</th>`;
  let headRow2 = `<tr>`;

  days.forEach(day => {
    headRow1 += `<th colspan="${periods}" class="p-1.5 border border-slate-700 text-center font-bold uppercase tracking-wider">${day}</th>`;
    for (let p = 1; p <= periods; p++) {
      headRow2 += `<th class="p-1 border border-slate-700 text-center text-[11px] font-normal text-slate-300 w-14">${p}</th>`;
    }
  });
  thead.innerHTML = headRow1 + '</tr>' + headRow2 + '</tr>';

  // 3. Tentukan Baris (Kelas / Guru / Ruangan)
  const rows = mode === 'CLASS' ? appState.classes : mode === 'TEACHER' ? appState.teachers : appState.rooms;

  tbody.innerHTML = rows.map(rowItem => {
    let rowHtml = `<tr class="hover:bg-slate-50">
      <td class="p-2.5 border border-slate-200 font-bold bg-slate-50 sticky left-0 z-10">${rowItem.name}</td>`;

    for (let d = 0; d < days.length; d++) {
      for (let p = 0; p < periods; p++) {
        const slotKey = `${d}-${p}`;
        const isTimeOff = rowItem.timeOff?.[slotKey];

        // Cari kartu yang berada di baris ini & slot ini
        const matchingCards = appState.cards.filter(card => {
          if (card.dayIndex !== d || card.startPeriod === null) return false;
          const contract = appState.contracts.find(c => c.id === card.contractId);
          if (!contract) return false;

          const isRowMatch =
            (mode === 'CLASS' && contract.classId === rowItem.id) ||
            (mode === 'TEACHER' && contract.teacherId === rowItem.id) ||
            (mode === 'ROOM' && contract.roomId === rowItem.id);

          return isRowMatch && p >= card.startPeriod && p < (card.startPeriod + contract.duration);
        });

        // Cek apakah ini awal dari kartu berdurasi ganda (colspan)
        const startingCard = matchingCards.find(c => c.startPeriod === p);
        const coveringCard = matchingCards.find(c => c.startPeriod < p);

        if (coveringCard) {
          // Lewati sel karena sudah digabung oleh colspan kartu sebelumnya
          continue;
        }

        if (startingCard) {
          const contract = appState.contracts.find(c => c.id === startingCard.contractId);
          const hasConflict = !canPlaceCard(appState.cards, startingCard, d, p);
          rowHtml += `<td colspan="${contract.duration}" 
            ondragover="event.preventDefault()" 
            ondrop="handleDrop(event, ${d}, ${p})"
            class="p-1 border border-slate-200 grid-cell ${hasConflict ? 'bg-rose-200 ring-2 ring-rose-500' : ''}">
            ${createCardHTML(startingCard, hasConflict)}
          </td>`;
        } else {
          rowHtml += `<td 
            ondragover="event.preventDefault()" 
            ondrop="handleDrop(event, ${d}, ${p})"
            class="p-1 border border-slate-200 grid-cell ${isTimeOff ? 'bg-rose-50 text-rose-300 text-center' : 'hover:bg-blue-50/60'}">
            ${isTimeOff ? '✗' : ''}
          </td>`;
        }
      }
    }
    return rowHtml + '</tr>';
  }).join('');

  lucide.createIcons();
}

function createCardHTML(card, hasConflict = false) {
  const contract = appState.contracts.find(c => c.id === card.contractId);
  if (!contract) return '';
  const subj = appState.subjects.find(s => s.id === contract.subjectId);
  const teacher = appState.teachers.find(t => t.id === contract.teacherId);
  const cls = appState.classes.find(c => c.id === contract.classId);
  const room = appState.rooms.find(r => r.id === contract.roomId);

  const bgColor = hasConflict ? '#dc2626' : (teacher?.color || '#3b82f6');

  return `
    <div draggable="true"
      ondragstart="draggedCardId = '${card.cardId}'"
      onclick="toggleLockCard('${card.cardId}')"
      style="background-color: ${bgColor}"
      title="Klik untuk Kunci/Buka Kunci • Seret untuk memindahkan"
      class="card-item text-white rounded-md px-2 py-1 shadow-sm text-[11px] leading-tight flex flex-col justify-between min-h-[42px]">
      <div class="flex items-center justify-between font-bold">
        <span>${subj?.code || 'MAPEL'}</span>
        <span>${card.isLocked ? '🔒' : ''}</span>
      </div>
      <div class="text-[10px] opacity-90 truncate">${cls?.name} • ${teacher?.code}</div>
      <div class="text-[9px] opacity-75 truncate">${room?.name}</div>
    </div>
  `;
}

function handleDrop(event, dayIndex, startPeriod) {
  event.preventDefault();
  if (!draggedCardId) return;

  const card = appState.cards.find(c => c.cardId === draggedCardId);
  if (card) {
    card.dayIndex = dayIndex;
    card.startPeriod = startPeriod;
    saveState();
    renderScheduleBoard();
  }
  draggedCardId = null;
}

function toggleLockCard(cardId) {
  const card = appState.cards.find(c => c.cardId === cardId);
  if (card && card.dayIndex !== null) {
    card.isLocked = !card.isLocked;
    saveState();
    renderScheduleBoard();
  }
}

function clearUnlockedSchedule() {
  appState.cards.forEach(c => {
    if (!c.isLocked) {
      c.dayIndex = null;
      c.startPeriod = null;
    }
  });
  saveState();
  renderScheduleBoard();
  showAlert('Jadwal yang tidak terkunci telah dikosongkan.', 'info');
}

// ============================================================================
// CRUD MASTER DATA & TIME-OFF GRID
// ============================================================================
function renderMasterLists() {
  document.getElementById('listSubjects').innerHTML = appState.subjects.map(s => `
    <li class="py-2 flex justify-between items-center">
      <span><b>${s.code}</b> - ${s.name}</span>
      <button onclick="deleteItem('subjects', '${s.id}')" class="text-rose-500 hover:underline text-xs">Hapus</button>
    </li>
  `).join('');

  document.getElementById('listTeachers').innerHTML = appState.teachers.map(t => `
    <li class="py-2 flex justify-between items-center">
      <span class="flex items-center gap-2">
        <span class="w-3 h-3 rounded-full inline-block" style="background:${t.color}"></span>
        <b>${t.code}</b> - ${t.name}
      </span>
      <div class="flex gap-2">
        <button onclick="openTimeOff('teachers', '${t.id}')" class="text-blue-600 hover:underline text-xs">Atur Time-Off</button>
        <button onclick="deleteItem('teachers', '${t.id}')" class="text-rose-500 hover:underline text-xs">Hapus</button>
      </div>
    </li>
  `).join('');

  document.getElementById('listClasses').innerHTML = appState.classes.map(c => `
    <li class="py-2 flex justify-between items-center">
      <span class="font-medium">Kelas ${c.name}</span>
      <div class="flex gap-2">
        <button onclick="openTimeOff('classes', '${c.id}')" class="text-blue-600 hover:underline text-xs">Atur Time-Off</button>
        <button onclick="deleteItem('classes', '${c.id}')" class="text-rose-500 hover:underline text-xs">Hapus</button>
      </div>
    </li>
  `).join('');

  document.getElementById('listRooms').innerHTML = appState.rooms.map(r => `
    <li class="py-2 flex justify-between items-center">
      <span>${r.name}</span>
      <button onclick="deleteItem('rooms', '${r.id}')" class="text-rose-500 hover:underline text-xs">Hapus</button>
    </li>
  `).join('');
}

function addSubject() {
  const name = document.getElementById('inSubjName').value.trim();
  const code = document.getElementById('inSubjCode').value.trim().toUpperCase();
  if (!name || !code) return;
  appState.subjects.push({ id: 's' + Date.now(), name, code });
  document.getElementById('inSubjName').value = '';
  document.getElementById('inSubjCode').value = '';
  saveState(); renderMasterLists();
}

function addTeacher() {
  const name = document.getElementById('inTeacherName').value.trim();
  const code = document.getElementById('inTeacherCode').value.trim().toUpperCase();
  const color = document.getElementById('inTeacherColor').value;
  if (!name || !code) return;
  appState.teachers.push({ id: 't' + Date.now(), name, code, color, timeOff: {} });
  document.getElementById('inTeacherName').value = '';
  document.getElementById('inTeacherCode').value = '';
  saveState(); renderMasterLists();
}

function addClass() {
  const name = document.getElementById('inClassName').value.trim();
  if (!name) return;
  appState.classes.push({ id: 'c' + Date.now(), name, timeOff: {} });
  document.getElementById('inClassName').value = '';
  saveState(); renderMasterLists();
}

function addRoom() {
  const name = document.getElementById('inRoomName').value.trim();
  if (!name) return;
  appState.rooms.push({ id: 'r' + Date.now(), name });
  document.getElementById('inRoomName').value = '';
  saveState(); renderMasterLists();
}

function deleteItem(collection, id) {
  appState[collection] = appState[collection].filter(item => item.id !== id);
  saveState(); renderMasterLists();
}

function openTimeOff(collection, id) {
  const entity = appState[collection].find(x => x.id === id);
  if (!entity) return;
  if (!entity.timeOff) entity.timeOff = {};

  document.getElementById('timeOffPanel').classList.remove('hidden');
  document.getElementById('timeOffTitle').textContent = `Batasan Waktu (Time-Off): ${entity.name}`;

  let html = `<table class="border-collapse text-xs"><thead><tr><th class="p-2 border bg-slate-100">Hari / Jam</th>`;
  for (let p = 0; p < appState.config.periodsPerDay; p++) {
    html += `<th class="p-2 border bg-slate-100 w-10">Jam ${p + 1}</th>`;
  }
  html += `</tr></thead><tbody>`;

  appState.config.days.forEach((day, dIdx) => {
    html += `<tr><td class="p-2 border font-semibold bg-slate-50">${day}</td>`;
    for (let p = 0; p < appState.config.periodsPerDay; p++) {
      const key = `${dIdx}-${p}`;
      const blocked = !!entity.timeOff[key];
      html += `<td onclick="toggleTimeOffSlot('${collection}', '${id}', '${key}')" 
        class="p-2 border text-center cursor-pointer font-bold ${blocked ? 'bg-rose-100 text-rose-600' : 'bg-emerald-50 text-emerald-600'}">
        ${blocked ? '✗' : '✓'}
      </td>`;
    }
    html += `</tr>`;
  });

  document.getElementById('timeOffGridContainer').innerHTML = html + '</tbody></table>';
}

function toggleTimeOffSlot(collection, id, key) {
  const entity = appState[collection].find(x => x.id === id);
  if (entity.timeOff[key]) delete entity.timeOff[key];
  else entity.timeOff[key] = true;
  saveState();
  openTimeOff(collection, id);
}

// ============================================================================
// KONTRAK PELAJARAN (LESSONS)
// ============================================================================
function renderLessonsTab() {
  document.getElementById('selLessonTeacher').innerHTML = appState.teachers.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  document.getElementById('selLessonSubject').innerHTML = appState.subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  document.getElementById('selLessonClass').innerHTML = appState.classes.map(c => `<option value="${c.id}">Kelas ${c.name}</option>`).join('');
  document.getElementById('selLessonRoom').innerHTML = appState.rooms.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

  document.getElementById('listLessons').innerHTML = appState.contracts.map(k => {
    const t = appState.teachers.find(x => x.id === k.teacherId)?.name || '-';
    const s = appState.subjects.find(x => x.id === k.subjectId)?.name || '-';
    const c = appState.classes.find(x => x.id === k.classId)?.name || '-';
    const r = appState.rooms.find(x => x.id === k.roomId)?.name || '-';
    return `
      <tr>
        <td class="p-3 font-medium">${t}</td>
        <td class="p-3">${s}</td>
        <td class="p-3"><span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-bold">${c}</span></td>
        <td class="p-3">${r}</td>
        <td class="p-3">${k.sessions}x / minggu</td>
        <td class="p-3">${k.duration === 2 ? 'Double (2 Jam)' : 'Single (1 Jam)'}</td>
        <td class="p-3 text-right">
          <button onclick="deleteContract('${k.id}')" class="text-rose-600 hover:underline text-xs">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

function addLessonContract() {
  const newContract = {
    id: 'k' + Date.now(),
    teacherId: document.getElementById('selLessonTeacher').value,
    subjectId: document.getElementById('selLessonSubject').value,
    classId: document.getElementById('selLessonClass').value,
    roomId: document.getElementById('selLessonRoom').value,
    sessions: parseInt(document.getElementById('inLessonSessions').value) || 1,
    duration: parseInt(document.getElementById('selLessonDuration').value) || 1
  };
  appState.contracts.push(newContract);
  // Tambahkan kartu baru ke papan
  for (let i = 0; i < newContract.sessions; i++) {
    appState.cards.push({
      cardId: `${newContract.id}_s${i + 1}`,
      contractId: newContract.id,
      dayIndex: null,
      startPeriod: null,
      isLocked: false
    });
  }
  saveState();
  renderLessonsTab();
  showAlert('Kontrak pelajaran berhasil ditambahkan.', 'success');
}

function deleteContract(contractId) {
  appState.contracts = appState.contracts.filter(c => c.id !== contractId);
  appState.cards = appState.cards.filter(c => c.contractId !== contractId);
  saveState();
  renderLessonsTab();
}

// ============================================================================
// PENGATURAN & SINKRONISASI CLOUDFLARE WORKER / FIREBASE
// ============================================================================
function renderSettingsTab() {
  document.getElementById('cfgSchoolName').value = appState.config.schoolName;
  document.getElementById('cfgAcademicYear').value = appState.config.academicYear;
  document.getElementById('cfgPeriodsPerDay').value = appState.config.periodsPerDay;
  document.getElementById('cfgDays').value = appState.config.days.join(', ');
  document.getElementById('cfgWorkerUrl').value = appState.config.workerUrl || '';
  document.getElementById('cfgSchoolId').value = appState.config.schoolId || 'smpn-1-default';
}

function saveSchoolConfig() {
  appState.config.schoolName = document.getElementById('cfgSchoolName').value;
  appState.config.academicYear = document.getElementById('cfgAcademicYear').value;
  appState.config.periodsPerDay = parseInt(document.getElementById('cfgPeriodsPerDay').value) || 8;
  appState.config.days = document.getElementById('cfgDays').value.split(',').map(d => d.trim()).filter(Boolean);
  appState.config.workerUrl = document.getElementById('cfgWorkerUrl').value.trim();
  appState.config.schoolId = document.getElementById('cfgSchoolId').value.trim();
  
  document.getElementById('headerSchoolInfo').textContent = `${appState.config.schoolName} • Tahun Ajaran ${appState.config.academicYear}`;
  saveState();
  showAlert('Pengaturan sekolah berhasil disimpan.', 'success');
}

async function syncToCloudflareWorker() {
  const url = appState.config.workerUrl;
  if (!url) {
    showAlert('⚠️ Masukkan URL Cloudflare Worker Anda terlebih dahulu di kolom di atas.', 'error');
    return;
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/schedule/${appState.config.schoolId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(appState)
    });
    const data = await res.json();
    if (res.ok) {
      showAlert(`✅ Berhasil tersimpan ke Cloud API & Firebase! (${data.message || 'OK'})`, 'success');
    } else {
      showAlert(`❌ Gagal menyimpan: ${data.error || 'Terjadi kesalahan server'}`, 'error');
    }
  } catch (err) {
    showAlert(`❌ Gagal terhubung ke Cloudflare Worker: ${err.message}`, 'error');
  }
}

function exportJsonBackup() {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jadwal_${appState.config.schoolId}.json`;
  a.click();
}

function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY);
  appState = loadState();
  saveState();
  renderScheduleBoard();
  showAlert('Data telah di-reset ke contoh awal.', 'info');
}

// Inisialisasi awal saat halaman dibuka
document.getElementById('headerSchoolInfo').textContent = `${appState.config.schoolName} • Tahun Ajaran ${appState.config.academicYear}`;
renderScheduleBoard();
