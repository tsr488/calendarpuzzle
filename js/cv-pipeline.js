// Semi-automatic CV pipeline — interactive grid overlay for marking occupied cells
import { BOARD_CELLS, BOARD_COLS, BOARD_ROWS, isBoardCell, getCellLabel, PIECES, cellKey } from './board.js';

export class CvPipeline {
  /**
   * @param {HTMLCanvasElement} overlayCanvas — canvas drawn on top of the captured photo
   * @param {HTMLCanvasElement} photoCanvas   — canvas holding the captured photo
   */
  constructor(overlayCanvas, photoCanvas) {
    this.overlay = overlayCanvas;
    this.photo = photoCanvas;
    this.octx = overlayCanvas.getContext('2d');
    this.cellSize = 44;
    this.offsetX = 0;
    this.offsetY = 0;
    // Map of "col,row" → piece color index (0..7) or -1 for generic occupied
    this.markedCells = new Map();
    this.currentColor = 0; // index into PIECES for the color being painted
    this._boundPointerHandler = null;
  }

  /** Fit the grid overlay to the canvas size */
  layout(containerWidth) {
    const maxCellSize = Math.floor((containerWidth - 20) / BOARD_COLS);
    this.cellSize = Math.min(maxCellSize, 52);
    const gridW = BOARD_COLS * this.cellSize;
    const gridH = BOARD_ROWS * this.cellSize;
    this.offsetX = Math.floor((containerWidth - gridW) / 2);
    this.offsetY = 10;

    const totalH = gridH + this.offsetY * 2;
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = containerWidth * dpr;
    this.overlay.height = totalH * dpr;
    this.overlay.style.width = containerWidth + 'px';
    this.overlay.style.height = totalH + 'px';
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Convert pixel position to grid cell [col, row] or null */
  _hitTest(px, py) {
    const col = Math.floor((px - this.offsetX) / this.cellSize);
    const row = BOARD_ROWS - 1 - Math.floor((py - this.offsetY) / this.cellSize);
    if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return null;
    if (!isBoardCell(col, row)) return null;
    return [col, row];
  }

  /** Start interactive cell-marking mode */
  startInteraction() {
    this.markedCells.clear();
    this._boundPointerHandler = (e) => this._onPointer(e);
    this.overlay.addEventListener('pointerdown', this._boundPointerHandler);
    this.draw();
  }

  stopInteraction() {
    if (this._boundPointerHandler) {
      this.overlay.removeEventListener('pointerdown', this._boundPointerHandler);
      this._boundPointerHandler = null;
    }
  }

  _onPointer(e) {
    const rect = this.overlay.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const cell = this._hitTest(px, py);
    if (!cell) return;
    const key = cellKey(cell[0], cell[1]);

    if (this.markedCells.has(key)) {
      this.markedCells.delete(key);
    } else {
      this.markedCells.set(key, this.currentColor);
    }
    this.draw();
    // Fire custom event so app can react
    this.overlay.dispatchEvent(new CustomEvent('cellchange', { detail: { markedCells: this.markedCells } }));
  }

  setColor(colorIndex) {
    this.currentColor = colorIndex;
  }

  /** Draw the grid overlay */
  draw() {
    const ctx = this.octx;
    const s = this.cellSize;
    const p = 2;

    // Clear
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

    for (const [c, r] of BOARD_CELLS) {
      const x = this.offsetX + c * s;
      const y = this.offsetY + (BOARD_ROWS - 1 - r) * s;
      const key = cellKey(c, r);
      const isMarked = this.markedCells.has(key);

      if (isMarked) {
        const colorIdx = this.markedCells.get(key);
        ctx.fillStyle = PIECES[colorIdx].color + 'cc';
      } else {
        ctx.fillStyle = 'rgba(245, 240, 232, 0.3)';
      }
      ctx.strokeStyle = isMarked ? PIECES[this.markedCells.get(key)].color : 'rgba(196, 185, 152, 0.7)';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(x + p, y + p, s - p * 2, s - p * 2, 4);
      ctx.fill();
      ctx.stroke();

      // Label
      const label = getCellLabel(c, r);
      ctx.fillStyle = isMarked ? '#fff' : 'rgba(255,255,255,0.8)';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + s / 2, y + s / 2);
    }
  }

  /** Get list of cells NOT marked (i.e., cells that still need to be covered by remaining pieces) */
  getUnmarkedCells() {
    return BOARD_CELLS.filter(([c, r]) => !this.markedCells.has(cellKey(c, r)));
  }

  /** Get list of cells that ARE marked */
  getMarkedCells() {
    const result = [];
    for (const [key, colorIdx] of this.markedCells.entries()) {
      const [c, r] = key.split(',').map(Number);
      result.push({ col: c, row: r, colorIndex: colorIdx });
    }
    return result;
  }

  /**
   * Figure out which pieces have been placed based on marked cells.
   * Returns array of piece indices that appear to be used.
   */
  getUsedPieceIndices() {
    const usedColors = new Set();
    for (const colorIdx of this.markedCells.values()) {
      usedColors.add(colorIdx);
    }
    return [...usedColors];
  }

  /**
   * Get the pieces still available (not placed on the board).
   * @returns {object[]} array of PIECES entries
   */
  getRemainingPieces() {
    const used = new Set(this.getUsedPieceIndices());
    return PIECES.filter((_, i) => !used.has(i));
  }

  /** Draw the solution overlay on top of the grid for remaining pieces */
  drawSolution(solution) {
    // Redraw base grid first
    this.draw();
    if (!solution) return;

    const ctx = this.octx;
    const s = this.cellSize;
    const p = 2;

    for (const placement of solution) {
      ctx.fillStyle = placement.color + 'cc';
      for (const [c, r] of placement.cells) {
        const x = this.offsetX + c * s;
        const y = this.offsetY + (BOARD_ROWS - 1 - r) * s;
        ctx.beginPath();
        ctx.roundRect(x + p, y + p, s - p * 2, s - p * 2, 4);
        ctx.fill();
      }

      // Piece borders
      ctx.strokeStyle = placement.color;
      ctx.lineWidth = 2;
      const cellSet = new Set(placement.cells.map(([c, r]) => `${c},${r}`));
      for (const [c, r] of placement.cells) {
        const x = this.offsetX + c * s;
        const y = this.offsetY + (BOARD_ROWS - 1 - r) * s;
        if (!cellSet.has(`${c},${r + 1}`)) { ctx.beginPath(); ctx.moveTo(x + p, y + p); ctx.lineTo(x + s - p, y + p); ctx.stroke(); }
        if (!cellSet.has(`${c},${r - 1}`)) { ctx.beginPath(); ctx.moveTo(x + p, y + s - p); ctx.lineTo(x + s - p, y + s - p); ctx.stroke(); }
        if (!cellSet.has(`${c - 1},${r}`)) { ctx.beginPath(); ctx.moveTo(x + p, y + p); ctx.lineTo(x + p, y + s - p); ctx.stroke(); }
        if (!cellSet.has(`${c + 1},${r}`)) { ctx.beginPath(); ctx.moveTo(x + s - p, y + p); ctx.lineTo(x + s - p, y + s - p); ctx.stroke(); }
      }
    }
  }

  reset() {
    this.markedCells.clear();
    this.draw();
  }
}
