import { mkdir, writeFile } from 'node:fs/promises';

const SF_BOUNDS = [[37.690, -122.530], [37.835, -122.350]];
const DISCOVERY_URLS = [
  'https://gbfs.baywheels.com/gbfs/2.3/gbfs.json',
  'https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json',
  'https://gbfs.lyft.com/gbfs/2.3/bay/en/gbfs.json',
  'https://gbfs.lyft.com/gbfs/2.2/bay/en/gbfs.json',
  'https://gbfs.lyft.com/gbfs/1.1/bay/en/gbfs.json'
];
const FALLBACK_FEEDS = {
  station_information: [
    'https://gbfs.baywheels.com/gbfs/2.3/bay/en/station_information.json',
    'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json',
    'https://gbfs.lyft.com/gbfs/2.2/bay/en/station_information.json',
    'https://gbfs.lyft.com/gbfs/1.1/bay/en/station_information.json'
  ],
  station_status: [
    'https://gbfs.baywheels.com/gbfs/2.3/bay/en/station_status.json',
    'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json',
    'https://gbfs.lyft.com/gbfs/2.2/bay/en/station_status.json',
    'https://gbfs.lyft.com/gbfs/1.1/bay/en/station_status.json'
  ]
};

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function feedMapFromDiscovery(json) {
  const data = json.data || {};
  const candidates = [];
  if (Array.isArray(data.feeds)) {
    candidates.push(...data.feeds);
  }
  for (const value of Object.values(data)) {
    if (value && Array.isArray(value.feeds)) {
      candidates.push(...value.feeds);
    }
  }
  return candidates.reduce((feeds, feed) => {
    if (feed?.name && feed?.url) {
      feeds[feed.name] = feed.url;
    }
    return feeds;
  }, {});
}

async function discoverFeeds() {
  let lastError;
  for (const url of DISCOVERY_URLS) {
    try {
      const feeds = feedMapFromDiscovery(await fetchJson(url));
      if (feeds.station_information) {
        return { feeds, discovery_url: url };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Could not discover GBFS feeds.');
}

async function fetchFirstAvailable(urls) {
  let lastError;
  for (const url of uniqueUrls(urls)) {
    try {
      return { json: await fetchJson(url), url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No usable URLs.');
}

function isInSf(station) {
  return station.lat >= SF_BOUNDS[0][0] && station.lat <= SF_BOUNDS[1][0]
    && station.lon >= SF_BOUNDS[0][1] && station.lon <= SF_BOUNDS[1][1];
}

function statusById(json) {
  const statuses = json.data && Array.isArray(json.data.stations) ? json.data.stations : [];
  return statuses.reduce((byId, status) => {
    byId[String(status.station_id)] = status;
    return byId;
  }, {});
}

function isOperational(status) {
  if (!status) {
    return true;
  }
  return status.is_installed !== 0 && status.is_renting !== 0 && status.is_returning !== 0;
}

async function main() {
  let feeds = {};
  let discoveryUrl = null;
  try {
    const discovered = await discoverFeeds();
    feeds = discovered.feeds;
    discoveryUrl = discovered.discovery_url;
  } catch (error) {
    console.warn(`GBFS discovery failed; using fallback feeds. ${error.message}`);
  }

  const stationInfoFeed = await fetchFirstAvailable(
    feeds.station_information
      ? [feeds.station_information, ...FALLBACK_FEEDS.station_information]
      : FALLBACK_FEEDS.station_information
  );

  let statuses = {};
  let statusUrl = null;
  try {
    const stationStatusFeed = await fetchFirstAvailable(
      feeds.station_status
        ? [feeds.station_status, ...FALLBACK_FEEDS.station_status]
        : FALLBACK_FEEDS.station_status
    );
    statuses = statusById(stationStatusFeed.json);
    statusUrl = stationStatusFeed.url;
  } catch (error) {
    console.warn(`Station status unavailable. ${error.message}`);
  }

  const rawStations = stationInfoFeed.json.data && Array.isArray(stationInfoFeed.json.data.stations)
    ? stationInfoFeed.json.data.stations
    : [];

  const stations = rawStations.filter(isInSf).map(station => {
    const status = statuses[String(station.station_id)] || null;
    return {
      id: String(station.station_id),
      name: station.name || '',
      lat: Number(station.lat),
      lon: Number(station.lon),
      capacity: Number.isFinite(Number(station.capacity)) ? Number(station.capacity) : null,
      is_operational: isOperational(status),
      num_bikes_available: status ? Number(status.num_bikes_available || 0) : null,
      num_docks_available: status ? Number(status.num_docks_available || 0) : null,
      last_reported: status?.last_reported || null
    };
  }).filter(station => Number.isFinite(station.lat) && Number.isFinite(station.lon));

  if (!stations.length) {
    throw new Error('No SF stations found.');
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: {
      discovery_url: discoveryUrl,
      station_information_url: stationInfoFeed.url,
      station_status_url: statusUrl
    },
    stations
  };

  await mkdir('bikeshare', { recursive: true });
  await writeFile('bikeshare/stations.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${stations.length} stations to bikeshare/stations.json.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
