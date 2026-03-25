// Main application — camera capture → auto-detect → solve → overlay
import { PIECES, BOARD_CELLS, getCellsToCover, cellKey, BOARD_COLS, BOARD_ROWS, getCellLabel, isBoardCell } from './board.js';
import { solvePuzzle } from './solver.js';
import { Camera } from './camera.js';
import { waitForOpenCV, detectBoard, reclassifyWithOffset, identifyPlacedPieces, drawDebug } from './detect.js';
import { APP_VERSION } from './version.js';

class App {
  constructor() {
    this.camera = null;
    this.cvReady = false;
    this.solving = false;
    this.solveTomorrow = false;
    // Hint state
    this._solution = null;       // sorted solution placements
    this._detection = null;      // detection result for redrawing
    this._hintIndex = 0;         // how many pieces revealed so far
    this._solveMonth = null;
    this._solveDay = null;
    this._photoImageData = null; // pristine photo for redrawing
  }

  _getTargetDate() {
    const d = new Date();
    if (this.solveTomorrow) d.setDate(d.getDate() + 1);
    return d;
  }

  _updateDateLabel() {
    const d = this._getTargetDate();
    document.getElementById('date-label').textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async init() {
    // Version display
    document.getElementById('version-label').textContent = 'v' + APP_VERSION;

    // Date toggle
    const todayBtn = document.getElementById('date-today');
    const tomorrowBtn = document.getElementById('date-tomorrow');
    todayBtn.addEventListener('click', () => {
      this.solveTomorrow = false;
      todayBtn.classList.add('active');
      tomorrowBtn.classList.remove('active');
      this._updateDateLabel();
    });
    tomorrowBtn.addEventListener('click', () => {
      this.solveTomorrow = true;
      tomorrowBtn.classList.add('active');
      todayBtn.classList.remove('active');
      this._updateDateLabel();
    });
    this._updateDateLabel();

    const videoEl = document.getElementById('camera-video');
    const photoCanvas = document.getElementById('photo-canvas');
    this.camera = new Camera(videoEl, photoCanvas);

    this.statusEl = document.getElementById('status');
    this.startBtn = document.getElementById('camera-start-btn');
    this.captureBtn = document.getElementById('camera-capture-btn');
    this.retakeBtn = document.getElementById('camera-retake-btn');
    this.hintBtn = document.getElementById('hint-btn');
    this.resultCanvas = document.getElementById('result-canvas');
    this.photoCanvas = photoCanvas;
    this.debugCanvas = document.getElementById('debug-canvas');

    this.startBtn.addEventListener('click', () => this._startCamera());
    this.captureBtn.addEventListener('click', () => this._captureAndSolve());
    this.retakeBtn.addEventListener('click', () => this._retake());
    this.hintBtn.addEventListener('click', () => this._showNextHint());

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
      document.getElementById('debug-section').classList.add('hidden');
      this.statusEl.textContent = 'Point at puzzle board, then tap Capture';
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
      return;
    }

    try {
      // 2. Use today's date
      const target = this._getTargetDate();
      const month = target.getMonth() + 1;
      const day = target.getDate();
      const targetCells = getCellsToCover(month, day);

      if (!targetCells) {
        this.statusEl.textContent = 'Invalid date';
        this.solving = false;
        return;
      }

      // 3. Try solving with the default detection, then adjust threshold if needed.
      //    HARD RULE: occupied + solver solution = 41 cells exactly.
      
      const targetSet = new Set(targetCells.map(([c, r]) => cellKey(c, r)));
      
      let solution = null;
      let bestDetection = detection;

      // Try default threshold first, then nudge in both directions
      const offsets = [0, -0.02, 0.02, -0.05, 0.05, -0.08, 0.08, -0.12, 0.12];
      
      for (const offset of offsets) {
        if (solution) break;

        let det = detection;
        if (offset !== 0 && detection.cellStats) {
          det = reclassifyWithOffset(detection.cellStats, offset);
          det.corners = detection.corners;
          det.cellStats = detection.cellStats;
        }

        const emptyNonDateCells = targetCells.filter(([c, r]) => !det.occupied.has(cellKey(c, r)));
        if (emptyNonDateCells.length === 0) continue;

        const usedPieceIndices = identifyPlacedPieces(det.occupied);
        const availablePieces = PIECES.filter((_, i) => !usedPieceIndices.has(i));

        this.statusEl.textContent = `offset ${offset}: ${det.occupied.size} occ, ${availablePieces.length} avail. Solving...`;

        solution = this._trySolveWithAvailable(emptyNonDateCells, availablePieces);
        if (solution) {
          bestDetection = det;
          break;
        }
      }

      detection = bestDetection;

      // Save pristine photo for hint redraws
      const pCtx = this.photoCanvas.getContext('2d');
      this._photoImageData = pCtx.getImageData(0, 0, this.photoCanvas.width, this.photoCanvas.height);

      // Populate debug canvas (hidden until long-press on status)
      drawDebug(this.debugCanvas, this.photoCanvas, detection.corners, detection.occupied, detection.empty, detection.cellDebug);

      // Draw occupied overlay (always, even without solution)
      this._drawResultOverlay(detection, [], month, day);

      if (solution) {
        const solvedArea = solution.reduce((sum, p) => sum + p.cells.length, 0);
        const occOnTarget = targetCells.filter(([c, r]) => detection.occupied.has(cellKey(c, r))).length;
        const totalCovered = occOnTarget + solvedArea;
        if (totalCovered !== 41) {
          this.statusEl.textContent = `Bad detection: ${occOnTarget}+${solvedArea}=${totalCovered}≠41`;
        } else {
          // Sort solution pieces: upper-left first (by min row desc, then min col asc)
          solution.sort((a, b) => {
            const aMaxR = Math.max(...a.cells.map(([, r]) => r));
            const bMaxR = Math.max(...b.cells.map(([, r]) => r));
            if (aMaxR !== bMaxR) return bMaxR - aMaxR; // higher row = upper on board
            const aMinC = Math.min(...a.cells.map(([c]) => c));
            const bMinC = Math.min(...b.cells.map(([c]) => c));
            return aMinC - bMinC;
          });

          // Store for hint mode
          this._solution = solution;
          this._detection = detection;
          this._hintIndex = 0;
          this._solveMonth = month;
          this._solveDay = day;

          this.hintBtn.classList.remove('hidden');
          this.statusEl.textContent = `Solved! ${solution.length} pieces to place. Tap 💡 Hint`;
        }
      } else {
        this.statusEl.textContent = `No solution found after ${offsets.length} threshold attempts`;
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
   * Draw the solution overlay directly on the captured photo canvas.
   * Uses the detected corners to map grid cells back to photo coordinates.
   */
  _drawResultOverlay(detection, solution, month, day) {
    if (!detection.corners) return;

    const ctx = this.photoCanvas.getContext('2d');
    const [tl, tr, br, bl] = detection.corners;

    const gridToPhoto = (col, row) => {
      const u = col / BOARD_COLS;
      const v = (BOARD_ROWS - 1 - row) / BOARD_ROWS;
      const x = (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] +
                u * v * br[0] + (1 - u) * v * bl[0];
      const y = (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] +
                u * v * br[1] + (1 - u) * v * bl[1];
      return [x, y];
    };

    const fillCell = (c, r, ctx) => {
      const p0 = gridToPhoto(c, r);
      const p1 = gridToPhoto(c + 1, r);
      const p2 = gridToPhoto(c + 1, r - 1);
      const p3 = gridToPhoto(c, r - 1);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
      ctx.fill();
    };

    // Draw detected occupied cells — white wash + solid white borders
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    for (const key of detection.occupied) {
      const [c, r] = key.split(',').map(Number);
      if (isBoardCell(c, r)) fillCell(c, r, ctx);
    }

    // Solid white borders for every occupied cell (all 4 sides)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2.5;
    for (const key of detection.occupied) {
      const [c, r] = key.split(',').map(Number);
      if (!isBoardCell(c, r)) continue;
      const p0 = gridToPhoto(c, r);
      const p1 = gridToPhoto(c + 1, r);
      const p2 = gridToPhoto(c + 1, r - 1);
      const p3 = gridToPhoto(c, r - 1);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
      ctx.stroke();
    }

    // Draw solution pieces on top
    if (solution && solution.length > 0) {
      for (const placement of solution) {
        ctx.fillStyle = placement.color + '99';
        ctx.strokeStyle = placement.color;
        ctx.lineWidth = 3;

        for (const [c, r] of placement.cells) {
          fillCell(c, r, ctx);
        }

        // Draw piece borders (edges not shared with same piece)
        const cellSet = new Set(placement.cells.map(([c, r]) => `${c},${r}`));
        for (const [c, r] of placement.cells) {
          const p0 = gridToPhoto(c, r);
          const p1 = gridToPhoto(c + 1, r);
          const p2 = gridToPhoto(c + 1, r - 1);
          const p3 = gridToPhoto(c, r - 1);

          ctx.beginPath();
          if (!cellSet.has(`${c},${r+1}`)) { ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); }
          if (!cellSet.has(`${c},${r-1}`)) { ctx.moveTo(p3[0], p3[1]); ctx.lineTo(p2[0], p2[1]); }
          if (!cellSet.has(`${c-1},${r}`)) { ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p3[0], p3[1]); }
          if (!cellSet.has(`${c+1},${r}`)) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
          ctx.stroke();
        }
      }
    }
  }

  _showNextHint() {
    if (!this._solution || this._hintIndex >= this._solution.length) return;

    this._hintIndex++;

    // Restore pristine photo
    const pCtx = this.photoCanvas.getContext('2d');
    pCtx.putImageData(this._photoImageData, 0, 0);

    // Redraw occupied cells + revealed hints
    const revealed = this._solution.slice(0, this._hintIndex);
    this._drawResultOverlay(this._detection, revealed, this._solveMonth, this._solveDay);

    const remaining = this._solution.length - this._hintIndex;
    if (remaining > 0) {
      this.statusEl.textContent = `Hint ${this._hintIndex}/${this._solution.length} — ${remaining} more`;
    } else {
      this.statusEl.textContent = `All ${this._solution.length} pieces revealed!`;
      this.hintBtn.classList.add('hidden');
    }
  }

  _retake() {
    this.photoCanvas.classList.add('hidden');
    this.hintBtn.classList.add('hidden');
    document.getElementById('debug-section').classList.add('hidden');
    this._solution = null;
    this._detection = null;
    this._hintIndex = 0;
    this._photoImageData = null;
    this._startCamera();
  }
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());