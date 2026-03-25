// Polyomino puzzle solver — converts calendar puzzle to exact cover and solves via DLX
import { PIECES, cellKey } from './board.js';
import { DLX } from './dlx.js';

// Generate all rotations and reflections of a piece
function generateOrientations(coords) {
  const orientations = [];
  const seen = new Set();

  const normalize = (cs) => {
    const minC = Math.min(...cs.map(([c]) => c));
    const minR = Math.min(...cs.map(([, r]) => r));
    const norm = cs.map(([c, r]) => [c - minC, r - minR]);
    norm.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return norm;
  };

  const key = (cs) => cs.map(([c, r]) => `${c},${r}`).join('|');

  let current = coords.map(([c, r]) => [c, r]);
  for (let flip = 0; flip < 2; flip++) {
    for (let rot = 0; rot < 4; rot++) {
      const norm = normalize(current);
      const k = key(norm);
      if (!seen.has(k)) {
        seen.add(k);
        orientations.push(norm);
      }
      // Rotate 90 degrees: (c, r) -> (-r, c)
      current = current.map(([c, r]) => [-r, c]);
    }
    // Reflect: (c, r) -> (-c, r)
    current = coords.map(([c, r]) => [-c, r]);
  }
  return orientations;
}

// Generate all valid placements of a piece orientation on a region
function generatePlacements(orientation, regionSet, regionCells) {
  const placements = [];
  const maxCol = Math.max(...regionCells.map(([c]) => c));
  const maxRow = Math.max(...regionCells.map(([, r]) => r));

  for (let dc = -3; dc <= maxCol; dc++) {
    for (let dr = -3; dr <= maxRow; dr++) {
      const placed = orientation.map(([c, r]) => [c + dc, r + dr]);
      if (placed.every(([c, r]) => regionSet.has(cellKey(c, r)))) {
        placements.push(placed);
      }
    }
  }
  return placements;
}

/**
 * Solve the puzzle.
 * @param {number[][]} regionCells - cells that must be covered
 * @param {object[]} pieces - pieces to use (subset of PIECES)
 * @returns {object[]|null} - array of { pieceId, cells } or null if no solution
 */
export function solvePuzzle(regionCells, pieces = PIECES) {
  const regionSet = new Set(regionCells.map(([c, r]) => cellKey(c, r)));
  const numPieces = pieces.length;
  const numCells = regionCells.length;
  const totalCols = numPieces + numCells;

  // Build cell index map
  const cellIndexMap = new Map();
  regionCells.forEach(([c, r], i) => cellIndexMap.set(cellKey(c, r), i));

  // Generate all rows (one per valid placement of each piece orientation)
  const rows = [];
  const rowMeta = []; // { pieceIndex, cells }

  pieces.forEach((piece, pieceIndex) => {
    const orientations = generateOrientations(piece.coords);
    for (const orient of orientations) {
      const placements = generatePlacements(orient, regionSet, regionCells);
      for (const placed of placements) {
        const row = new Array(totalCols).fill(0);
        row[pieceIndex] = 1; // piece column

        let valid = true;
        for (const [c, r] of placed) {
          const idx = cellIndexMap.get(cellKey(c, r));
          if (idx === undefined) { valid = false; break; }
          row[numPieces + idx] = 1;
        }
        if (valid) {
          rows.push(row);
          rowMeta.push({ pieceIndex, cells: placed });
        }
      }
    }
  });

  // Solve with DLX
  if (rows.length === 0) return null;
  const dlx = new DLX(rows);
  const found = dlx.solve();

  if (!found) return null;

  const solutionRows = dlx.getSolution();
  return solutionRows.map(rowIdx => ({
    pieceId: pieces[rowMeta[rowIdx].pieceIndex].id,
    pieceIndex: rowMeta[rowIdx].pieceIndex,
    color: pieces[rowMeta[rowIdx].pieceIndex].color,
    name: pieces[rowMeta[rowIdx].pieceIndex].name,
    cells: rowMeta[rowIdx].cells,
  }));
}