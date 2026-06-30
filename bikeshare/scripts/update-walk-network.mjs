import { mkdir, writeFile } from 'node:fs/promises';

const SF_BOUNDS = [[37.690, -122.530], [37.835, -122.350]];
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const WALK_SPEED_METERS_PER_SECOND = 80 / 60;
const STEP_SPEED_METERS_PER_SECOND = 55 / 60;
const WALKABLE_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'residential', 'living_street',
  'service', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'unclassified', 'road', 'cycleway', 'track'
]);
const EXCLUDED_ACCESS = /^(no|private)$/i;

function overpassQuery() {
  const [south, west] = SF_BOUNDS[0];
  const [north, east] = SF_BOUNDS[1];
  return `
[out:json][timeout:180];
(
  way["highway"](${south},${west},${north},${east});
);
(._;>;);
out body;
`;
}

async function fetchOverpass() {
  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ data: overpassQuery() })
      });
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return { json: await response.json(), url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Overpass endpoint succeeded.');
}

function isWayWalkable(tags = {}) {
  if (!WALKABLE_HIGHWAYS.has(tags.highway)) {
    return false;
  }
  if (EXCLUDED_ACCESS.test(tags.access || '') || EXCLUDED_ACCESS.test(tags.foot || '')) {
    return false;
  }
  if (tags.area === 'yes') {
    return false;
  }
  return true;
}

function speedForWay(tags = {}) {
  return tags.highway === 'steps' ? STEP_SPEED_METERS_PER_SECOND : WALK_SPEED_METERS_PER_SECOND;
}

function metersBetween(aLat, aLng, bLat, bLng) {
  const r = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function buildNetwork(elements) {
  const rawNodes = new Map();
  const ways = [];

  for (const element of elements) {
    if (element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      rawNodes.set(element.id, [Number(element.lat), Number(element.lon)]);
    }
    if (element.type === 'way' && Array.isArray(element.nodes) && isWayWalkable(element.tags)) {
      ways.push(element);
    }
  }

  const nodeIndexById = new Map();
  const nodes = [];
  const edgeMap = new Map();

  function nodeIndex(id) {
    if (nodeIndexById.has(id)) {
      return nodeIndexById.get(id);
    }
    const rawNode = rawNodes.get(id);
    if (!rawNode) {
      return null;
    }
    const index = nodes.length;
    nodeIndexById.set(id, index);
    nodes.push(rawNode);
    return index;
  }

  for (const way of ways) {
    const speed = speedForWay(way.tags);
    for (let i = 1; i < way.nodes.length; i += 1) {
      const from = nodeIndex(way.nodes[i - 1]);
      const to = nodeIndex(way.nodes[i]);
      if (from === null || to === null || from === to) {
        continue;
      }
      const fromNode = nodes[from];
      const toNode = nodes[to];
      const meters = metersBetween(fromNode[0], fromNode[1], toNode[0], toNode[1]);
      if (!Number.isFinite(meters) || meters <= 0) {
        continue;
      }
      const seconds = Math.max(1, Math.round(meters / speed));
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      const key = `${a}:${b}`;
      const existing = edgeMap.get(key);
      if (!existing || seconds < existing[2]) {
        edgeMap.set(key, [a, b, seconds]);
      }
    }
  }

  const used = new Set();
  for (const [from, to] of edgeMap.values()) {
    used.add(from);
    used.add(to);
  }

  const remap = new Map();
  const compactNodes = [];
  for (const oldIndex of [...used].sort((a, b) => a - b)) {
    remap.set(oldIndex, compactNodes.length);
    compactNodes.push(nodes[oldIndex]);
  }

  const compactEdges = [];
  for (const [from, to, seconds] of edgeMap.values()) {
    if (remap.has(from) && remap.has(to)) {
      compactEdges.push([remap.get(from), remap.get(to), seconds]);
    }
  }

  if (!compactNodes.length || !compactEdges.length) {
    throw new Error('No usable walking network generated.');
  }

  return { nodes: compactNodes, edges: compactEdges, way_count: ways.length };
}

async function main() {
  const { json, url } = await fetchOverpass();
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const network = buildNetwork(elements);
  const payload = {
    generated_at: new Date().toISOString(),
    source: {
      overpass_url: url,
      bounds: SF_BOUNDS,
      walk_speed_mps: WALK_SPEED_METERS_PER_SECOND,
      step_speed_mps: STEP_SPEED_METERS_PER_SECOND
    },
    node_count: network.nodes.length,
    edge_count: network.edges.length,
    way_count: network.way_count,
    nodes: network.nodes,
    edges: network.edges
  };

  await mkdir('bikeshare', { recursive: true });
  await writeFile('bikeshare/walk-network.json', `${JSON.stringify(payload)}\n`);
  console.log(`Wrote ${network.nodes.length} nodes and ${network.edges.length} edges to bikeshare/walk-network.json.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
