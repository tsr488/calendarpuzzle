// Board model for the Daily Puzzle Challenge Perpetual Calendar
// Grid layout extracted from jimmckeeth/calendar-polyomino-solver (MIT licensed)

export const BOARD_CELLS = [
  [0,6],[1,6],[2,6],[3,6],[4,6],[5,6],
  [0,5],[1,5],[2,5],[3,5],[4,5],[5,5],
  [0,4],[1,4],[2,4],[3,4],[4,4],[5,4],[6,4],
  [0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3],
  [0,2],[1,2],[2,2],[3,2],[4,2],[5,2],[6,2],
  [0,1],[1,1],[2,1],[3,1],[4,1],[5,1],[6,1],
  [0,0],[1,0],[2,0],
];

export const MONTH_CELLS = {
  1:[0,6], 2:[1,6], 3:[2,6], 4:[3,6], 5:[4,6], 6:[5,6],
  7:[0,5], 8:[1,5], 9:[2,5], 10:[3,5], 11:[4,5], 12:[5,5],
};

export const DAY_CELLS = {};
for (let d = 1; d <= 7; d++)   DAY_CELLS[d] = [d - 1, 4];
for (let d = 8; d <= 14; d++)  DAY_CELLS[d] = [d - 8, 3];
for (let d = 15; d <= 21; d++) DAY_CELLS[d] = [d - 15, 2];
for (let d = 22; d <= 28; d++) DAY_CELLS[d] = [d - 22, 1];
for (let d = 29; d <= 31; d++) DAY_CELLS[d] = [d - 29, 0];

const MONTH_NAMES = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

export function getCellLabel(col, row) {
  for (const [m, [c, r]] of Object.entries(MONTH_CELLS)) {
    if (c === col && r === row) return MONTH_NAMES[parseInt(m)];
  }
  for (const [d, [c, r]] of Object.entries(DAY_CELLS)) {
    if (c === col && r === row) return d.toString();
  }
  return '';
}

// 8 puzzle pieces: 7 pentominoes + 1 hexomino
export const PIECES = [
  { id: 0, name: 'L',  color: '#e74c3c', coords: [[0,2],[0,1],[0,0],[1,2],[2,2]] },
  { id: 1, name: 'J',  color: '#3498db', coords: [[0,3],[0,2],[0,1],[1,3],[0,0]] },
  { id: 2, name: 'S',  color: '#2ecc71', coords: [[1,2],[0,2],[1,1],[1,0],[2,0]] },
  { id: 3, name: 'U',  color: '#f39c12', coords: [[1,2],[1,1],[1,0],[0,0],[0,2]] },
  { id: 4, name: 'Z',  color: '#9b59b6', coords: [[0,3],[0,2],[1,2],[1,1],[1,0]] },
  { id: 5, name: 'T',  color: '#1abc9c', coords: [[0,2],[0,1],[1,1],[1,0],[1,2]] },
  { id: 6, name: 'I',  color: '#e67e22', coords: [[0,3],[0,2],[1,1],[0,1],[0,0]] },
  { id: 7, name: 'P',  color: '#c0392b', coords: [[0,2],[0,1],[1,1],[1,0],[1,2],[0,0]] },
];

export function getCellsToCover(month, day) {
  const monthCell = MONTH_CELLS[month];
  const dayCell = DAY_CELLS[day];
  if (!monthCell || !dayCell) return null;
  return BOARD_CELLS.filter(([c, r]) => {
    if (c === monthCell[0] && r === monthCell[1]) return false;
    if (c === dayCell[0] && r === dayCell[1]) return false;
    return true;
  });
}

export function cellKey(col, row) { return `${col},${row}`; }
export const BOARD_COLS = 7;
export const BOARD_ROWS = 7;

export function isBoardCell(col, row) {
  return BOARD_CELLS.some(([c, r]) => c === col && r === row);
}