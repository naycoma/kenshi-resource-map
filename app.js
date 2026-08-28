const mapSize = 256;
// CRS.Simple has an upward-positive latitude axis. Keeping the image in the
// negative-latitude quadrant makes XYZ tile y values start at zero.
const bounds = [[-mapSize, 0], [0, mapSize]];
const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: 0,
  maxZoom: 5,
  maxBounds: bounds,
  maxBoundsViscosity: 1,
  zoomControl: false,
  attributionControl: false
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.createPane('roadPane');
map.getPane('roadPane').style.zIndex = 425;
map.getPane('roadPane').style.pointerEvents = 'none';

const base = L.tileLayer('tiles/base/{z}/{y}/{x}.png', {
  minZoom: 0, maxZoom: 5, noWrap: true, bounds, tileSize: 256
}).addTo(map);
const selectedPoint = L.circleMarker([0, 0], {
  pane: 'markerPane', radius: 6, color: '#fff0a8', weight: 2,
  fillColor: '#191919', fillOpacity: 0.78, interactive: false
});

function markSelectedPoint(latlng) {
  selectedPoint.setLatLng(latlng);
  if (!map.hasLayer(selectedPoint)) selectedPoint.addTo(map);
  selectedPoint.bringToFront();
}
const resourceMeta = {
  iron: { label: '鉄', raw: 'ironMultiplier', color: [238, 177, 74], format: percent },
  copper: { label: '銅', raw: 'copperMultiplier', color: [77, 200, 214], format: percent },
  stone: { label: '石', raw: 'stoneMultiplier', color: [196, 190, 174], format: percent },
  water: { label: '水', raw: 'waterMultiplier', color: [70, 150, 235], format: percent },
  fertility: { label: '肥沃度', raw: 'fertilityMultiplier', color: [111, 201, 88], format: percent },
  wind: { label: '風', raw: 'windMax', color: [180, 225, 238], format: (value, values) => `${Number(values.windMin ?? 0).toFixed(0)}–${value.toFixed(0)}` },
  arid: { label: '乾燥', raw: 'aridValue', color: [224, 155, 70], format: value => `${Math.round(value * 100)}%` },
  green: { label: '牧草', raw: 'greenValue', color: [91, 190, 103], format: value => `${Math.round(value * 100)}%` },
  swamp: { label: '湿地', raw: 'swampValue', color: [100, 178, 158], format: value => `${Math.round(value * 100)}%` }
};
let resource = document.querySelector('[data-resource].active')?.dataset.resource ?? 'none';
const areaTextResources = new Set(
  [...document.querySelectorAll('[data-area-text]:checked')]
    .flatMap(input => input.dataset.areaText.split(' '))
);
let config;
let weatherDataPromise;
let coordinateRequest = 0;
const heightTileCache = new Map();
const areaRenderer = L.canvas({ padding: 0.5 });
const roadRenderer = L.canvas({ padding: 0.5, pane: 'roadPane' });

function areaStyle(feature) {
  const meta = resourceMeta[resource];
  const weight = resource === 'none' ? 0 : Number(feature.properties[resource] ?? 0);
  const color = meta?.color ?? [0, 0, 0];
  return {
    stroke: false,
    fill: true,
    fillColor: `rgb(${color.join(',')})`,
    fillOpacity: Math.max(0, Math.min(1, weight)) * 0.75
  };
}

function updateLegend() {
  const legend = document.querySelector('.legend');
  const color = resourceMeta[resource]?.color;
  legend.hidden = !color;
  if (color) legend.style.setProperty('--legend-color', `rgb(${color.join(',')})`);
}

