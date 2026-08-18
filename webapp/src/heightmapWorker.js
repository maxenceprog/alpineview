self.onmessage = (msg) => {
  const { id, positions, gridSize } = msg.data;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cellSize = Math.max((maxX - minX) / gridSize, (maxY - minY) / gridSize, 0.01);
  const heights = new Float32Array(gridSize * gridSize).fill(-Infinity);

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    const cx = Math.min(gridSize - 1, Math.max(0, Math.floor((x - minX) / cellSize)));
    const cy = Math.min(gridSize - 1, Math.max(0, Math.floor((y - minY) / cellSize)));
    const idx = cy * gridSize + cx;
    if (z > heights[idx]) heights[idx] = z;
  }

  self.postMessage(
    { id, originX: minX, originY: minY, cellSize, gridSize, heights },
    [heights.buffer],
  );
};
