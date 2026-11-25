import { checkPlacement } from './shared/validator.js';

let isCancelled = false;

self.onmessage = function (e) {
  const { type, state, options } = e.data;

  if (type === 'CANCEL') {
    isCancelled = true;
    return;
  }

  if (type === 'START') {
    isCancelled = false;
    runSolver(state, options || {});
  }
};

function runSolver(initialState, options) {
  const {
    mode = 'ALL',            // 'EMPTY_ONLY' | 'ALL' | 'FIX_CONFLICTS'
    respectLocks = true,
    maxIterations = 25000
  } = options;

  // Salin state agar tidak memutasi data asli sebelum user klik "Terapkan"
  const workingState = JSON.parse(JSON.stringify(initialState));

  // Siapkan kartu sesuai mode yang dipilih admin
  workingState.cards.forEach(card => {
    if (mode === 'ALL') {
      if (!(respectLocks && card.isLocked)) {
        card.dayIndex = null;
        card.startPeriod = null;
      }
    } else if (mode === 'FIX_CONFLICTS') {
      if (card.dayIndex !== null && !(respectLocks && card.isLocked)) {
        const valid = checkPlacement(workingState, card, card.dayIndex, card.startPeriod, card.cardId).valid;
        if (!valid) {
          card.dayIndex = null;
          card.startPeriod = null;
        }
      }
    }
    // Jika mode === 'EMPTY_ONLY', kartu yang sudah ada di grid dibiarkan utuh
  });

  // Prioritaskan kartu berdurasi ganda (Double Lesson) lebih dulu (MRV Heuristic)
  const unplaced = workingState.cards
    .filter(c => c.dayIndex === null)
    .sort((a, b) => {
      const durA = workingState.contracts.find(k => k.id === a.contractId)?.duration || 1;
      const durB = workingState.contracts.find(k => k.id === b.contractId)?.duration || 1;
      return durB - durA;
    });

  // Buat daftar seluruh kemungkinan slot (Hari, Jam)
  const allSlots = [];
  for (let d = 0; d < workingState.config.days.length; d++) {
    for (let p = 0; p < workingState.config.periodsPerDay; p++) {
      allSlots.push({ d, p });
    }
  }

  let iterations = 0;
  let bestCardsSnapshot = JSON.parse(JSON.stringify(workingState.cards));
  let bestPlacedCount = workingState.cards.filter(c => c.dayIndex !== null).length;

  function backtrack(idx) {
    if (isCancelled) return false;
    if (idx >= unplaced.length) return true;

    iterations++;
    // Kirim laporan progres ke UI setiap 400 iterasi
    if (iterations % 400 === 0) {
      self.postMessage({
        type: 'PROGRESS',
        iterations,
        maxIterations,
        placed: bestPlacedCount,
        total: workingState.cards.length
      });
    }

    if (iterations >= maxIterations) return false;

    const card = unplaced[idx];
    // Acak urutan slot agar pelajaran tersebar merata sepanjang minggu
    const shuffled = [...allSlots].sort(() => Math.random() - 0.5);

    for (const slot of shuffled) {
      if (checkPlacement(workingState, card, slot.d, slot.p, card.cardId).valid) {
        card.dayIndex = slot.d;
        card.startPeriod = slot.p;

        const currentPlaced = workingState.cards.filter(c => c.dayIndex !== null).length;
        if (currentPlaced > bestPlacedCount) {
          bestPlacedCount = currentPlaced;
          bestCardsSnapshot = JSON.parse(JSON.stringify(workingState.cards));
        }

        if (backtrack(idx + 1)) return true;

        // Undo langkah (Backtrack)
        card.dayIndex = null;
        card.startPeriod = null;
      }
    }

    return false;
  }

  const perfectSuccess = backtrack(0);

  self.postMessage({
    type: 'DONE',
    cancelled: isCancelled,
    perfect: perfectSuccess,
    iterations,
    cards: perfectSuccess ? workingState.cards : bestCardsSnapshot
  });
}