const areaPolygons = L.geoJSON(null, {
  renderer: areaRenderer,
  filter: feature => feature.properties.kind === 'area',
  style: areaStyle,
  bubblingMouseEvents: false,
  onEachFeature: (feature, layer) => {
    layer.on('click', event => {
      if (!config) return;
      markSelectedPoint(event.latlng);
      const point = worldCoordinate(event.latlng);
      const request = ++coordinateRequest;
      status.innerHTML = areaDetail(feature.properties, point);
      hydrateTerrainHeight(point, request);
      hydrateWeatherDetails(feature.properties);
    });
  }
}).addTo(map);
const areaBoundaries = L.geoJSON(null, {
  filter: feature => feature.properties.kind === 'boundary',
  style: { color: '#f4e4b7', weight: 1, opacity: 0.82, interactive: false }
});
const areaLabels = L.geoJSON(null, {
  filter: feature => feature.properties.kind === 'label',
  pointToLayer: (feature, latlng) => {
    const values = feature.properties;
    const groups = [
      ['', ['iron', 'copper', 'stone']],
      ['', ['arid', 'green', 'swamp']],
      ['', ['fertility']],
      ['', ['water']],
      ['', ['wind']]
    ];
    const lines = groups.map(([group, keys]) => {
      const selected = keys.filter(key => areaTextResources.has(key));
      if (!selected.length) return '';
      const text = selected.map(key => {
        const meta = resourceMeta[key];
        return `${escapeHtml(meta.label)}${meta.format(Number(values[meta.raw] ?? 0), values)}`;
      }).join('　');
      return group ? `${group}：${text}` : text;
    }).filter(Boolean);
    const chips = areaTextVisible ? specialChips(values) : [];
    const name = areaNamesVisible ? areaNameHtml(values) : '';
    return L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: 'area-label-wrap',
        html: `<span class="area-label">${name}${areaTextVisible && lines.length ? `<small class="area-values">${lines.join('<br>')}</small>` : ''}${chipHtml(chips)}</span>`,
        iconSize: [180, 80], iconAnchor: [90, 40]
      })
    });
  }
});
const boundaries = L.layerGroup([areaBoundaries]).addTo(map);
map.setView([-mapSize / 2, mapSize / 2], 2);

let locationsVisible = document.querySelector('#locations-toggle').checked;
let locationMarkers = [];
let pendingLocations;
let roadsVisible = document.querySelector('#roads-toggle').checked;
let roadsPromise;
let roadsLayer;
let boundariesVisible = document.querySelector('#areas-toggle').checked;
let areaNamesVisible = document.querySelector('#area-names-toggle').checked;
let areaTextVisible = document.querySelector('#area-text-toggle').checked;
const areaTextOptions = document.querySelector('#area-text-options');
areaTextOptions.disabled = !areaTextVisible;
let areaGeoJson;
const status = document.querySelector('#status');

function worldCoordinate(latlng) {
  const span = config.world.max - config.world.min;
  return {
    x: config.world.min + (latlng.lng / mapSize) * span,
    z: config.world.min + (-latlng.lat / mapSize) * span
  };
}

function coordinateHtml(point) {
  return `<div class="coordinate">X ${point.x.toFixed(0)} / Y <span class="coordinate-y">…</span> / Z ${point.z.toFixed(0)}</div>`;
}

function loadHeightTile(x, y) {
  const key = `${x}/${y}`;
  if (!heightTileCache.has(key)) {
    if (heightTileCache.size >= 32) heightTileCache.delete(heightTileCache.keys().next().value);
    heightTileCache.set(key, fetch(`tiles/height/5/${y}/${x}.png`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then(createImageBitmap)
      .then(bitmap => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
        bitmap.close();
        return canvas;
      }));
  }
  return heightTileCache.get(key);
}

async function terrainHeight(point) {
  const span = config.world.max - config.world.min + 1;
  const side = 256 * 2 ** 5;
  const pixelX = Math.max(0, Math.min(side - 1, Math.floor((point.x - config.world.min) / span * side)));
  const pixelY = Math.max(0, Math.min(side - 1, Math.floor((point.z - config.world.min) / span * side)));
  const tileX = Math.floor(pixelX / 256);
  const tileY = Math.floor(pixelY / 256);
  const canvas = await loadHeightTile(tileX, tileY);
  const [high, low] = canvas.getContext('2d').getImageData(pixelX % 256, pixelY % 256, 1, 1).data;
  return ((high << 8) | low) * 0.15;
}

function hydrateTerrainHeight(point, request) {
  terrainHeight(point).then(y => {
    if (request !== coordinateRequest) return;
    const output = status.querySelector('.coordinate-y');
    if (output) output.textContent = y.toFixed(0);
  }).catch(() => {
    if (request !== coordinateRequest) return;
    const output = status.querySelector('.coordinate-y');
    if (output) output.textContent = '不明';
  });
}

