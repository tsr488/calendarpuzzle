// Automatic board detection and piece recognition using OpenCV.js
// Pieces: two shades of blue with white connecting lines
// Board: light natural wood
import { BOARD_CELLS, BOARD_COLS, BOARD_ROWS, isBoardCell, cellKey, PIECES } from './board.js';
import { solvePuzzle } from './solver.js';

export function waitForOpenCV() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) { resolve(); return; }
    const check = setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error('OpenCV.js load timeout')); }, 30000);
  });
}

/**
 * Detect the puzzle board and classify cells.
 * @param {HTMLCanvasElement} photoCanvas
 * @returns {{ occupied: Set<string>, empty: Set<string>, corners: number[][]|null }}
 */
export function detectBoard(photoCanvas) {
  const src = cv.imread(photoCanvas);
  const result = { occupied: new Set(), empty: new Set(), corners: null };

  try {
    const corners = findBoardCorners(src);
    if (!corners) {
      throw new Error('Could not detect board. Make sure full board is visible.');
    }
    result.corners = corners;

    const cellPx = 60;
    const warpW = BOARD_COLS * cellPx;
    const warpH = BOARD_ROWS * cellPx;
    const warped = warpToGrid(src, corners, warpW, warpH);

    // Gather per-cell color stats (reusable across threshold attempts)
    const cellStats = gatherCellStats(warped, cellPx);
    result.cellStats = cellStats;

    // Classify with default largest-gap threshold
    classifyCellsFromStats(cellStats, result);
    warped.delete();
  } finally {
    src.delete();
  }
  return result;
}

/**
 * Re-classify cells with an adjusted threshold offset.
 * Positive offset = more cells classified as pieces, negative = fewer.
 * Returns a new result object (occupied/empty/cellScores/cellDebug).
 */
export function reclassifyWithOffset(cellStats, offset) {
  const result = { occupied: new Set(), empty: new Set() };
  classifyCellsFromStats(cellStats, result, offset);
  return result;
}

/**
 * Find board corners using multiple strategies:
 * 1. Try contour-based quad detection with varying parameters
 * 2. Fallback to largest contour's minAreaRect
 * 3. Fallback to convex hull of largest contour → best-fit quad
 */
function findBoardCorners(src) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const imgArea = src.rows * src.cols;
  let corners = null;

  // Strategy 1: Try different Canny thresholds and epsilon values
  const cannyParams = [[30, 100], [50, 150], [20, 80], [70, 200]];
  const epsilons = [0.02, 0.03, 0.04, 0.05, 0.06];

  for (const [lo, hi] of cannyParams) {
    if (corners) break;
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, lo, hi);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Sort contours by area descending
    const indexed = [];
    for (let i = 0; i < contours.size(); i++) {
      indexed.push({ idx: i, area: cv.contourArea(contours.get(i)) });
    }
    indexed.sort((a, b) => b.area - a.area);

    for (const { idx, area } of indexed) {
      if (corners) break;
      if (area < imgArea * 0.05) break; // too small

      const contour = contours.get(idx);
      const peri = cv.arcLength(contour, true);

      // Try different epsilon values for polygon approximation
      for (const eps of epsilons) {
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, eps * peri, true);

        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          corners = orderCorners4(approx);
          approx.delete();
          break;
        }
        approx.delete();
      }

      // Strategy 2: If no quad found, use minAreaRect on the contour
      if (!corners && area > imgArea * 0.05) {
        corners = cornersFromMinAreaRect(contour);
      }
    }

    edges.delete(); contours.delete(); hierarchy.delete();
  }

  gray.delete(); blurred.delete();
  return corners;
}

/**
 * Extract 4 ordered corners from a cv.RotatedRect via minAreaRect
 */
function cornersFromMinAreaRect(contour) {
  const rect = cv.minAreaRect(contour);
  const pts = cv.RotatedRect.points(rect);
  // pts is [{x,y}, {x,y}, {x,y}, {x,y}]
  const arr = pts.map(p => [Math.round(p.x), Math.round(p.y)]);
  return orderCornersArray(arr);
}

/**
 * Order 4 points from a cv.Mat as [TL, TR, BR, BL]
 */
function orderCorners4(mat) {
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push([mat.data32S[i * 2], mat.data32S[i * 2 + 1]]);
  }
  return orderCornersArray(pts);
}

/**
 * Order 4 [x,y] points as [TL, TR, BR, BL]
 */
function orderCornersArray(pts) {
  const sumSorted = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const diffSorted = [...pts].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
  return [sumSorted[0], diffSorted[3], sumSorted[3], diffSorted[0]];
}

function warpToGrid(src, corners, dstW, dstH) {
  const [tl, tr, br, bl] = corners;
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, dstW, 0, dstW, dstH, 0, dstH
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH));
  srcPts.delete(); dstPts.delete(); M.delete();
  return warped;
}

/**
 * Gather per-cell color stats from the warped image. 
 * This is the expensive OpenCV part — done once, reused for threshold adjustments.
 */
