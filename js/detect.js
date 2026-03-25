// Automatic board detection and piece recognition using OpenCV.js
// Strategy: board contour detection → homography → per-cell edge/texture analysis
import { BOARD_CELLS, BOARD_COLS, BOARD_ROWS, isBoardCell, cellKey, PIECES } from './board.js';

/**
 * Wait for OpenCV.js to load
 */
export function waitForOpenCV() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) { resolve(); return; }
    // OpenCV.js sets cv as a global when loaded
    const check = setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error('OpenCV.js load timeout')); }, 30000);
  });
}

/**
 * Detect the puzzle board in the image, classify each cell, and return results.
 * @param {HTMLCanvasElement} photoCanvas - canvas with the captured photo
 * @returns {{ occupied: Set<string>, empty: Set<string>, debugCanvas: HTMLCanvasElement|null, boardContour: any, warpedMat: any }}
 */
export function detectBoard(photoCanvas) {
  const src = cv.imread(photoCanvas);
  const result = { occupied: new Set(), empty: new Set(), corners: null };

  try {
    // 1. Find the board quadrilateral
    const corners = findBoardCorners(src);
    if (!corners) {
      throw new Error('Could not detect board — try better lighting or angle');
    }
    result.corners = corners;

    // 2. Warp to top-down view (known grid dimensions)
    const cellPx = 60; // pixels per cell in warped image
    const warpW = BOARD_COLS * cellPx;
    const warpH = BOARD_ROWS * cellPx;
    const warped = warpToGrid(src, corners, warpW, warpH);

    // 3. Classify each cell as occupied or empty
    classifyCells(warped, cellPx, result);

    warped.delete();
  } finally {
    src.delete();
  }

  return result;
}

/**
 * Find the 4 corners of the puzzle board using contour detection.
 * Returns [[x,y], [x,y], [x,y], [x,y]] in order: TL, TR, BR, BL — or null.
 */
function findBoardCorners(src) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 50, 150);

  // Dilate to close gaps
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // Find the largest quadrilateral contour
  let bestContour = null;
  let bestArea = 0;
  const imgArea = src.rows * src.cols;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    // Board should be a significant portion of the image
    if (area < imgArea * 0.1) continue;

    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);

    if (approx.rows === 4 && area > bestArea) {
      bestArea = area;
      if (bestContour) bestContour.delete();
      bestContour = approx;
    } else {
      approx.delete();
    }
  }

  let corners = null;
  if (bestContour) {
    corners = orderCorners(bestContour);
    bestContour.delete();
  }

  gray.delete(); blurred.delete(); edges.delete(); kernel.delete();
  contours.delete(); hierarchy.delete();

  return corners;
}

/**
 * Order 4 points as [TL, TR, BR, BL]
 */
function orderCorners(mat) {
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push([mat.data32S[i * 2], mat.data32S[i * 2 + 1]]);
  }

  // Sort by sum (x+y): smallest = TL, largest = BR
  // Sort by diff (x-y): smallest = BL, largest = TR
  const sumSorted = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const diffSorted = [...pts].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));

  const tl = sumSorted[0];
  const br = sumSorted[3];
  const bl = diffSorted[0];
  const tr = diffSorted[3];

  return [tl, tr, br, bl];
}

/**
 * Warp the source image to a top-down rectangular view of the grid
 */
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
 * Classify each cell in the warped top-down image as occupied or empty.
 * 
 * Strategy: The bare wooden board has a relatively uniform light color with 
 * engraved/printed text. Pieces have more complex textures, gradients, and 
 * different colors. We use a combination of:
 * - Mean color distance from "wood" reference color
 * - Edge density (Canny edges per cell)
 * - Color variance within the cell
 */
