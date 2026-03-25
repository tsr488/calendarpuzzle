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
      //    So occupied cells = placed piece area, empty non-date = remaining piece area.
      
      // Estimate how many pieces are placed from occupied cell count
      const occupiedCount = detection.occupied.size;
      // Each piece covers ~5.125 cells on average (7×5 + 1×6 = 41 total across 8 pieces)
      // Rough estimate of placed pieces
      const estPlaced = Math.round(occupiedCount / 5.125);
      const estRemaining = Math.max(1, 8 - estPlaced);
      
      // Get empty cells that aren't date cells (these need to be covered)
      const targetSet = new Set(targetCells.map(([c, r]) => cellKey(c, r)));
      const emptyNonDateCells = targetCells.filter(([c, r]) => !detection.occupied.has(cellKey(c, r)));

      if (emptyNonDateCells.length === 0) {
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `Puzzle complete! (${detectTime}ms)`;
        this.solving = false;
        return;
      }

      this.statusEl.textContent = `${occupiedCount} covered, ~${estRemaining} pieces left. Solving...`;
      const t1 = performance.now();
      
      // Try solving with the detected empty region
      // Use subsets of pieces by size to match the cell count
      let solution = this._trySolveWithPieceSubsets(emptyNonDateCells, estRemaining);
      
      // If that fails, try flipping the most borderline cells
      if (!solution && detection.cellScores) {
        const borderline = detection.cellScores
          .filter(cs => targetSet.has(cs.key))
          .slice(0, 6); // up to 6 most borderline cells
        
        // Try flipping 1 borderline cell at a time
        for (let i = 0; i < borderline.length && !solution; i++) {
          const flipped = new Set(detection.occupied);
          const cs = borderline[i];
          if (flipped.has(cs.key)) { flipped.delete(cs.key); } else { flipped.add(cs.key); }
          
          const altEmpty = targetCells.filter(([c, r]) => !flipped.has(cellKey(c, r)));
          const altEstPlaced = Math.round(flipped.size / 5.125);
          const altEstRemaining = Math.max(1, 8 - altEstPlaced);
          solution = this._trySolveWithPieceSubsets(altEmpty, altEstRemaining);
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
            const altEstPlaced = Math.round(flipped.size / 5.125);
            const altEstRemaining = Math.max(1, 8 - altEstPlaced);
            solution = this._trySolveWithPieceSubsets(altEmpty, altEstRemaining);
          }
        }
      }

      const totalTime = (performance.now() - t0).toFixed(0);

      // Always show debug section so user can verify classification
      document.getElementById('debug-section').classList.remove('hidden');

      if (solution) {
        this._drawResultOverlay(detection, solution, month, day);
        this.statusEl.textContent = `Solved! ${solution.length} pieces placed (${totalTime}ms) — scroll down for debug`;
      } else {
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `No solution: ${occupiedCount} occ, ${emptyNonDateCells.length} empty (${totalTime}ms)`;
      }
    } catch (err) {
      console.error('Detection error:', err);
      this.statusEl.textContent = 'Detection failed: ' + err.message;
    }

    this.solving = false;
  }

  /**
   * Try solving a region with different subsets of pieces.
   * The cell count must match the total area of the piece subset.
   * @param {number[][]} cells - cells to cover
   * @param {number} estPieceCount - estimated number of pieces to use
   * @returns {object[]|null}
   */
  _trySolveWithPieceSubsets(cells, estPieceCount) {
    const cellCount = cells.length;
    if (cellCount === 0) return null;

    // Piece sizes: 7 are size 5, 1 is size 6 (the P piece at index 7)
    // Try exact piece count first, then +/- 1
    for (const n of [estPieceCount, estPieceCount - 1, estPieceCount + 1]) {
      if (n < 1 || n > 8) continue;

      // Generate all combinations of n pieces from 8
      const combos = this._combinations(PIECES, n);
      for (const subset of combos) {
        const totalArea = subset.reduce((sum, p) => sum + p.coords.length, 0);
        if (totalArea !== cellCount) continue;

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