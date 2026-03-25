// Automatic board detection and piece recognition using OpenCV.js
// Pieces: two shades of blue with white connecting lines
// Board: light natural wood
import { BOARD_CELLS, BOARD_COLS, BOARD_ROWS, isBoardCell, cellKey, PIECES } from './board.js';

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
      throw new Error('Could not detect board — try a clearer photo with the full board visible');
    }
    result.corners = corners;

    const cellPx = 60;
    const warpW = BOARD_COLS * cellPx;
    const warpH = BOARD_ROWS * cellPx;
    const warped = warpToGrid(src, corners, warpW, warpH);

    classifyCells(warped, cellPx, result);
    warped.delete();
  } finally {
    src.delete();
  }
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
 * Classify cells as occupied (piece) or empty (wood).
 * 
 * The puzzle has BLUE pieces on LIGHT WOOD.
 * Returns per-cell confidence scores so the solver can try flipping borderline cells.
 */
function classifyCells(warped, cellPx, result) {
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

    // HSV channels
    const hsvChannels = new cv.MatVector();
    cv.split(hsvRoi, hsvChannels);
    const hMean = new cv.Mat(), hStd = new cv.Mat();
    const sMean = new cv.Mat(), sStd = new cv.Mat();
    cv.meanStdDev(hsvChannels.get(0), hMean, hStd);
    cv.meanStdDev(hsvChannels.get(1), sMean, sStd);

    // RGB channels — blue ratio is the key signal
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
    const total = R + G + B + 1; // +1 to avoid div by zero

    cellStats.push({
      col: c, row: r,
      hue: hMean.doubleAt(0, 0),
      sat: sMean.doubleAt(0, 0),
      R, G, B,
      blueRatio: B / total,       // high for blue pieces
      warmRatio: R / total,        // high for wood
      blueDominance: B - R,        // positive = blue piece, negative = wood
    });

    hsvRoi.delete(); rgbRoi.delete();
    hsvChannels.get(0).delete(); hsvChannels.get(1).delete(); hsvChannels.get(2).delete(); hsvChannels.delete();
    rgbChannels.get(0).delete(); rgbChannels.get(1).delete(); rgbChannels.get(2).delete(); rgbChannels.delete();
    hMean.delete(); hStd.delete(); sMean.delete(); sStd.delete();
    rMean.delete(); gMean.delete(); bMean.delete(); rStd.delete(); gStd.delete(); bStd.delete();
  }

  // Use blue dominance (B - R) as primary signal with Otsu split
  const blueDoms = cellStats.map(s => s.blueDominance);
  const blueThreshold = findOtsuThreshold(blueDoms);

  // Also compute saturation threshold as secondary signal
  const sats = cellStats.map(s => s.sat);
  const satThreshold = findOtsuThreshold(sats);

  result.cellScores = [];
  result.cellDebug = []; // detailed per-cell debug info

  // First pass: compute raw scores
  const rawScores = [];
  for (const stats of cellStats) {
    // Primary: blue dominance (B - R) relative to threshold
    const blueScore = (stats.blueDominance - blueThreshold) / 40;
    // Secondary: saturation
    const satScore = (stats.sat - Math.max(satThreshold, 25)) / 50;
    // Blue hue confirmation
    const hueBonus = (stats.hue > 80 && stats.hue < 140) ? 0.3 : -0.2;

    const score = blueScore * 0.6 + satScore * 0.3 + hueBonus * 0.1;
    rawScores.push(score);
  }

  // Adaptive threshold on the composite scores themselves
  const scoreThreshold = findOtsuThreshold(rawScores);

  for (let i = 0; i < cellStats.length; i++) {
    const stats = cellStats[i];
    const key = cellKey(stats.col, stats.row);
    const score = rawScores[i];

    // Classify relative to Otsu threshold of scores (not fixed 0)
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
    } else {
      result.empty.add(key);
    }
  }

  // Sort by absolute score so borderline cells come first
  result.cellScores.sort((a, b) => Math.abs(a.score) - Math.abs(b.score));

  hsv.delete(); rgb.delete();
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
 * Identify placed pieces by grouping occupied cells into connected components
 * and matching against known piece shapes.
 */
export function identifyPlacedPieces(occupied) {
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
    components.push(component);
  }

  const usedPieceIndices = new Set();
  for (const comp of components) {
    const coords = comp.map(k => k.split(',').map(Number));
    const matchIdx = matchPieceShape(coords, usedPieceIndices);
    if (matchIdx !== -1) usedPieceIndices.add(matchIdx);
  }
  return usedPieceIndices;
}