function gatherCellStats(warped, cellPx) {
  const hsv = new cv.Mat();
  const rgb = new cv.Mat();
  cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

  const cellStats = [];

  for (const [c, r] of BOARD_CELLS) {
    const x = c * cellPx;
    const y = (BOARD_ROWS - 1 - r) * cellPx;
    const margin = Math.floor(cellPx * 0.25);
    const roi = new cv.Rect(x + margin, y + margin, cellPx - margin * 2, cellPx - margin * 2);

    const hsvRoi = hsv.roi(roi);
    const rgbRoi = rgb.roi(roi);

    const hsvChannels = new cv.MatVector();
    cv.split(hsvRoi, hsvChannels);
    const hMean = new cv.Mat(), hStd = new cv.Mat();
    const sMean = new cv.Mat(), sStd = new cv.Mat();
    cv.meanStdDev(hsvChannels.get(0), hMean, hStd);
    cv.meanStdDev(hsvChannels.get(1), sMean, sStd);

    const rgbChannels = new cv.MatVector();
    cv.split(rgbRoi, rgbChannels);
    const rMean = new cv.Mat(), gMean = new cv.Mat(), bMean = new cv.Mat();
    const rStd = new cv.Mat(), gStd = new cv.Mat(), bStd = new cv.Mat();
    cv.meanStdDev(rgbChannels.get(0), rMean, rStd);
    cv.meanStdDev(rgbChannels.get(1), gMean, gStd);
    cv.meanStdDev(rgbChannels.get(2), bMean, bStd);

    const R = rMean.doubleAt(0, 0);
    const G = gMean.doubleAt(0, 0);
    const B = bMean.doubleAt(0, 0);
    const total = R + G + B + 1;

    cellStats.push({
      col: c, row: r,
      hue: hMean.doubleAt(0, 0),
      sat: sMean.doubleAt(0, 0),
      R, G, B,
      blueRatio: B / total,
      warmRatio: R / total,
      blueDominance: B - R,
    });

    hsvRoi.delete(); rgbRoi.delete();
    hsvChannels.get(0).delete(); hsvChannels.get(1).delete(); hsvChannels.get(2).delete(); hsvChannels.delete();
    rgbChannels.get(0).delete(); rgbChannels.get(1).delete(); rgbChannels.get(2).delete(); rgbChannels.delete();
    hMean.delete(); hStd.delete(); sMean.delete(); sStd.delete();
    rMean.delete(); gMean.delete(); bMean.delete(); rStd.delete(); gStd.delete(); bStd.delete();
  }

  hsv.delete(); rgb.delete();
  return cellStats;
}

/**
 * Classify cells from pre-gathered stats. Pure math — no OpenCV needed.
 * @param {object[]} cellStats - from gatherCellStats
 * @param {object} result - will be populated with occupied/empty/cellScores/cellDebug
 * @param {number} thresholdOffset - shift threshold (positive = more pieces, negative = fewer)
 */
function classifyCellsFromStats(cellStats, result, thresholdOffset = 0) {
  const blueDoms = cellStats.map(s => s.blueDominance);
  const blueThreshold = findOtsuThreshold(blueDoms);
  const sats = cellStats.map(s => s.sat);
  const satThreshold = findOtsuThreshold(sats);

  result.cellScores = [];
  result.cellDebug = [];

  const rawScores = [];
  for (const stats of cellStats) {
    const blueScore = (stats.blueDominance - blueThreshold) / 40;
    const satScore = (stats.sat - Math.max(satThreshold, 25)) / 50;
    const hueBonus = (stats.hue > 80 && stats.hue < 140) ? 0.3 : -0.2;
    rawScores.push(blueScore * 0.6 + satScore * 0.3 + hueBonus * 0.1);
  }

  const scoreThreshold = findLargestGapThreshold(rawScores) + thresholdOffset;

  for (let i = 0; i < cellStats.length; i++) {
    const stats = cellStats[i];
    const key = cellKey(stats.col, stats.row);
    const score = rawScores[i];
    const isOccupied = score > scoreThreshold;

    result.cellScores.push({ col: stats.col, row: stats.row, score: score - scoreThreshold, key });
    result.cellDebug.push({
      col: stats.col, row: stats.row, key,
      R: Math.round(stats.R), G: Math.round(stats.G), B: Math.round(stats.B),
      sat: Math.round(stats.sat), hue: Math.round(stats.hue),
      bd: Math.round(stats.blueDominance), score: score.toFixed(2),
      thr: scoreThreshold.toFixed(2),
      cls: isOccupied ? 'P' : 'W',
    });

    if (isOccupied) {
      result.occupied.add(key);
    } else {
      result.empty.add(key);
    }
  }

  result.cellScores.sort((a, b) => Math.abs(a.score) - Math.abs(b.score));
}

function findOtsuThreshold(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 2) return sorted[0] || 0;

  let bestThresh = sorted[0];
  let bestVar = Infinity;

  for (let i = 1; i < n - 1; i++) {
    const left = sorted.slice(0, i);
    const right = sorted.slice(i);
    const lm = left.reduce((a, b) => a + b, 0) / left.length;
    const rm = right.reduce((a, b) => a + b, 0) / right.length;
    const lv = left.reduce((a, b) => a + (b - lm) ** 2, 0) / left.length;
    const rv = right.reduce((a, b) => a + (b - rm) ** 2, 0) / right.length;
    const wv = (left.length * lv + right.length * rv) / n;
    if (wv < bestVar) { bestVar = wv; bestThresh = sorted[i]; }
  }
  return bestThresh;
}

