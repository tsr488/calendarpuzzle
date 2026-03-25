// Main application — camera capture → auto-detect → solve → overlay
import { PIECES, BOARD_CELLS, getCellsToCover, cellKey, BOARD_COLS, BOARD_ROWS, getCellLabel } from './board.js';
import { solvePuzzle } from './solver.js';
import { Camera } from './camera.js';
import { waitForOpenCV, detectBoard, identifyPlacedPieces, drawDebug } from './detect.js';
import { APP_VERSION } from './version.js';

class App {
  constructor() {
    this.camera = null;
    this.cvReady = false;
    this.solving = false;
  }

  async init() {
    // Version display
    document.getElementById('version-label').textContent = 'v' + APP_VERSION;

    const videoEl = document.getElementById('camera-video');
    const photoCanvas = document.getElementById('photo-canvas');
    this.camera = new Camera(videoEl, photoCanvas);

    this.statusEl = document.getElementById('status');
    this.startBtn = document.getElementById('camera-start-btn');
    this.captureBtn = document.getElementById('camera-capture-btn');
    this.retakeBtn = document.getElementById('camera-retake-btn');
    this.resultCanvas = document.getElementById('result-canvas');
    this.photoCanvas = photoCanvas;
    this.debugCanvas = document.getElementById('debug-canvas');

    this.startBtn.addEventListener('click', () => this._startCamera());
    this.captureBtn.addEventListener('click', () => this._captureAndSolve());
    this.retakeBtn.addEventListener('click', () => this._retake());

    // Long-press status to toggle debug view
    let pressTimer;
    this.statusEl.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        const dbg = document.getElementById('debug-section');
        dbg.classList.toggle('hidden');
      }, 800);
    });
    this.statusEl.addEventListener('pointerup', () => clearTimeout(pressTimer));
    this.statusEl.addEventListener('pointerleave', () => clearTimeout(pressTimer));

    // Load OpenCV.js
    this.statusEl.textContent = 'Loading OpenCV...';
    try {
      await waitForOpenCV();
      this.cvReady = true;
      this.statusEl.textContent = 'Ready — tap Start Camera';
    } catch {
      this.statusEl.textContent = 'OpenCV failed to load. Refresh to retry.';
    }
  }

  async _startCamera() {
    try {
      this.statusEl.textContent = 'Starting camera...';
      await this.camera.start();
      document.getElementById('camera-video').classList.remove('hidden');
      this.startBtn.classList.add('hidden');
      this.captureBtn.disabled = false;
      this.retakeBtn.classList.add('hidden');
      this.photoCanvas.classList.add('hidden');
      this.resultCanvas.classList.add('hidden');
      document.getElementById('debug-section').classList.add('hidden');
      this.statusEl.textContent = 'Point at puzzle board, then tap Capture & Solve';
    } catch (err) {
      this.statusEl.textContent = 'Camera error: ' + (err.message || 'denied');
    }
  }

  async _captureAndSolve() {
    if (!this.cvReady) {
      this.statusEl.textContent = 'OpenCV still loading...';
      return;
    }
    if (this.solving) return;

    // Capture photo
    const frameInfo = this.camera.capture();
    if (!frameInfo) return;
    this.camera.stop();

    // Hide video, show captured photo
    document.getElementById('camera-video').classList.add('hidden');
    this.photoCanvas.classList.remove('hidden');
    const maxW = Math.min(400, window.innerWidth - 32);
    const aspect = frameInfo.height / frameInfo.width;
    this.photoCanvas.style.width = maxW + 'px';
    this.photoCanvas.style.height = Math.round(maxW * aspect) + 'px';

    // Update UI
    this.captureBtn.disabled = true;
    this.retakeBtn.classList.remove('hidden');
    this.solving = true;
    this.statusEl.textContent = 'Detecting board...';

    // Run detection + solve in next frame to let UI update
    setTimeout(() => this._detectAndSolve(), 50);
  }

  _detectAndSolve() {
    const t0 = performance.now();
    let detection = null;

    try {
      // 1. Detect board and classify cells
      detection = detectBoard(this.photoCanvas);
    } catch (err) {
      console.error('Detection error:', err);
      // Still try to draw debug with whatever we have
      drawDebug(this.debugCanvas, this.photoCanvas, null, new Set(), new Set());
      this.statusEl.textContent = err.message;
      this.solving = false;
      // Show debug on failure to help diagnose
      document.getElementById('debug-section').classList.remove('hidden');
      return;
    }

    const detectTime = (performance.now() - t0).toFixed(0);

    // Debug visualization
    drawDebug(this.debugCanvas, this.photoCanvas, detection.corners, detection.occupied, detection.empty, detection.cellDebug);

    try {
      // 2. Use today's date
      const today = new Date();
      const month = today.getMonth() + 1;
      const day = today.getDate();
      const targetCells = getCellsToCover(month, day);

      if (!targetCells) {
        this.statusEl.textContent = 'Invalid date';
        this.solving = false;
        return;
      }

      // 3. At least 1 piece is placed. The empty non-date cells need to be
      //    filled by the remaining (unplaced) pieces.
      //    Total piece area = 5*7 + 6*1 = 41 cells. Board has 43 cells, minus 2 date = 41.
      //    HARD RULE: occupied + solver solution = 41 cells exactly.
      
      const occupiedCount = detection.occupied.size;
      
      // Identify which pieces are already on the board
      const usedPieceIndices = identifyPlacedPieces(detection.occupied);
      const availablePieces = PIECES.filter((_, i) => !usedPieceIndices.has(i));
      
      // Get empty cells that aren't date cells (these need to be covered)
      const targetSet = new Set(targetCells.map(([c, r]) => cellKey(c, r)));
      const emptyNonDateCells = targetCells.filter(([c, r]) => !detection.occupied.has(cellKey(c, r)));
      const emptyCount = emptyNonDateCells.length;

      // Validate: occupied (on target cells only) + empty must = 41
      const occupiedOnTarget = targetCells.filter(([c, r]) => detection.occupied.has(cellKey(c, r))).length;

      if (emptyCount === 0) {
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `Puzzle complete! (${detectTime}ms)`;
        this.solving = false;
        return;
      }

      this.statusEl.textContent = `${occupiedOnTarget} covered, ${emptyCount} empty, ${usedPieceIndices.size} pieces detected, ${availablePieces.length} remaining. Solving...`;
      const t1 = performance.now();
      
      // Try solving with only the available (unplaced) pieces
      let solution = this._trySolveWithAvailable(emptyNonDateCells, availablePieces);
      
      // If that fails, try flipping the most borderline cells
      if (!solution && detection.cellScores) {
        const borderline = detection.cellScores
          .filter(cs => targetSet.has(cs.key))
          .slice(0, 6);
        
        // Try flipping 1 borderline cell at a time
        for (let i = 0; i < borderline.length && !solution; i++) {
          const flipped = new Set(detection.occupied);
          const cs = borderline[i];
          if (flipped.has(cs.key)) { flipped.delete(cs.key); } else { flipped.add(cs.key); }
          
          const altEmpty = targetCells.filter(([c, r]) => !flipped.has(cellKey(c, r)));
          const altUsed = identifyPlacedPieces(flipped);
          const altAvail = PIECES.filter((_, idx) => !altUsed.has(idx));
          solution = this._trySolveWithAvailable(altEmpty, altAvail);
        }
        
        // Try flipping 2 borderline cells
        for (let i = 0; i < borderline.length && !solution; i++) {
          for (let j = i + 1; j < borderline.length && !solution; j++) {
            const flipped = new Set(detection.occupied);
            for (const idx of [i, j]) {
              const cs = borderline[idx];
              if (flipped.has(cs.key)) { flipped.delete(cs.key); } else { flipped.add(cs.key); }
            }
            const altEmpty = targetCells.filter(([c, r]) => !flipped.has(cellKey(c, r)));
            const altUsed = identifyPlacedPieces(flipped);
            const altAvail = PIECES.filter((_, idx) => !altUsed.has(idx));
            solution = this._trySolveWithAvailable(altEmpty, altAvail);
          }
        }
      }

      const totalTime = (performance.now() - t0).toFixed(0);

      // Always show debug section so user can verify classification
      document.getElementById('debug-section').classList.remove('hidden');

      if (solution) {
        // Validate: solution cells + occupied on target must = 41
        const solvedArea = solution.reduce((sum, p) => sum + p.cells.length, 0);
        const totalCovered = occupiedOnTarget + solvedArea;
        if (totalCovered !== 41) {
          // Invalid — detection was wrong, don't show bogus solution
          this._drawResultOverlay(detection, [], month, day);
          this.statusEl.textContent = `Bad detection: ${occupiedOnTarget}+${solvedArea}=${totalCovered}≠41 (${totalTime}ms)`;
        } else {
          this._drawResultOverlay(detection, solution, month, day);
          this.statusEl.textContent = `Solved! ${solution.length} pieces placed, ${8-solution.length} detected (${totalTime}ms)`;
        }
      } else {
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `No solution: ${occupiedOnTarget} occ + ${emptyCount} empty = ${occupiedOnTarget+emptyCount} (need 41) (${totalTime}ms)`;
      }
    } catch (err) {
      console.error('Detection error:', err);
      this.statusEl.textContent = 'Detection failed: ' + err.message;
    }

    this.solving = false;
  }

  /**
   * Try solving with available (unplaced) pieces.
   * First tries all available pieces. If area doesn't match, tries subsets.
   * @param {number[][]} cells - cells to cover
   * @param {object[]} available - pieces not yet placed on the board
   * @returns {object[]|null}
   */
  _trySolveWithAvailable(cells, available) {
    const cellCount = cells.length;
    if (cellCount === 0 || available.length === 0) return null;

    // First try: use ALL available pieces (most likely correct)
    const totalArea = available.reduce((sum, p) => sum + p.coords.length, 0);
    if (totalArea === cellCount) {
      const solution = solvePuzzle(cells, available);
      if (solution) return solution;
    }

    // If piece detection missed some, try subsets of available pieces
    // whose total area matches the empty cell count
    for (let n = available.length - 1; n >= 1; n--) {
      const combos = this._combinations(available, n);
      for (const subset of combos) {
        const subArea = subset.reduce((sum, p) => sum + p.coords.length, 0);
        if (subArea !== cellCount) continue;
        const solution = solvePuzzle(cells, subset);
        if (solution) return solution;
      }
    }
    return null;
  }

  /**
   * Generate all combinations of k items from arr
   */
  _combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const results = [];
    const [first, ...rest] = arr;
    // Include first
    for (const combo of this._combinations(rest, k - 1)) {
      results.push([first, ...combo]);
    }
    // Exclude first
    for (const combo of this._combinations(rest, k)) {
      results.push(combo);
    }
    return results;
  }

  /**
   * Draw the solution overlay on the result canvas
   */
  _drawResultOverlay(detection, solution, month, day) {
    const canvas = this.resultCanvas;
    canvas.classList.remove('hidden');

    const cellPx = 48;
    const offsetX = 10;
    const offsetY = 10;
    const w = BOARD_COLS * cellPx + offsetX * 2;
    const h = BOARD_ROWS * cellPx + offsetY * 2;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = 2;

    // Draw all board cells
    for (const [c, r] of BOARD_CELLS) {
      const x = offsetX + c * cellPx;
      const y = offsetY + (BOARD_ROWS - 1 - r) * cellPx;
      const key = cellKey(c, r);

      const isOccupied = detection.occupied.has(key);

      // Check if this is a "date" cell (should be visible)
      const targetCells = getCellsToCover(month, day);
      const isDateCell = !targetCells.some(([tc, tr]) => tc === c && tr === r) 
        && BOARD_CELLS.some(([bc, br]) => bc === c && br === r);

      if (isDateCell) {
        ctx.fillStyle = '#fff3cd';
      } else if (isOccupied) {
        ctx.fillStyle = '#7f8c8d88'; // gray = detected as occupied
      } else {
        ctx.fillStyle = '#f5f0e8';
      }

      ctx.strokeStyle = '#c4b998';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x + p, y + p, cellPx - p * 2, cellPx - p * 2, 4);
      ctx.fill();
      ctx.stroke();

      // Label
      const label = getCellLabel(c, r);
      ctx.fillStyle = isDateCell ? '#d63384' : '#6c757d';
      ctx.font = isDateCell ? 'bold 13px system-ui' : '11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + cellPx / 2, y + cellPx / 2);
    }

    // Draw solution pieces on top
    if (solution) {
      for (const placement of solution) {
        ctx.fillStyle = placement.color + 'cc';
        for (const [c, r] of placement.cells) {
          const x = offsetX + c * cellPx;
          const y = offsetY + (BOARD_ROWS - 1 - r) * cellPx;
          ctx.beginPath();
          ctx.roundRect(x + p, y + p, cellPx - p * 2, cellPx - p * 2, 4);
          ctx.fill();
        }

        // Piece borders
        ctx.strokeStyle = placement.color;
        ctx.lineWidth = 2;
        const cellSet = new Set(placement.cells.map(([c, r]) => `${c},${r}`));
        for (const [c, r] of placement.cells) {
          const x = offsetX + c * cellPx;
          const y = offsetY + (BOARD_ROWS - 1 - r) * cellPx;
          if (!cellSet.has(`${c},${r+1}`)) { ctx.beginPath(); ctx.moveTo(x+p,y+p); ctx.lineTo(x+cellPx-p,y+p); ctx.stroke(); }
          if (!cellSet.has(`${c},${r-1}`)) { ctx.beginPath(); ctx.moveTo(x+p,y+cellPx-p); ctx.lineTo(x+cellPx-p,y+cellPx-p); ctx.stroke(); }
          if (!cellSet.has(`${c-1},${r}`)) { ctx.beginPath(); ctx.moveTo(x+p,y+p); ctx.lineTo(x+p,y+cellPx-p); ctx.stroke(); }
          if (!cellSet.has(`${c+1},${r}`)) { ctx.beginPath(); ctx.moveTo(x+cellPx-p,y+p); ctx.lineTo(x+cellPx-p,y+cellPx-p); ctx.stroke(); }
        }
      }
    }
  }

  _retake() {
    this.resultCanvas.classList.add('hidden');
    this.photoCanvas.classList.add('hidden');
    document.getElementById('debug-section').classList.add('hidden');
    this._startCamera();
  }
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());