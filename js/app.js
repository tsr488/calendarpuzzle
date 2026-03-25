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
    drawDebug(this.debugCanvas, this.photoCanvas, detection.corners, detection.occupied, detection.empty);

    try {
      // 2. Use today's date to know which 2 cells SHOULD be empty
      const today = new Date();
      const month = today.getMonth() + 1;
      const day = today.getDate();
      const targetCells = getCellsToCover(month, day);

      if (!targetCells) {
        this.statusEl.textContent = 'Invalid date';
        this.solving = false;
        return;
      }

      // 3. Figure out which pieces are already placed
      const usedPieceIndices = identifyPlacedPieces(detection.occupied);
      const remainingPieces = PIECES.filter((_, i) => !usedPieceIndices.has(i));

      // 4. The cells that still need covering = target cells minus already-occupied cells
      const stillNeedCovering = targetCells.filter(([c, r]) => !detection.occupied.has(cellKey(c, r)));

      if (stillNeedCovering.length === 0) {
        this._drawResultOverlay(detection, [], month, day);
        this.statusEl.textContent = `Puzzle already solved! (detected in ${detectTime}ms)`;
        this.solving = false;
        return;
      }

      // 5. Solve remaining
      this.statusEl.textContent = 'Solving...';
      const t1 = performance.now();
      const solution = solvePuzzle(stillNeedCovering, remainingPieces);
      const solveTime = (performance.now() - t1).toFixed(0);
      const totalTime = (performance.now() - t0).toFixed(0);

      if (solution) {
        this._drawResultOverlay(detection, solution, month, day);
        const nPlaced = usedPieceIndices.size;
        const nRemaining = remainingPieces.length;
        this.statusEl.textContent = `Found ${nPlaced} placed, solved ${nRemaining} remaining (${totalTime}ms)`;
      } else {
        this.statusEl.textContent = `No solution found — try recapturing (${totalTime}ms)`;
      }
    } catch (err) {
      console.error('Detection error:', err);
      this.statusEl.textContent = 'Detection failed: ' + err.message;
    }

    this.solving = false;
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