// Main application controller
import { PIECES, getCellsToCover, MONTH_NAMES } from './board.js';
import { solvePuzzle } from './solver.js';
import { BoardRenderer } from './renderer.js';
import { Camera } from './camera.js';
import { CvPipeline } from './cv-pipeline.js';

class App {
  constructor() {
    this.renderer = null;
    this.currentMonth = new Date().getMonth() + 1;
    this.currentDay = new Date().getDate();
    this.solution = null;
    this.solving = false;
    this.camera = null;
    this.cvPipeline = null;
  }

  init() {
    // --- Quick Solve ---
    const canvas = document.getElementById('puzzle-canvas');
    this.renderer = new BoardRenderer(canvas);

    this.monthSelect = document.getElementById('month-select');
    this.daySelect = document.getElementById('day-select');
    this.solveBtn = document.getElementById('solve-btn');
    this.statusEl = document.getElementById('status');
    this.todayBtn = document.getElementById('today-btn');

    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = MONTH_NAMES[m];
      if (m === this.currentMonth) opt.selected = true;
      this.monthSelect.appendChild(opt);
    }

    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      if (d === this.currentDay) opt.selected = true;
      this.daySelect.appendChild(opt);
    }

    this.solveBtn.addEventListener('click', () => this.solve());
    this.todayBtn.addEventListener('click', () => this.setToday());
    this.monthSelect.addEventListener('change', () => this.onDateChange());
    this.daySelect.addEventListener('change', () => this.onDateChange());

    this.onDateChange();
    this.solve();

    // --- Tab switching ---
    this._initTabs();

    // --- Camera Assist ---
    this._initCameraAssist();
  }

  // ─── Tab management ────────────────────────────────────
  _initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const viewId = tab.dataset.tab;
        document.getElementById(viewId).classList.add('active');
        // Stop camera when switching away
        if (viewId !== 'camera-assist' && this.camera && this.camera.isActive()) {
          this._stopCamera();
        }
      });
    });
  }

  // ─── Camera Assist ─────────────────────────────────────
  _initCameraAssist() {
    const videoEl = document.getElementById('camera-video');
    const photoCanvas = document.getElementById('photo-canvas');
    const overlayCanvas = document.getElementById('grid-overlay');
    const gridSection = document.getElementById('grid-overlay-section');

    this.camera = new Camera(videoEl, photoCanvas);
    this.cvPipeline = new CvPipeline(overlayCanvas, photoCanvas);

    this.cameraStatusEl = document.getElementById('camera-status');
    this.cameraStartBtn = document.getElementById('camera-start-btn');
    this.cameraCaptureBtn = document.getElementById('camera-capture-btn');
    this.cameraStopBtn = document.getElementById('camera-stop-btn');
    this.overlaySolveBtn = document.getElementById('overlay-solve-btn');
    this.overlayResetBtn = document.getElementById('overlay-reset-btn');

    // Build color picker
    this._buildColorPicker();

    // Camera buttons
    this.cameraStartBtn.addEventListener('click', () => this._startCamera());
    this.cameraCaptureBtn.addEventListener('click', () => this._capturePhoto());
    this.cameraStopBtn.addEventListener('click', () => this._stopCamera());

    // Overlay buttons
    this.overlaySolveBtn.addEventListener('click', () => this._solveRemaining());
    this.overlayResetBtn.addEventListener('click', () => {
      this.cvPipeline.reset();
      this.cameraStatusEl.textContent = '';
    });
  }

  _buildColorPicker() {
    const picker = document.querySelector('.color-picker');
    PIECES.forEach((piece, i) => {
      const btn = document.createElement('button');
      btn.className = 'color-swatch' + (i === 0 ? ' active' : '');
      btn.style.background = piece.color;
      btn.textContent = piece.name;
      btn.dataset.index = i;
      btn.addEventListener('click', () => {
        picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        this.cvPipeline.setColor(i);
      });
      picker.appendChild(btn);
    });
  }

  async _startCamera() {
    try {
      this.cameraStatusEl.textContent = 'Starting camera...';
      await this.camera.start();
      this.cameraStartBtn.disabled = true;
      this.cameraCaptureBtn.disabled = false;
      this.cameraStopBtn.disabled = false;
      this.cameraStatusEl.textContent = 'Camera ready — point at the puzzle board';
    } catch (err) {
      this.cameraStatusEl.textContent = 'Camera error: ' + (err.message || 'Access denied');
    }
  }

  _capturePhoto() {
    const result = this.camera.capture();
    if (!result) return;

    // Show the captured photo
    const photoCanvas = document.getElementById('photo-canvas');
    photoCanvas.classList.remove('hidden');
    // Set display size to fit
    const maxW = Math.min(400, window.innerWidth - 32);
    const aspect = result.height / result.width;
    photoCanvas.style.width = maxW + 'px';
    photoCanvas.style.height = Math.round(maxW * aspect) + 'px';

    // Stop camera after capture
    this._stopCamera();

    // Show grid overlay
    const gridSection = document.getElementById('grid-overlay-section');
    gridSection.classList.remove('hidden');
    this.cvPipeline.layout(maxW);
    this.cvPipeline.startInteraction();
    this.cameraStatusEl.textContent = 'Tap cells occupied by pieces, then solve';
  }

  _stopCamera() {
    this.camera.stop();
    this.cameraStartBtn.disabled = false;
    this.cameraCaptureBtn.disabled = true;
    this.cameraStopBtn.disabled = true;
  }

  _solveRemaining() {
    if (this.solving) return;

    const unmarked = this.cvPipeline.getUnmarkedCells();
    const remainingPieces = this.cvPipeline.getRemainingPieces();

    if (unmarked.length === 0) {
      this.cameraStatusEl.textContent = 'All cells are marked — nothing to solve';
      return;
    }

    if (remainingPieces.length === 0) {
      this.cameraStatusEl.textContent = 'All pieces are used — nothing to solve';
      return;
    }

    this.solving = true;
    this.overlaySolveBtn.disabled = true;
    this.cameraStatusEl.textContent = 'Solving...';

    setTimeout(() => {
      const t0 = performance.now();
      const solution = solvePuzzle(unmarked, remainingPieces);
      const elapsed = (performance.now() - t0).toFixed(1);

      this.solving = false;
      this.overlaySolveBtn.disabled = false;

      if (solution) {
        this.cvPipeline.drawSolution(solution);
        this.cameraStatusEl.textContent = `Solved in ${elapsed}ms — ${remainingPieces.length} pieces placed`;
      } else {
        this.cameraStatusEl.textContent = `No solution found (${elapsed}ms) — check marked cells`;
      }
    }, 20);
  }

  // ─── Quick Solve (existing) ────────────────────────────
  setToday() {
    const now = new Date();
    this.monthSelect.value = now.getMonth() + 1;
    this.daySelect.value = now.getDate();
    this.onDateChange();
    this.solve();
  }

  onDateChange() {
    this.currentMonth = parseInt(this.monthSelect.value);
    this.currentDay = parseInt(this.daySelect.value);
    this.solution = null;
    this.renderer.drawBoard(this.currentMonth, this.currentDay);
    this.statusEl.textContent = '';
  }

  solve() {
    if (this.solving) return;

    const month = this.currentMonth;
    const day = this.currentDay;
    const cellsToCover = getCellsToCover(month, day);

    if (!cellsToCover) {
      this.statusEl.textContent = 'Invalid date';
      return;
    }

    this.solving = true;
    this.solveBtn.disabled = true;
    this.statusEl.textContent = 'Solving...';

    setTimeout(() => {
      const t0 = performance.now();
      const solution = solvePuzzle(cellsToCover, PIECES);
      const elapsed = (performance.now() - t0).toFixed(1);

      this.solving = false;
      this.solveBtn.disabled = false;

      if (solution) {
        this.solution = solution;
        this.renderer.drawSolution(solution, month, day);
        this.statusEl.textContent = `Solved in ${elapsed}ms`;
      } else {
        this.statusEl.textContent = `No solution found (${elapsed}ms)`;
        this.renderer.drawBoard(month, day);
      }
    }, 20);
  }
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());