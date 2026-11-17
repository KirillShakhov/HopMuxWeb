import { BaseEdge, type Edge, type EdgeProps, type XYPosition } from '@xyflow/react';

export const graphNodeSize = { width: 124, height: 34 };
const portGap = 20;
const clearance = 12;
const laneGap = 20;

function intersectsNode(a: XYPosition, b: XYPosition, node: XYPosition) {
  return Math.max(a.x, b.x) >= node.x - clearance
    && Math.min(a.x, b.x) <= node.x + graphNodeSize.width + clearance
    && Math.max(a.y, b.y) >= node.y - clearance
    && Math.min(a.y, b.y) <= node.y + graphNodeSize.height + clearance;
}

export function findDetourLane(source: XYPosition, target: XYPosition, nodes: XYPosition[]) {
  const start = { x: source.x + graphNodeSize.width, y: source.y + graphNodeSize.height / 2 };
  const end = { x: target.x, y: target.y + graphNodeSize.height / 2 };
  const centerX = (start.x + end.x) / 2;
  const bends = [{ x: centerX, y: start.y }, { x: centerX, y: end.y }];
  const step = [start, ...bends, end];
  const obstructed = nodes.some(node => node !== source && node !== target
    && step.slice(1).some((point, index) => intersectsNode(step[index], point, node)));
  if (start.x < end.x && !obstructed) return;

  // The node columns leave room for vertical segments just outside both handles.
  const fromX = start.x + portGap;
  const toX = end.x - portGap;
  const crossed = nodes.filter(node => Math.max(fromX, toX) >= node.x - clearance
    && Math.min(fromX, toX) <= node.x + graphNodeSize.width + clearance);
  const centerY = (start.y + end.y) / 2;
  const lanes = [start.y, end.y, ...crossed.flatMap(node => [node.y - laneGap, node.y + graphNodeSize.height + laneGap])];
  return lanes.sort((a, b) => Math.abs(a - centerY) - Math.abs(b - centerY) || a - b)
    .find(y => !crossed.some(node => intersectsNode({ x: fromX, y }, { x: toX, y }, node)));
}

function roundedPath(points: XYPosition[]) {
  const corners = points.filter((point, i) => i === 0 || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
  const moveToward = (corner: XYPosition, next: XYPosition, distance: number) =>
    `${corner.x + Math.sign(next.x - corner.x) * distance} ${corner.y + Math.sign(next.y - corner.y) * distance}`;
  let path = `M ${corners[0].x} ${corners[0].y}`;
  for (let i = 1; i < corners.length - 1; i++) {
    const [previous, corner, next] = corners.slice(i - 1, i + 2);
    const radius = Math.min(6, Math.hypot(previous.x - corner.x, previous.y - corner.y) / 2,
      Math.hypot(next.x - corner.x, next.y - corner.y) / 2);
    path += ` L ${moveToward(corner, previous, radius)} Q ${corner.x} ${corner.y} ${moveToward(corner, next, radius)}`;
  }
  const last = corners[corners.length - 1];
  return path + ` L ${last.x} ${last.y}`;
}

export function GraphEdge({ id, data, sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps<Edge<{ lane: number }>>) {
  const lane = data?.lane ?? (sourceY + targetY) / 2;
  const fromX = sourceX + portGap;
  const toX = targetX - portGap;
  const path = roundedPath([
    { x: sourceX, y: sourceY }, { x: fromX, y: sourceY }, { x: fromX, y: lane },
    { x: toX, y: lane }, { x: toX, y: targetY }, { x: targetX, y: targetY },
  ]);
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style}/>;
}