function mapPoint(x, z) {
  const span = config.world.max - config.world.min;
  return [
    -((z - config.world.min) / span) * mapSize,
    ((x - config.world.min) / span) * mapSize
  ];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function specialChips(values) {
  const chips = (values.specialWeather ?? []).map(label => ({ label, kind: 'weather' }));
  const ground = Number(values.acidicGround ?? 0);
  const water = Number(values.acidicWater ?? 0);
  if (ground > 0) chips.push({ label: `酸性地表:${Math.round(ground * 100)}%`, kind: 'terrain' });
  if (water > 0) chips.push({ label: `酸性水域:${Math.round(water * 100)}%`, kind: 'terrain' });
  return chips;
}

function chipHtml(chips) {
  if (!chips.length) return '';
  return `<span class="area-chips">${chips.map(chip => `<i class="area-chip ${chip.kind}">${escapeHtml(chip.label)}</i>`).join('')}</span>`;
}

function loadWeatherData() {
  weatherDataPromise ??= fetch('weather.json').then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  return weatherDataPromise;
}

function positionWeatherPopover(button, popover) {
  if (!popover.matches(':popover-open')) popover.showPopover();
  popover.style.visibility = 'hidden';
  const rect = button.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  let top = rect.top - height - 6;
  if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(8, top)}px`;
  popover.style.visibility = '';
}

function bindWeatherPopovers(container) {
  container.querySelectorAll('.weather-name').forEach(button => {
    const popover = button.parentElement.querySelector('.weather-popover');
    let pinned = false;
    button.addEventListener('mouseenter', () => positionWeatherPopover(button, popover));
    button.addEventListener('mouseleave', () => {
      if (!pinned && document.activeElement !== button && popover.matches(':popover-open')) popover.hidePopover();
    });
    button.addEventListener('focus', () => positionWeatherPopover(button, popover));
    button.addEventListener('blur', () => {
      if (!pinned && popover.matches(':popover-open')) popover.hidePopover();
    });
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (pinned) popover.hidePopover();
      else positionWeatherPopover(button, popover);
      pinned = !pinned;
    });
    popover.addEventListener('toggle', event => {
      if (event.newState === 'closed') pinned = false;
    });
  });
}

function weatherDetailsHtml(data, area) {
  const profile = data.profiles[area.weatherProfileId];
  if (!profile?.seasonRefs?.length) return '<span class="muted">なし</span>';
  const occurrences = new Map();
  const seasonWeightTotal = profile.seasonRefs.reduce((sum, ref) => sum + Math.max(0, ref.weight), 0);
  profile.seasonRefs.forEach(seasonRef => {
    const season = data.seasons[seasonRef.id];
    if (!season) return;
    const weatherWeightTotal = season.weatherRefs.reduce((sum, ref) => sum + Math.max(0, ref.weight), 0);
    season.weatherRefs.forEach(weatherRef => {
      const item = data.weather[weatherRef.id];
      if (!item) return;
      const seasonShare = seasonWeightTotal > 0
        ? Math.max(0, seasonRef.weight) / seasonWeightTotal
        : 1 / profile.seasonRefs.length;
      const weatherShare = weatherWeightTotal > 0
        ? Math.max(0, weatherRef.weight) / weatherWeightTotal
        : 1 / season.weatherRefs.length;
      const list = occurrences.get(weatherRef.id) ?? [];
      list.push({ season: season.name, chance: seasonShare * weatherShare, ...weatherRef });
      occurrences.set(weatherRef.id, list);
    });
  });
  if (!occurrences.size) return '<span class="muted">なし</span>';
  const chips = [...occurrences].map(([weatherId, contexts], index) => {
    const item = data.weather[weatherId];
    const tags = [...(item.tags ?? []), ...(item.effects ?? [])];
    const contextHtml = contexts.map(context => {
      const duration = context.durationMax > 0
        ? `${context.durationMin}–${context.durationMax}`
        : `${context.durationMin}`;
      return `<li>${escapeHtml(context.season)}：概算選択比 ${Math.round(context.chance * 100)}% · 継続 ${duration}</li>`;
    }).join('');
    return `<span class="weather-chip-wrap">
      <button type="button" class="area-chip weather-name">${escapeHtml(item.name)}</button>
      <span id="weather-popover-${index}" class="weather-popover" popover="auto" role="tooltip">
        <b>${escapeHtml(item.name)}</b>
        <span>風速 ${Number(item.windMin).toFixed(0)}–${Number(item.windMax).toFixed(0)}</span>
        ${tags.length ? `<span>${tags.map(escapeHtml).join(' · ')}</span>` : ''}
        <ul>${contextHtml}</ul>
      </span>
    </span>`;
  }).join('');
  const strengthMin = Number(area.weatherStrengthMin ?? 1);
  const strengthMax = Number(area.weatherStrengthMax ?? 1);
  return `<span class="area-chips detail-weather">${chips}</span>
    <small class="weather-strength">ゾーン天候強度 ${percent(strengthMin)}–${percent(strengthMax)}</small>`;
}

async function hydrateWeatherDetails(area) {
  const target = document.querySelector(`.weather-details[data-profile="${CSS.escape(area.weatherProfileId ?? '')}"]`);
  if (!target) return;
  try {
    const data = await loadWeatherData();
    if (target.isConnected) {
      target.innerHTML = weatherDetailsHtml(data, area);
      bindWeatherPopovers(target);
    }
  } catch (error) {
    if (target.isConnected) target.innerHTML = `<span class="muted">天候詳細を読めません: ${escapeHtml(error.message)}</span>`;
  }
}

function percent(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function altitudeDetail(minimum, maximum, fade, floor) {
  if (![minimum, maximum, fade].some(Number)) return '高度補正なし';
  return `下限 ${percent(floor)} · 適正高度 ${Number(minimum).toFixed(0)}–${Number(maximum).toFixed(0)} · fade ${Number(fade).toFixed(0)}`;
}

function areaNameHtml(area) {
  const english = escapeHtml(area.biome);
  if (!area.biomeJa || area.biomeJa === area.biome) return `<b class="area-name">${english}</b>`;
  return `<b class="area-name">${escapeHtml(area.biomeJa)}</b><small class="area-name-en">${english}</small>`;
}

function locationNameHtml(location) {
  const english = escapeHtml(location.name);
  if (!location.nameJa || location.nameJa === location.name) return `<span class="location-name-ja">${english}</span>`;
  return `<span class="location-name-ja">${escapeHtml(location.nameJa)}</span><small class="location-name-en">${english}</small>`;
}

function factionChipHtml(faction) {
  const english = faction?.name || 'No Faction';
  const japanese = faction?.nameJa;
  return `<span class="faction-chip"><span>${escapeHtml(japanese || english)}</span>${japanese && japanese !== english ? `<small>${escapeHtml(english)}</small>` : ''}</span>`;
}

function renderFactionLegend(factions) {
  const legend = document.querySelector('#faction-legend');
  const entries = Object.values(factions)
    .filter(faction => /^#[0-9a-f]{6}$/i.test(faction.color || ''))
    .sort((left, right) => (left.nameJa || left.name).localeCompare(right.nameJa || right.name, 'ja'));
  legend.querySelector('.faction-legend-list').innerHTML = entries.map(faction => `
    <div class="faction-legend-item">
      <i class="faction-swatch" style="--faction-color:${faction.color}"></i>
      <span class="faction-legend-name">${escapeHtml(faction.nameJa || faction.name)}<small>${escapeHtml(faction.name)}</small></span>
    </div>`).join('');
  legend.hidden = entries.length === 0;
}

function areaDetail(area, point) {
  const chips = specialChips(area);
  return `<article class="area-detail">
    <h2>${areaNameHtml(area)}</h2>
    ${coordinateHtml(point)}
    ${chipHtml(chips)}
    <div class="detail-tables">
      <table>
        <caption>鉱脈</caption>
        <thead><tr><th>鉄</th><th>銅</th><th>石</th></tr></thead>
        <tbody><tr><td>${percent(area.ironMultiplier)}</td><td>${percent(area.copperMultiplier)}</td><td>${percent(area.stoneMultiplier)}</td></tr></tbody>
      </table>
      <table>
        <caption>生育</caption>
        <thead><tr><th>乾燥</th><th>牧草</th><th>湿地</th></tr></thead>
        <tbody><tr><td>${percent(area.aridValue)}</td><td>${percent(area.greenValue)}</td><td>${percent(area.swampValue)}</td></tr></tbody>
      </table>
      <table>
        <caption>土地</caption>
        <thead><tr><th>種類</th><th>基礎値</th></tr></thead>
        <tbody>
          <tr><th>水</th><td>${percent(area.waterMultiplier)}<small class="resource-modifiers">${altitudeDetail(area.waterAltitudeMin, area.waterAltitudeMax, area.waterAltitudeFade, area.waterMin)}</small></td></tr>
          <tr><th>肥沃度</th><td>${percent(area.fertilityMultiplier)}<small class="resource-modifiers">${altitudeDetail(area.fertilityAltitudeMin, area.fertilityAltitudeMax, area.fertilityAltitudeFade, area.fertilityMin)}</small></td></tr>
        </tbody>
      </table>
    </div>
    <dl class="detail-misc">
      <dt>風速候補</dt><dd>${Number(area.windMin).toFixed(0)}–${Number(area.windMax).toFixed(0)}</dd>
      <dt>天候候補</dt><dd><span class="weather-details" data-profile="${escapeHtml(area.weatherProfileId ?? '')}"><span class="muted">読み込み中…</span></span></dd>
    </dl>
  </article>`;
}

function locationStyle(type) {
  return ({
    TOWN_TOWN: ['town', 0], TOWN_VILLAGE: ['village', 2], TOWN_OUTPOST: ['outpost', 2],
    TOWN_MILITARY: ['outpost', 2], TOWN_PRISON: ['outpost', 2], TOWN_SLAVE_CAMP: ['workcamp', 2],
    TOWN_RUINS: ['ruin', 3], TOWN_POI: ['smallplace', 3], TOWN_NEST_MARKER: ['nest', 3]
  })[type] ?? ['smallplace', 3];
}

const locationIconSourceSizes = {
  town: [86, 95], outpost: [53, 76], village: [40, 41], workcamp: [44, 36],
  ruin: [30, 42], smallplace: [27, 31], nest: [34, 31]
};
const locationIconMaxScale = 0.75;
const locationIconMaxScaleZoom = 2;

function locationIconScale(zoom = map.getZoom()) {
  return locationIconMaxScale / (2 ** (Math.max(0, locationIconMaxScaleZoom - zoom) / 2));
}

function locationIcon(name, faction, scale = locationIconScale()) {
  const sourceSize = faction?.color
    ? locationIconSourceSizes[name].map(value => value + 2)
    : locationIconSourceSizes[name];
  const size = sourceSize.map(value => Math.round(value * scale));
  const iconUrl = faction?.color
    ? `icons/map/factions/${name}-${faction.color.slice(1)}.png`
    : `icons/map/outlined/${name}.png`;
  return L.icon({
    className: 'location-game-icon',
    iconUrl,
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1] / 2],
    popupAnchor: [0, -size[1] / 2],
    tooltipAnchor: [0, -size[1] / 2]
  });
}

function updateLocationVisibility() {
  const zoom = map.getZoom();
  const iconScale = locationIconScale(zoom);
  for (const item of locationMarkers) {
    if (item.iconScale !== iconScale) {
      const icon = locationIcon(item.style, item.faction, iconScale);
      item.marker.setIcon(icon);
      item.marker.getTooltip().options.offset = item.isTown
        ? L.point(0, icon.options.iconSize[1] / 2)
        : L.point(0, 0);
      item.iconScale = iconScale;
    }
    const shouldShow = locationsVisible && zoom >= item.minZoom;
    if (shouldShow && !map.hasLayer(item.marker)) item.marker.addTo(map);
    if (!shouldShow && map.hasLayer(item.marker)) item.marker.remove();
  }
}

function loadRoads() {
  roadsPromise ??= fetch('roads.geojson')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      roadsLayer = L.geoJSON(data, {
        renderer: roadRenderer,
        pane: 'roadPane',
        interactive: false,
        style: feature => feature.properties.hidden
          ? { color: '#ffd84d', weight: 2, opacity: 0.9, dashArray: '8 4' }
          : { color: '#ffd84d', weight: 2, opacity: 0.9 }
      });
      return roadsLayer;
    });
  return roadsPromise;
}

async function updateRoadVisibility() {
  if (!roadsVisible) {
    roadsLayer?.remove();
    return;
  }
  try {
    const layer = await loadRoads();
    if (roadsVisible && !map.hasLayer(layer)) layer.addTo(map);
  } catch (error) {
    status.textContent = `道路を読めません: ${error.message}`;
  }
}

function updateAreaLabelVisibility() {
  if ((areaNamesVisible || areaTextVisible) && map.getZoom() >= 2) {
    if (!map.hasLayer(areaLabels)) areaLabels.addTo(map);
  } else {
    areaLabels.remove();
  }
}

function redrawAreaLabels() {
  areaLabels.clearLayers();
  if (areaGeoJson) areaLabels.addData(areaGeoJson);
  updateAreaLabelVisibility();
}

function addLocations(locations, factions) {
  locationMarkers = locations.map(location => {
    const [style, minZoom] = locationStyle(location.type);
    const faction = factions[location.factionId ?? ''];
    const iconScale = locationIconScale();
    const icon = locationIcon(style, faction, iconScale);
    const isTown = location.type === 'TOWN_TOWN';
    const displayName = location.nameJa || location.name;
    const marker = L.marker(mapPoint(location.x, location.z), {
      icon, keyboard: true, title: isTown ? '' : `${displayName} / ${location.name}`
    });
    marker.bindTooltip(locationNameHtml(location), {
      direction: isTown ? 'center' : 'top', permanent: isTown,
      offset: isTown ? L.point(0, icon.options.iconSize[1] / 2) : L.point(0, 0),
      className: `location-tooltip${isTown ? ' town-label' : ''}`
    });
    marker.bindPopup(`<div class="location-popup"><strong>${locationNameHtml(location)}</strong>${factionChipHtml(faction)}<small class="location-type">${escapeHtml(location.type)}</small></div>`);
    return { marker, minZoom, style, faction, isTown, iconScale };
  });
  updateLocationVisibility();
}

fetch('resources.json')
  .then(response => response.json())
  .then(value => {
    config = value;
    map.setMaxZoom(value.tileMaxZoom);
    areaPolygons.setStyle(areaStyle);
    if (pendingLocations) {
      addLocations(pendingLocations.locations, pendingLocations.factions);
      pendingLocations = undefined;
    }
    const count = Object.keys(value.areas).length;
    status.textContent = count ? `${count}エリアの資源傾向を表示中。地図をクリックするとKenshi座標を表示します。` : '地図上をクリックするとKenshi座標を表示します。確率データは未生成です。';
  })
  .catch(error => { status.textContent = `データを読めません: ${error.message}`; });

Promise.all([
  fetch('locations.json').then(response => response.json()),
  fetch('factions.json').then(response => response.json())
])
  .then(([locations, factions]) => {
    renderFactionLegend(factions);
    if (config) addLocations(locations, factions);
    else pendingLocations = { locations, factions };
  })
  .catch(error => { status.textContent = `地点データを読めません: ${error.message}`; });

fetch('areas.geojson')
  .then(response => response.json())
  .then(data => {
    areaGeoJson = data;
    areaPolygons.addData(data);
    areaBoundaries.addData(data);
    redrawAreaLabels();
  })
  .catch(error => { status.textContent = `エリア境界を読めません: ${error.message}`; });

map.on('click', event => {
  if (!config) return;
  markSelectedPoint(event.latlng);
  const p = worldCoordinate(event.latlng);
  const request = ++coordinateRequest;
  status.innerHTML = coordinateHtml(p);
  hydrateTerrainHeight(p, request);
});

document.querySelectorAll('[data-resource]').forEach(button => {
  button.addEventListener('click', () => {
    resource = button.dataset.resource;
    document.querySelectorAll('[data-resource]').forEach(x => x.classList.toggle('active', x === button));
    areaPolygons.setStyle(areaStyle);
    updateLegend();
    redrawAreaLabels();
  });
});
document.querySelectorAll('[data-area-text]').forEach(input => {
  input.addEventListener('change', () => {
    input.dataset.areaText.split(' ').forEach(key => {
      if (input.checked) areaTextResources.add(key);
      else areaTextResources.delete(key);
    });
    redrawAreaLabels();
  });
});
document.querySelector('#areas-toggle').addEventListener('change', event => {
  boundariesVisible = event.target.checked;
  if (boundariesVisible) boundaries.addTo(map);
  else boundaries.remove();
});
document.querySelector('#area-names-toggle').addEventListener('change', event => {
  areaNamesVisible = event.target.checked;
  redrawAreaLabels();
});
document.querySelector('#area-text-toggle').addEventListener('change', event => {
  areaTextVisible = event.target.checked;
  areaTextOptions.disabled = !areaTextVisible;
  redrawAreaLabels();
});
document.querySelector('#locations-toggle').addEventListener('change', event => {
  locationsVisible = event.target.checked;
  updateLocationVisibility();
});
document.querySelector('#roads-toggle').addEventListener('change', event => {
  roadsVisible = event.target.checked;
  updateRoadVisibility();
});
document.querySelector('#controls-toggle').addEventListener('click', event => {
  const shell = document.querySelector('#controls-shell');
  const collapsed = shell.classList.toggle('collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  event.currentTarget.title = collapsed ? '操作パネルを開く' : '操作パネルを閉じる';
});
map.on('zoomend', () => {
  updateLocationVisibility();
  updateAreaLabelVisibility();
});
updateAreaLabelVisibility();
updateLegend();
updateRoadVisibility();