function matchPieceShape(coords, excludeIndices) {
  const norm = normalizeCoords(coords);
  const key = coordsKey(norm);

  for (let i = 0; i < PIECES.length; i++) {
    if (excludeIndices.has(i)) continue;
    const orientations = generateAllOrientations(PIECES[i].coords);
    for (const orient of orientations) {
      if (coordsKey(orient) === key) return i;
    }
  }
  return -1;
}

function normalizeCoords(coords) {
  const minC = Math.min(...coords.map(([c]) => c));
  const minR = Math.min(...coords.map(([, r]) => r));
  const norm = coords.map(([c, r]) => [c - minC, r - minR]);
  norm.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return norm;
}

function coordsKey(coords) {
  return coords.map(([c, r]) => `${c},${r}`).join('|');
}

function generateAllOrientations(coords) {
  const results = [];
  const seen = new Set();
  let current = coords.map(([c, r]) => [c, r]);
  for (let flip = 0; flip < 2; flip++) {
    for (let rot = 0; rot < 4; rot++) {
      const norm = normalizeCoords(current);
      const k = coordsKey(norm);
      if (!seen.has(k)) { seen.add(k); results.push(norm); }
      current = current.map(([c, r]) => [-r, c]);
    }
    current = coords.map(([c, r]) => [-c, r]);
  }
  return results;
}

/**
 * Draw debug visualization — board corners + per-cell classification grid
 */
export function drawDebug(debugCanvas, photoCanvas, corners, occupied, empty, cellDebug) {
  const ctx = debugCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  debugCanvas.width = photoCanvas.width;
  debugCanvas.height = photoCanvas.height;
  debugCanvas.style.width = (photoCanvas.width / dpr) + 'px';
  debugCanvas.style.height = (photoCanvas.height / dpr) + 'px';
  ctx.drawImage(photoCanvas, 0, 0);

  if (corners) {
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();

    // Label corners
    const labels = ['TL', 'TR', 'BR', 'BL'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = '#f00';
      ctx.beginPath();
      ctx.arc(corners[i][0], corners[i][1], 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(labels[i], corners[i][0] + 14, corners[i][1] + 5);
    }
  }

  // Show classification counts
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, 300, 30);
  ctx.fillStyle = '#0f0';
  ctx.font = '14px monospace';
  ctx.fillText(`occupied: ${occupied.size}  empty: ${empty.size}`, 10, 20);

  // Draw per-cell debug grid below the photo
  if (cellDebug && cellDebug.length > 0) {
    const gridTop = (photoCanvas.height / dpr) + 10;
    const cellW = 48, cellH = 36;
    const gridW = BOARD_COLS * cellW + 20;
    const gridH = BOARD_ROWS * cellH + 20;
    
    // Expand canvas to fit grid
    const totalH = photoCanvas.height + (gridH + 20) * dpr;
    debugCanvas.height = totalH;
    debugCanvas.style.height = (totalH / dpr) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(photoCanvas, 0, 0, photoCanvas.width / dpr, photoCanvas.height / dpr);

    // Redraw corners on expanded canvas
    if (corners) {
      ctx.strokeStyle = '#0f0';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, 300, 30);
    ctx.fillStyle = '#0f0';
    ctx.font = '14px monospace';
    ctx.fillText(`occupied: ${occupied.size}  empty: ${empty.size}`, 10, 20);

    // Grid background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, gridTop, gridW, gridH);

    // Title
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px monospace';
    const thr = cellDebug[0]?.thr || '?';
    ctx.fillText(`Cell Class (P=piece W=wood) thr:${thr}`, 10, gridTop + 14);

    for (const cd of cellDebug) {
      const gx = 10 + cd.col * cellW;
      const gy = gridTop + 20 + (BOARD_ROWS - 1 - cd.row) * cellH;

      // Background color: green=piece, tan=wood
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
      
      // RGB + blue dominance
      ctx.font = '8px monospace';
      ctx.fillStyle = '#aaa';
      ctx.fillText(`bd:${cd.bd} s:${cd.sat}`, gx + cellW / 2 - 1, gy + 24);
      ctx.fillText(`${cd.R},${cd.G},${cd.B}`, gx + cellW / 2 - 1, gy + 33);
      ctx.textAlign = 'left';
    }
  }
}