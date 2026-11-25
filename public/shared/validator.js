/**
 * Shared Validator & Conflict Engine
 * Digunakan bersama oleh: UI Browser, solver.worker.js, dan Cloudflare worker.js
 */

/**
 * Mengecek apakah sebuah kartu bisa ditempatkan di (dayIndex, startPeriod)
 * Mengembalikan { valid: boolean, reason?: string, severity?: 'HARD' | 'SOFT' }
 */
export function checkPlacement(state, targetCard, dayIndex, startPeriod, ignoreCardId = null) {
  const contract = state.contracts.find(c => c.id === targetCard.contractId);
  if (!contract) return { valid: false, reason: 'Kontrak pelajaran tidak ditemukan', severity: 'HARD' };

  const teacher = state.teachers.find(t => t.id === contract.teacherId);
  const schoolClass = state.classes.find(c => c.id === contract.classId);
  const room = state.rooms.find(r => r.id === contract.roomId);
  const duration = contract.duration || 1;

  // 1. Cek batas jam operasional sekolah
  if (dayIndex < 0 || dayIndex >= state.config.days.length) {
    return { valid: false, reason: 'Hari di luar jadwal aktif', severity: 'HARD' };
  }
  if (startPeriod < 0 || startPeriod + duration > state.config.periodsPerDay) {
    return { valid: false, reason: `Durasi ${duration} jam melewati batas jam pulang`, severity: 'HARD' };
  }

  for (let offset = 0; offset < duration; offset++) {
    const p = startPeriod + offset;
    const slotKey = `${dayIndex}-${p}`;

    // 2. Cek Time-Off Guru & Kelas
    if (teacher?.timeOff?.[slotKey]) {
      return { valid: false, reason: `${teacher.name} sedang Time-Off (tidak bisa mengajar)`, severity: 'HARD' };
    }
    if (schoolClass?.timeOff?.[slotKey]) {
      return { valid: false, reason: `Kelas ${schoolClass.name} sedang libur/kosong di jam ini`, severity: 'HARD' };
    }

    // 3. Cek Bentrok dengan kartu lain yang sudah terpasang
    for (const other of state.cards) {
      if (other.cardId === targetCard.cardId || other.cardId === ignoreCardId) continue;
      if (other.dayIndex !== dayIndex || other.startPeriod === null || other.startPeriod === undefined) continue;

      const otherContract = state.contracts.find(c => c.id === other.contractId);
      if (!otherContract) continue;

      const otherEnd = other.startPeriod + (otherContract.duration || 1);
      const isOverlap = p >= other.startPeriod && p < otherEnd;

      if (isOverlap) {
        if (otherContract.teacherId === contract.teacherId) {
          const otherClass = state.classes.find(c => c.id === otherContract.classId)?.name || 'kelas lain';
          return { valid: false, reason: `${teacher?.name || 'Guru'} sudah mengajar di ${otherClass}`, severity: 'HARD' };
        }
        if (otherContract.classId === contract.classId) {
          const otherSubj = state.subjects.find(s => s.id === otherContract.subjectId)?.name || 'mapel lain';
          return { valid: false, reason: `Kelas ${schoolClass?.name} sudah ada pelajaran ${otherSubj}`, severity: 'HARD' };
        }
        if (otherContract.roomId && otherContract.roomId === contract.roomId) {
          const otherClass = state.classes.find(c => c.id === otherContract.classId)?.name || 'kelas lain';
          return { valid: false, reason: `Ruang ${room?.name} sedang dipakai ${otherClass}`, severity: 'HARD' };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Pre-computed Conflict Map untuk Drag-and-Drop 60 FPS di laptop spesifikasi rendah.
 * Menghasilkan Map<"dayIndex-periodIndex", "Alasan Bentrok">
 */
export function computeForbiddenSlotsMap(state, draggingCard) {
  const forbidden = new Map();
  for (let d = 0; d < state.config.days.length; d++) {
    for (let p = 0; p < state.config.periodsPerDay; p++) {
      const check = checkPlacement(state, draggingCard, d, p, draggingCard.cardId);
      if (!check.valid) {
        forbidden.set(`${d}-${p}`, check.reason);
      }
    }
  }
  return forbidden;
}

/**
 * Validasi Menyeluruh (Digunakan oleh Panel Konflik UI & Server Cloudflare Worker)
 */
export function validateFullSchedule(state) {
  const conflicts = [];
  const placedCards = (state.cards || []).filter(c => c.dayIndex !== null && c.startPeriod !== null);

  // 1. Cek Hard Conflicts (Bentrok slot)
  for (const card of placedCards) {
    const res = checkPlacement(state, card, card.dayIndex, card.startPeriod, card.cardId);
    if (!res.valid) {
      const contract = state.contracts.find(c => c.id === card.contractId);
      const subj = state.subjects.find(s => s.id === contract?.subjectId)?.name || 'Mapel';
      const cls = state.classes.find(c => c.id === contract?.classId)?.name || 'Kelas';
      conflicts.push({
        id: `err_${card.cardId}`,
        severity: 'HARD', // Merah: memblokir Publish
        cardId: card.cardId,
        dayIndex: card.dayIndex,
        period: card.startPeriod,
        title: `${subj} (${cls})`,
        detail: `${state.config.days[card.dayIndex]} Jam ke-${card.startPeriod + 1}: ${res.reason}`
      });
    }
  }

  // 2. Cek Soft Warnings (Kartu belum terjadwal)
  const unplacedCount = (state.cards || []).length - placedCards.length;
  if (unplacedCount > 0) {
    conflicts.push({
      id: 'warn_unplaced',
      severity: 'SOFT', // Kuning: peringatan, tetap boleh publish jika disengaja
      title: `${unplacedCount} kartu belum ditempatkan`,
      detail: 'Masih ada beban mengajar di sidebar yang belum masuk ke grid jadwal.'
    });
  }

  return {
    isValid: conflicts.filter(c => c.severity === 'HARD').length === 0,
    hardCount: conflicts.filter(c => c.severity === 'HARD').length,
    softCount: conflicts.filter(c => c.severity === 'SOFT').length,
    conflicts
  };
}

/**
 * Sanitasi Data untuk Halaman Publik Siswa (Menyembunyikan time-off guru & draft internal)
 */
export function buildPublicSchedulePayload(state) {
  const scheduleItems = [];
  for (const card of state.cards || []) {
    if (card.dayIndex === null || card.startPeriod === null) continue;
    const contract = state.contracts.find(c => c.id === card.contractId);
    if (!contract) continue;

    const subject = state.subjects.find(s => s.id === contract.subjectId);
    const teacher = state.teachers.find(t => t.id === contract.teacherId);
    const schoolClass = state.classes.find(c => c.id === contract.classId);
    const room = state.rooms.find(r => r.id === contract.roomId);

    scheduleItems.push({
      dayIndex: card.dayIndex,
      dayName: state.config.days[card.dayIndex],
      startPeriod: card.startPeriod,
      duration: contract.duration || 1,
      subjectName: subject?.name || '-',
      subjectCode: subject?.code || '-',
      category: subject?.category || 'EXACT',
      teacherName: teacher?.name || '-',
      className: schoolClass?.name || '-',
      roomName: room?.name || '-'
    });
  }

  return {
    schoolName: state.config.schoolName,
    academicYear: state.config.academicYear,
    days: state.config.days,
    periodsPerDay: state.config.periodsPerDay,
    classes: state.classes.map(c => c.name),
    teachers: state.teachers.map(t => t.name),
    items: scheduleItems
  };
}
