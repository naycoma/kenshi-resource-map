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

const base = L.tileLayer('tiles/base/{z}/{y}/{x}.png', {
  minZoom: 0, maxZoom: 5, noWrap: true, bounds, tileSize: 256
}).addTo(map);
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
const areaRenderer = L.canvas({ padding: 0.5 });

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

const areaPolygons = L.geoJSON(null, {
  renderer: areaRenderer,
  filter: feature => feature.properties.kind === 'area',
  style: areaStyle,
  bubblingMouseEvents: false,
  onEachFeature: (feature, layer) => {
    layer.on('click', event => {
      if (!config) return;
      status.innerHTML = areaDetail(feature.properties, worldCoordinate(event.latlng));
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
    const chips = specialChips(values);
    return L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: 'area-label-wrap',
        html: `<span class="area-label"><b>${escapeHtml(values.biome)}</b>${lines.length ? `<small>${lines.join('<br>')}</small>` : ''}${chipHtml(chips)}</span>`,
        iconSize: [180, 80], iconAnchor: [90, 40]
      })
    });
  }
});
const areas = L.layerGroup([areaBoundaries]).addTo(map);
map.fitBounds(bounds);

let locationsVisible = document.querySelector('#locations-toggle').checked;
let locationMarkers = [];
let pendingLocations;
let areasVisible = document.querySelector('#areas-toggle').checked;
let areaGeoJson;
const status = document.querySelector('#status');

function worldCoordinate(latlng) {
  const span = config.world.max - config.world.min;
  return {
    x: config.world.min + (latlng.lng / mapSize) * span,
    z: config.world.min + (-latlng.lat / mapSize) * span
  };
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

function weatherChipHtml(names) {
  if (!names?.length) return '<span class="muted">なし</span>';
  return `<span class="area-chips detail-weather">${names.map(name => `<i class="area-chip weather-name">${escapeHtml(name)}</i>`).join('')}</span>`;
}

function percent(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function areaDetail(area, point) {
  const chips = specialChips(area);
  return `<article class="area-detail">
    <h2>${escapeHtml(area.biome)}</h2>
    <div class="coordinate">X ${point.x.toFixed(0)} / Z ${point.z.toFixed(0)}</div>
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
        <thead><tr><th>種類</th><th>通常</th><th>最低</th></tr></thead>
        <tbody>
          <tr><th>水</th><td>${percent(area.waterMultiplier)}</td><td>${percent(area.waterMin)}</td></tr>
          <tr><th>肥沃度</th><td>${percent(area.fertilityMultiplier)}</td><td>${percent(area.fertilityMin)}</td></tr>
        </tbody>
      </table>
    </div>
    <dl class="detail-misc">
      <dt>風速</dt><dd>${Number(area.windMin).toFixed(0)}–${Number(area.windMax).toFixed(0)}</dd>
      <dt>天候候補</dt><dd>${weatherChipHtml(area.weatherNames)}</dd>
    </dl>
  </article>`;
}

function locationStyle(type) {
  return ({
    TOWN_TOWN: ['town', 0], TOWN_VILLAGE: ['village', 2], TOWN_OUTPOST: ['outpost', 2],
    TOWN_MILITARY: ['military', 2], TOWN_PRISON: ['prison', 2], TOWN_SLAVE_CAMP: ['slave-camp', 2],
    TOWN_RUINS: ['ruins', 3], TOWN_POI: ['poi', 3], TOWN_NEST_MARKER: ['nest', 3]
  })[type] ?? ['poi', 3];
}

function updateLocationVisibility() {
  const zoom = map.getZoom();
  for (const item of locationMarkers) {
    const shouldShow = locationsVisible && zoom >= item.minZoom;
    if (shouldShow && !map.hasLayer(item.marker)) item.marker.addTo(map);
    if (!shouldShow && map.hasLayer(item.marker)) item.marker.remove();
  }
}

function updateAreaLabelVisibility() {
  if (!areasVisible) return;
  if (map.getZoom() >= 2) {
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

function addLocations(locations) {
  locationMarkers = locations.map(location => {
    const [style, minZoom] = locationStyle(location.type);
    const icon = L.divIcon({
      className: 'location-icon-wrap',
      html: `<span class="location-pin ${style}"></span>`,
      iconSize: [13, 18], iconAnchor: [6, 15], popupAnchor: [0, -13]
    });
    const marker = L.marker(mapPoint(location.x, location.z), { icon, keyboard: true, title: location.name });
    marker.bindTooltip(escapeHtml(location.name), { direction: 'top', className: 'location-tooltip' });
    marker.bindPopup(`<div class="location-popup"><strong>${escapeHtml(location.name)}</strong>${escapeHtml(location.faction || 'No faction')}<br><small>${escapeHtml(location.type)}</small></div>`);
    return { marker, minZoom };
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
      addLocations(pendingLocations);
      pendingLocations = undefined;
    }
    const count = Object.keys(value.areas).length;
    status.textContent = count ? `${count}エリアの資源傾向を表示中。地図をクリックするとKenshi座標を表示します。` : '地図上をクリックするとKenshi座標を表示します。確率データは未生成です。';
  })
  .catch(error => { status.textContent = `データを読めません: ${error.message}`; });

fetch('locations.json')
  .then(response => response.json())
  .then(locations => {
    if (config) addLocations(locations); else pendingLocations = locations;
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
  const p = worldCoordinate(event.latlng);
  status.textContent = `X ${p.x.toFixed(0)} / Z ${p.z.toFixed(0)}`;
});

document.querySelectorAll('[data-resource]').forEach(button => {
  button.addEventListener('click', () => {
    resource = button.dataset.resource;
    document.querySelectorAll('[data-resource]').forEach(x => x.classList.toggle('active', x === button));
    areaPolygons.setStyle(areaStyle);
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
  areasVisible = event.target.checked;
  if (areasVisible) {
    areas.addTo(map);
    updateAreaLabelVisibility();
  } else {
    areas.remove();
    areaLabels.remove();
  }
});
document.querySelector('#locations-toggle').addEventListener('change', event => {
  locationsVisible = event.target.checked;
  updateLocationVisibility();
});
map.on('zoomend', () => {
  updateLocationVisibility();
  updateAreaLabelVisibility();
});
updateAreaLabelVisibility();