/**
 * Find threshold at the midpoint of the largest gap between sorted values.
 * Works much better than Otsu when clusters are imbalanced (few pieces, many wood).
 */
function findLargestGapThreshold(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 2) return sorted[0] || 0;

  let bestGap = 0;
  let bestMid = sorted[0];

  for (let i = 1; i < n; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (sorted[i] + sorted[i - 1]) / 2;
    }
  }
  return bestMid;
}

/**
 * Identify placed pieces by grouping occupied cells into connected components
 * and using the DLX solver to find which piece(s) exactly cover each group.
 * Handles merged groups (e.g., two adjacent pieces = one 10-cell blob).
 */
export function identifyPlacedPieces(occupied) {
  // 1. Find connected components
  const visited = new Set();
  const components = [];

  for (const key of occupied) {
    if (visited.has(key)) continue;
    const component = [];
    const stack = [key];
    while (stack.length > 0) {
      const k = stack.pop();
      if (visited.has(k)) continue;
      visited.add(k);
      component.push(k);
      const [c, r] = k.split(',').map(Number);
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nk = cellKey(c + dc, r + dr);
        if (occupied.has(nk) && !visited.has(nk)) stack.push(nk);
      }
    }
    components.push(component.map(k => k.split(',').map(Number)));
  }

  // 2. For each component, try to solve it with subsets of pieces
  const usedPieceIndices = new Set();

  for (const coords of components) {
    const size = coords.length;
    if (size < 5) continue; // smaller than any piece, skip (noise)

    // Try all piece subsets whose area matches this component
    const available = PIECES.filter((_, i) => !usedPieceIndices.has(i));
    const result = solveComponent(coords, available, size);
    if (result) {
      for (const idx of result) usedPieceIndices.add(idx);
    }
  }

  return usedPieceIndices;
}

/**
 * Try to find which pieces exactly cover a connected region.
 * Returns array of PIECES indices, or null if no exact cover found.
 */
function solveComponent(cells, available, targetSize) {
  // Try 1 piece, then 2, then 3 (unlikely to have 3+ adjacent)
  for (let n = 1; n <= Math.min(3, available.length); n++) {
    const combos = combinations(available, n);
    for (const subset of combos) {
      const totalArea = subset.reduce((sum, p) => sum + p.coords.length, 0);
      if (totalArea !== targetSize) continue;

      const solution = solvePuzzle(cells, subset);
      if (solution) {
        // Return the PIECES indices of the matched pieces
        return subset.map(p => PIECES.indexOf(p));
      }
    }
  }
  return null;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const results = [];
  const [first, ...rest] = arr;
  for (const combo of combinations(rest, k - 1)) {
    results.push([first, ...combo]);
  }
  for (const combo of combinations(rest, k)) {
    results.push(combo);
  }
  return results;
}

/**
 * Draw debug visualization — per-cell classification grid only
 */
export function drawDebug(debugCanvas, occupied, empty, cellDebug) {
  const ctx = debugCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Draw per-cell debug grid (skip photo + corner overlay)
  if (cellDebug && cellDebug.length > 0) {
    const cellW = 48, cellH = 36;
    const gridW = BOARD_COLS * cellW + 20;
    const gridH = BOARD_ROWS * cellH + 40;

    debugCanvas.width = gridW * dpr;
    debugCanvas.height = gridH * dpr;
    debugCanvas.style.width = gridW + 'px';
    debugCanvas.style.height = gridH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, gridW, gridH);

    // Header
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px monospace';
    const thr = cellDebug[0]?.thr || '?';
    ctx.fillText(`occ:${occupied.size} empty:${empty.size} thr:${thr}`, 10, 14);

    for (const cd of cellDebug) {
      const gx = 10 + cd.col * cellW;
      const gy = 20 + (BOARD_ROWS - 1 - cd.row) * cellH;

      // Background color: blue=piece, tan=wood
      ctx.fillStyle = cd.cls === 'P' ? 'rgba(0,100,255,0.4)' : 'rgba(200,180,140,0.4)';
      ctx.fillRect(gx, gy, cellW - 2, cellH - 2);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx, gy, cellW - 2, cellH - 2);

      // Cell label + classification
      ctx.fillStyle = cd.cls === 'P' ? '#4af' : '#ddd';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${cd.cls} ${cd.score}`, gx + cellW / 2 - 1, gy + 12);
      
      // Blue dominance + saturation
      ctx.font = '8px monospace';
      ctx.fillStyle = '#aaa';
      ctx.fillText(`bd:${cd.bd} s:${cd.sat}`, gx + cellW / 2 - 1, gy + 24);
      ctx.fillText(`${cd.R},${cd.G},${cd.B}`, gx + cellW / 2 - 1, gy + 33);
      ctx.textAlign = 'left';
    }
  }
}