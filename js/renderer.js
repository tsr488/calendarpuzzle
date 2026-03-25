// Board renderer — draws the puzzle board and solution overlay on a canvas
import { BOARD_CELLS, BOARD_COLS, BOARD_ROWS, isBoardCell, getCellLabel, MONTH_CELLS, DAY_CELLS } from './board.js';

const CELL_SIZE = 48;
const PADDING = 2;
const BORDER_RADIUS = 4;

export class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cellSize = CELL_SIZE;
    this.offsetX = 10;
    this.offsetY = 10;
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = (BOARD_COLS * this.cellSize + this.offsetX * 2);
    const h = (BOARD_ROWS * this.cellSize + this.offsetY * 2);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Convert grid coords to pixel coords (row 6 = top visually)
  _cellToPixel(col, row) {
    const x = this.offsetX + col * this.cellSize;
    const y = this.offsetY + (BOARD_ROWS - 1 - row) * this.cellSize;
    return [x, y];
  }

  clear() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
  }

  drawBoard(month, day) {
    this.clear();
    const ctx = this.ctx;
    const s = this.cellSize;
    const p = PADDING;

    const monthCell = MONTH_CELLS[month];
    const dayCell = DAY_CELLS[day];

    for (const [c, r] of BOARD_CELLS) {
      const [x, y] = this._cellToPixel(c, r);
      const isExposed = (monthCell && c === monthCell[0] && r === monthCell[1]) ||
                        (dayCell && c === dayCell[0] && r === dayCell[1]);

      ctx.fillStyle = isExposed ? '#fff3cd' : '#f5f0e8';
      ctx.strokeStyle = '#c4b998';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(x + p, y + p, s - p * 2, s - p * 2, BORDER_RADIUS);
      ctx.fill();
      ctx.stroke();

      // Label
      const label = getCellLabel(c, r);
      ctx.fillStyle = isExposed ? '#d63384' : '#6c757d';
      ctx.font = isExposed ? 'bold 14px system-ui' : '12px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + s / 2, y + s / 2);
    }
  }

  drawSolution(solution, month, day) {
    this.drawBoard(month, day);
    const ctx = this.ctx;
    const s = this.cellSize;
    const p = PADDING;

    if (!solution) return;

    for (const placement of solution) {
      ctx.fillStyle = placement.color + 'cc'; // semi-transparent
      for (const [c, r] of placement.cells) {
        const [x, y] = this._cellToPixel(c, r);
        ctx.beginPath();
        ctx.roundRect(x + p, y + p, s - p * 2, s - p * 2, BORDER_RADIUS);
        ctx.fill();
      }

      // Draw piece borders between non-adjacent cells of the same piece
      ctx.strokeStyle = placement.color;
      ctx.lineWidth = 2;
      const cellSet = new Set(placement.cells.map(([c, r]) => `${c},${r}`));
      for (const [c, r] of placement.cells) {
        const [x, y] = this._cellToPixel(c, r);
        // Draw outer edges where neighbor is not same piece
        if (!cellSet.has(`${c},${r+1}`)) { ctx.beginPath(); ctx.moveTo(x+p, y+p); ctx.lineTo(x+s-p, y+p); ctx.stroke(); }
        if (!cellSet.has(`${c},${r-1}`)) { ctx.beginPath(); ctx.moveTo(x+p, y+s-p); ctx.lineTo(x+s-p, y+s-p); ctx.stroke(); }
        if (!cellSet.has(`${c-1},${r}`)) { ctx.beginPath(); ctx.moveTo(x+p, y+p); ctx.lineTo(x+p, y+s-p); ctx.stroke(); }
        if (!cellSet.has(`${c+1},${r}`)) { ctx.beginPath(); ctx.moveTo(x+s-p, y+p); ctx.lineTo(x+s-p, y+s-p); ctx.stroke(); }
      }
    }
  }
}