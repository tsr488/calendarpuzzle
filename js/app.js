// Main application — camera capture → auto-detect → solve → overlay
import { PIECES, BOARD_CELLS, getCellsToCover, cellKey, BOARD_COLS, BOARD_ROWS, getCellLabel } from './board.js';
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
      return;
    }

    const detectTime = (performance.now() - t0).toFixed(0);

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

      const totalTime = (performance.now() - t0).toFixed(0);

      // Populate debug canvas (hidden until long-press on status)
      drawDebug(this.debugCanvas, this.photoCanvas, detection.corners, detection.occupied, detection.empty, detection.cellDebug);

      if (solution) {
        const solvedArea = solution.reduce((sum, p) => sum + p.cells.length, 0);
        const occOnTarget = targetCells.filter(([c, r]) => detection.occupied.has(cellKey(c, r))).length;
        const totalCovered = occOnTarget + solvedArea;
        if (totalCovered !== 41) {
          this._drawResultOverlay(detection, [], month, day);
          this.statusEl.textContent = `Bad detection: ${occOnTarget}+${solvedArea}=${totalCovered}≠41 (${totalTime}ms)`;
        } else {
          this._drawResultOverlay(detection, solution, month, day);
          this.statusEl.textContent = `Solved! ${solution.length} pieces placed, ${8-solution.length} detected (${totalTime}ms)`;
        }
      } else {
        const occOnTarget = targetCells.filter(([c, r]) => detection.occupied.has(cellKey(c, r))).length;
        const emptyCount = 41 - occOnTarget;
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `No solution found after ${offsets.length} threshold attempts (${totalTime}ms)`;
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
   * Draw the solution overlay directly on the captured photo.
   * Uses the detected corners to map grid cells back to photo coordinates.
   */
  _drawResultOverlay(detection, solution, month, day) {
    const canvas = this.resultCanvas;
    canvas.classList.remove('hidden');

    const dpr = window.devicePixelRatio || 1;
    const photoW = this.photoCanvas.width;
    const photoH = this.photoCanvas.height;

    canvas.width = photoW;
    canvas.height = photoH;
    canvas.style.width = (photoW / dpr) + 'px';
    canvas.style.height = (photoH / dpr) + 'px';
    const ctx = canvas.getContext('2d');

    // Draw the photo as background
    ctx.drawImage(this.photoCanvas, 0, 0);

    if (!detection.corners || !solution || solution.length === 0) return;

    const [tl, tr, br, bl] = detection.corners;

    // Map a grid cell (col, row) to photo pixel coordinates.
    // Uses bilinear interpolation between the 4 corners.
    const gridToPhoto = (col, row) => {
      // Normalize to 0-1 within the grid
      const u = col / BOARD_COLS;
      const v = (BOARD_ROWS - 1 - row) / BOARD_ROWS;

      // Bilinear interpolation
      const x = (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] +
                u * v * br[0] + (1 - u) * v * bl[0];
      const y = (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] +
                u * v * br[1] + (1 - u) * v * bl[1];
      return [x, y];
    };

    // Draw each solution piece
    for (const placement of solution) {
      ctx.fillStyle = placement.color + '99'; // semi-transparent
      ctx.strokeStyle = placement.color;
      ctx.lineWidth = 3;

      for (const [c, r] of placement.cells) {
        // Get the 4 corners of this cell in photo space
        const p0 = gridToPhoto(c, r);           // top-left of cell
        const p1 = gridToPhoto(c + 1, r);       // top-right
        const p2 = gridToPhoto(c + 1, r - 1);   // bottom-right (row-1 = down visually)
        const p3 = gridToPhoto(c, r - 1);        // bottom-left

        // Fill cell
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.lineTo(p3[0], p3[1]);
        ctx.closePath();
        ctx.fill();
      }

      // Draw piece borders (edges not shared with same piece)
      const cellSet = new Set(placement.cells.map(([c, r]) => `${c},${r}`));
      for (const [c, r] of placement.cells) {
        const p0 = gridToPhoto(c, r);
        const p1 = gridToPhoto(c + 1, r);
        const p2 = gridToPhoto(c + 1, r - 1);
        const p3 = gridToPhoto(c, r - 1);

        ctx.beginPath();
        // Top edge (no neighbor above = r+1)
        if (!cellSet.has(`${c},${r+1}`)) { ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); }
        // Bottom edge (no neighbor below = r-1)
        if (!cellSet.has(`${c},${r-1}`)) { ctx.moveTo(p3[0], p3[1]); ctx.lineTo(p2[0], p2[1]); }
        // Left edge (no neighbor left = c-1)
        if (!cellSet.has(`${c-1},${r}`)) { ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p3[0], p3[1]); }
        // Right edge (no neighbor right = c+1)
        if (!cellSet.has(`${c+1},${r}`)) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
        ctx.stroke();
      }

      // Label piece name at centroid
      const cx = placement.cells.reduce((s, [c]) => s + c, 0) / placement.cells.length;
      const cr = placement.cells.reduce((s, [, r]) => s + r, 0) / placement.cells.length;
      const center = gridToPhoto(cx + 0.5, cr + 0.5);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(placement.name, center[0], center[1]);
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