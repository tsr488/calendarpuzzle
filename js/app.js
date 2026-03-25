// Main application controller
import { PIECES, getCellsToCover, MONTH_NAMES } from './board.js';
import { solvePuzzle } from './solver.js';
import { BoardRenderer } from './renderer.js';

class App {
  constructor() {
    this.renderer = null;
    this.currentMonth = new Date().getMonth() + 1;
    this.currentDay = new Date().getDate();
    this.solution = null;
    this.solving = false;
  }

  init() {
    const canvas = document.getElementById('puzzle-canvas');
    this.renderer = new BoardRenderer(canvas);

    // Date selectors
    this.monthSelect = document.getElementById('month-select');
    this.daySelect = document.getElementById('day-select');
    this.solveBtn = document.getElementById('solve-btn');
    this.statusEl = document.getElementById('status');
    this.todayBtn = document.getElementById('today-btn');

    // Populate month selector
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = MONTH_NAMES[m];
      if (m === this.currentMonth) opt.selected = true;
      this.monthSelect.appendChild(opt);
    }

    // Populate day selector
    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      if (d === this.currentDay) opt.selected = true;
      this.daySelect.appendChild(opt);
    }

    // Event listeners
    this.solveBtn.addEventListener('click', () => this.solve());
    this.todayBtn.addEventListener('click', () => this.setToday());
    this.monthSelect.addEventListener('change', () => this.onDateChange());
    this.daySelect.addEventListener('change', () => this.onDateChange());

    // Initial draw
    this.onDateChange();

    // Auto-solve for today on load
    this.solve();
  }

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

    // Use setTimeout to allow UI to update before blocking solver runs
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