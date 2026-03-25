// Dancing Links (DLX) implementation of Knuth's Algorithm X

class DLXNode {
  constructor() {
    this.left = this; this.right = this;
    this.up = this; this.down = this;
    this.column = null; this.rowIndex = -1;
  }
}

class DLXColumn extends DLXNode {
  constructor(id) {
    super(); this.id = id; this.size = 0; this.column = this;
  }
}

export class DLX {
  constructor(matrix) {
    this.header = new DLXColumn(-1);
    this.columns = [];
    this.solution = [];
    if (matrix.length === 0) return;
    const numCols = matrix[0].length;

    for (let j = 0; j < numCols; j++) {
      const col = new DLXColumn(j);
      this.columns.push(col);
      col.left = this.header.left;
      col.right = this.header;
      this.header.left.right = col;
      this.header.left = col;
    }

    for (let i = 0; i < matrix.length; i++) {
      let firstInRow = null;
      for (let j = 0; j < numCols; j++) {
        if (matrix[i][j]) {
          const col = this.columns[j];
          const node = new DLXNode();
          node.column = col; node.rowIndex = i;
          node.up = col.up; node.down = col;
          col.up.down = node; col.up = node;
          col.size++;
          if (firstInRow === null) {
            firstInRow = node; node.left = node; node.right = node;
          } else {
            node.left = firstInRow.left; node.right = firstInRow;
            firstInRow.left.right = node; firstInRow.left = node;
          }
        }
      }
    }
  }

  _cover(col) {
    col.right.left = col.left; col.left.right = col.right;
    let row = col.down;
    while (row !== col) {
      let node = row.right;
      while (node !== row) {
        node.down.up = node.up; node.up.down = node.down;
        node.column.size--;
        node = node.right;
      }
      row = row.down;
    }
  }

  _uncover(col) {
    let row = col.up;
    while (row !== col) {
      let node = row.left;
      while (node !== row) {
        node.column.size++;
        node.down.up = node; node.up.down = node;
        node = node.left;
      }
      row = row.up;
    }
    col.right.left = col; col.left.right = col;
  }

  _chooseColumn() {
    let best = null, bestSize = Infinity;
    let col = this.header.right;
    while (col !== this.header) {
      if (col.size < bestSize) { bestSize = col.size; best = col; }
      col = col.right;
    }
    return best;
  }

  solve() { return this._search(0); }

  _search(depth) {
    if (this.header.right === this.header) return true;
    const col = this._chooseColumn();
    if (!col || col.size === 0) return false;
    this._cover(col);
    let row = col.down;
    while (row !== col) {
      this.solution[depth] = row.rowIndex;
      let node = row.right;
      while (node !== row) { this._cover(node.column); node = node.right; }
      if (this._search(depth + 1)) return true;
      node = row.left;
      while (node !== row) { this._uncover(node.column); node = node.left; }
      row = row.down;
    }
    this._uncover(col);
    return false;
  }

  getSolution() { return [...this.solution]; }
}