function classifyCells(warped, cellPx, result) {
  const gray = new cv.Mat();
  const hsv = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(warped, hsv, cv.COLOR_RGBA2RGB);
  const hsvMat = new cv.Mat();
  cv.cvtColor(hsv, hsvMat, cv.COLOR_RGB2HSV);

  // Compute Canny edges on the warped image
  const edges = new cv.Mat();
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  cv.Canny(blurred, edges, 30, 100);

  // First pass: collect stats from all valid cells to determine thresholds adaptively
  const cellStats = [];

  for (const [c, r] of BOARD_CELLS) {
    const x = c * cellPx;
    const y = (BOARD_ROWS - 1 - r) * cellPx;
    const margin = Math.floor(cellPx * 0.15); // skip edges of cell to avoid borders
    const roi = new cv.Rect(x + margin, y + margin, cellPx - margin * 2, cellPx - margin * 2);

    // Edge density
    const edgeRoi = edges.roi(roi);
    const edgeMean = cv.mean(edgeRoi);
    const edgeDensity = edgeMean[0] / 255.0;
    edgeRoi.delete();

    // Color stats in HSV
    const hsvRoi = hsvMat.roi(roi);
    const mean = cv.mean(hsvRoi);
    const hMean = mean[0], sMean = mean[1], vMean = mean[2];

    // Compute color variance (saturation is key — wood is low saturation, pieces are higher)
    const channels = new cv.MatVector();
    cv.split(hsvRoi, channels);
    const sMat = channels.get(1);
    const sMeanScalar = cv.mean(sMat);
    const sStd = new cv.Mat();
    const sMeanMat = new cv.Mat();
    cv.meanStdDev(sMat, sMeanMat, sStd);
    const satStdDev = sStd.doubleAt(0, 0);

    hsvRoi.delete();
    for (let ch = 0; ch < channels.size(); ch++) channels.get(ch).delete();
    channels.delete();
    sStd.delete(); sMeanMat.delete();

    cellStats.push({
      col: c, row: r,
      edgeDensity,
      saturation: sMean,
      satStdDev,
      value: vMean,
      hue: hMean
    });
  }

  // Adaptive thresholding: find the natural split in saturation
  // Wood cells tend to have low saturation; piece cells have higher saturation
  const saturations = cellStats.map(s => s.saturation).sort((a, b) => a - b);
  const edgeDensities = cellStats.map(s => s.edgeDensity).sort((a, b) => a - b);

  // Use Otsu-like split: find threshold that best separates two clusters
  const satThreshold = findOtsuThreshold(saturations);
  const edgeThreshold = findOtsuThreshold(edgeDensities);

  // Classify using combined score
  for (const stats of cellStats) {
    const key = cellKey(stats.col, stats.row);
    // Score: higher = more likely to be a piece
    // Saturation is the strongest signal (pieces are colored, wood is not)
    // Edge density is secondary (pieces have texture)
    const satScore = stats.saturation > satThreshold ? 1 : 0;
    const edgeScore = stats.edgeDensity > edgeThreshold ? 0.5 : 0;
    const score = satScore + edgeScore;

    if (score >= 0.5) {
      result.occupied.add(key);
    } else {
      result.empty.add(key);
    }
  }

  gray.delete(); hsv.delete(); hsvMat.delete(); edges.delete(); blurred.delete();
}

/**
 * Simple Otsu-style threshold finder for an array of sorted values.
 * Returns the value that best separates the data into two groups.
 */
function findOtsuThreshold(sorted) {
  const n = sorted.length;
  if (n < 2) return sorted[0] || 0;

  let bestThresh = sorted[0];
  let bestVariance = Infinity;

  for (let i = 1; i < n - 1; i++) {
    const left = sorted.slice(0, i);
    const right = sorted.slice(i);
    const leftMean = left.reduce((a, b) => a + b, 0) / left.length;
    const rightMean = right.reduce((a, b) => a + b, 0) / right.length;
    const leftVar = left.reduce((a, b) => a + (b - leftMean) ** 2, 0) / left.length;
    const rightVar = right.reduce((a, b) => a + (b - rightMean) ** 2, 0) / right.length;
    const withinVar = (left.length * leftVar + right.length * rightVar) / n;

    if (withinVar < bestVariance) {
      bestVariance = withinVar;
      bestThresh = sorted[i];
    }
  }

  return bestThresh;
}

/**
 * Given detected occupied/empty cells, figure out which pieces are placed
 * by grouping occupied cells into connected components and matching shapes.
 */
export function identifyPlacedPieces(occupied) {
  // Group into connected components
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
      // Check 4-connected neighbors
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nk = cellKey(c + dc, r + dr);
        if (occupied.has(nk) && !visited.has(nk)) stack.push(nk);
      }
    }
    components.push(component);
  }

  // Try to match each component to a known piece shape
  const usedPieceIndices = new Set();
  for (const comp of components) {
    const coords = comp.map(k => k.split(',').map(Number));
    const matchIdx = matchPieceShape(coords, usedPieceIndices);
    if (matchIdx !== -1) usedPieceIndices.add(matchIdx);
  }

  return usedPieceIndices;
}

/**
 * Match a set of cell coordinates to a known piece shape.
 * Returns piece index or -1 if no match.
 */
function matchPieceShape(coords, excludeIndices) {
  // Normalize the coordinates
  const norm = normalizeCoords(coords);
  const key = coordsKey(norm);

  for (let i = 0; i < PIECES.length; i++) {
    if (excludeIndices.has(i)) continue;
    const piece = PIECES[i];
    // Generate all orientations (4 rotations × 2 reflections)
    const orientations = generateAllOrientations(piece.coords);
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
      current = current.map(([c, r]) => [-r, c]); // rotate 90
    }
    current = coords.map(([c, r]) => [-c, r]); // reflect
  }
  return results;
}

/**
 * Draw detection debug visualization on a canvas
 */
export function drawDebug(debugCanvas, photoCanvas, corners, occupied, empty) {
  const ctx = debugCanvas.getContext('2d');
  debugCanvas.width = photoCanvas.width;
  debugCanvas.height = photoCanvas.height;
  ctx.drawImage(photoCanvas, 0, 0);

  // Draw detected corners
  if (corners) {
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();

    for (const [x, y] of corners) {
      ctx.fillStyle = '#f00';
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}