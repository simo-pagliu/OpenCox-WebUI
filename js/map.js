// The Leaflet map: the track, the pace and SPM colour layers, and their
// legend.

function initMap() {
    return new Promise((resolve) => {
        const hasPoints = gpsPoints.length > 0;
        const centerLat = hasPoints ? gpsPoints[Math.floor(gpsPoints.length / 2)].lat : 0;
        const centerLon = hasPoints ? gpsPoints[Math.floor(gpsPoints.length / 2)].lon : 0;

        // Canvas rendering: the Pace/SPM layers are one polyline per GPS
        // segment (thousands), which SVG redraws far more slowly.
        map = L.map('map', {preferCanvas: true}).setView([centerLat, centerLon], hasPoints ? 15 : 2);
        // CARTO's free basemaps.cartocdn.com raster tiles now require a
        // signed-up API key (every tile silently comes back as a
        // watermarked "API KEY REQUIRED" placeholder without one). Esri's
        // World_Dark_Gray_Base is a free, key-less dark basemap that keeps
        // the same dark aesthetic; it tops out at native zoom 16, so
        // maxNativeZoom lets Leaflet upscale its tiles for closer zooms
        // instead of requesting tiles that don't exist.
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri',
            maxZoom: 19,
            maxNativeZoom: 16
        }).addTo(map);

        const fitToPoints = () => {
            if (hasPoints) {
                map.fitBounds(L.latLngBounds(gpsPoints.map(p => [p.lat, p.lon])));
            }
        };
        fitToPoints();

        // The map container's final layout size can still be settling at
        // this point (sibling elements above it are still rendering), which
        // leaves Leaflet's cached size stale and layers mispositioned until
        // the user pans/zooms. Force a recalculation once layout settles.
        requestAnimationFrame(() => {
            map.invalidateSize();
            fitToPoints();
            resolve();
        });

        // The map's panel is sized by the page layout, so it changes with
        // the window; keep Leaflet's cached size in step with it. The
        // #map element itself is permanent, so one observer is enough.
        if (!mapResizeObserver && typeof ResizeObserver !== 'undefined') {
            mapResizeObserver = new ResizeObserver(() => {
                if (map) {
                    map.invalidateSize();
                }
            });
            mapResizeObserver.observe(map.getContainer());
        }
    });
}

// ---------------------------------------------------------------
// Map overlays and their color scale
//
// Pace and SPM share one sequential blue ramp, dark to light, so "more"
// (a faster pace, a higher rate) always reads brighter on the dark
// basemap. The legend's gradient is built from the same stops, so the
// bar matches the line colors exactly. Segments without a meaningful
// value (paused, or no strokes detected) are drawn thinner, in gray.
// ---------------------------------------------------------------

const COLOR_RAMP = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
const COLOR_RAMP_RGB = COLOR_RAMP.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
const NO_DATA_COLOR = '#5c5f66';
// Share of values (at each end) a relative range leaves out, so a few
// GPS spikes don't stretch the whole scale.
const RELATIVE_RANGE_PERCENTILE = 5;

// Per layer: legend text, how to read and format a segment's value,
// and the absolute range as [dark end, bright end]. For pace the dark
// (slow) end is the larger number.
const OVERLAY_SCALES = {
    pace: {
        title: 'Pace (/500m)',
        absoluteRange: [180, 100], // 3:00 to 1:40
        noDataLabel: 'No strokes',
        valueAt: (i) => segmentPaces[i] || 0,
        hasValue: (pace) => pace > 0,
        // Tenths once the range is narrow enough for whole seconds to repeat
        formatTick: (pace, span) => formatPaceShort(pace, span < 8 ? 1 : 0),
        formatTooltip: (pace) => formatPace(pace) + ' /500m'
    },
    spm: {
        title: 'Stroke rate (SPM)',
        absoluteRange: [16, 40],
        noDataLabel: 'No strokes',
        valueAt: (i) => gpsPoints[i].spm || 0,
        hasValue: (spm) => spm > 0,
        formatTick: (spm, span) => spm.toFixed(span < 8 ? 1 : 0),
        formatTooltip: (spm) => spm.toFixed(1) + ' SPM'
    }
};

// 'absolute': the fixed ranges above, comparable across sessions.
// 'relative': fitted to the values on screen (the selection, if there
// is one), so variation within a piece stands out.
let colorScaleMode = 'absolute';

function setColorScaleMode(mode) {
    if (mode === colorScaleMode) {
        return;
    }
    colorScaleMode = mode;
    renderMapOverlay();
}

// t in [0, 1] -> color along COLOR_RAMP (linear between stops).
function rampColor(t) {
    const scaled = clamp(t, 0, 1) * (COLOR_RAMP_RGB.length - 1);
    const i = Math.min(Math.floor(scaled), COLOR_RAMP_RGB.length - 2);
    const fraction = scaled - i;
    const from = COLOR_RAMP_RGB[i];
    const to = COLOR_RAMP_RGB[i + 1];
    return 'rgb(' + from.map((c, k) => Math.round(c + (to[k] - c) * fraction)).join(', ') + ')';
}

function percentileOfSorted(sorted, pct) {
    const k = (sorted.length - 1) * (pct / 100);
    const f = Math.floor(k);
    const c = Math.ceil(k);
    return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

// [dark end, bright end] for this layer over segments startIdx..endIdx-1.
function getColorRange(type, startIdx, endIdx) {
    const scale = OVERLAY_SCALES[type];
    if (colorScaleMode !== 'relative') {
        return scale.absoluteRange;
    }

    const values = [];
    for (let i = startIdx; i < endIdx; i++) {
        const value = scale.valueAt(i);
        if (scale.hasValue(value)) {
            values.push(value);
        }
    }
    if (values.length < 2) {
        return scale.absoluteRange;
    }

    values.sort((a, b) => a - b);
    let low = percentileOfSorted(values, RELATIVE_RANGE_PERCENTILE);
    let high = percentileOfSorted(values, 100 - RELATIVE_RANGE_PERCENTILE);
    if (high - low < 1) {
        const mid = (low + high) / 2;
        low = mid - 0.5;
        high = mid + 0.5;
    }
    // Same orientation as the absolute range (pace runs slow to fast).
    const [darkEnd, brightEnd] = scale.absoluteRange;
    return darkEnd > brightEnd ? [high, low] : [low, high];
}

function colorForValue(value, range) {
    const [darkEnd, brightEnd] = range;
    return rampColor((value - darkEnd) / (brightEnd - darkEnd));
}

// One polyline per GPS segment from startIdx to endIdx, colored by that
// segment's value, each with its own hover tooltip.
function buildColoredOverlay(type, startIdx, endIdx, range) {
    const scale = OVERLAY_SCALES[type];
    const layerGroup = L.layerGroup();

    for (let i = startIdx; i < endIdx; i++) {
        const p1 = gpsPoints[i];
        const p2 = gpsPoints[i + 1];
        const value = scale.valueAt(i);
        const hasValue = scale.hasValue(value);

        L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], {
            color: hasValue ? colorForValue(value, range) : NO_DATA_COLOR,
            weight: hasValue ? 5 : 3,
            opacity: 0.95
        })
            .bindTooltip(hasValue ? scale.formatTooltip(value) : scale.noDataLabel, {
                sticky: true,
                direction: 'right',
                offset: [10, 0]
            })
            .addTo(layerGroup);
    }

    return layerGroup;
}

// Draws the map overlay for the layer picked in the dropdown. With a
// selection, the whole track is dimmed and only the selected part gets
// the highlight (Track) or the color scale (Pace/SPM).
function renderMapOverlay() {
    if (!map) {
        return;
    }
    mapOverlayLayers.forEach(layer => map.removeLayer(layer));
    mapOverlayLayers = [];

    if (gpsPoints.length < 2) {
        hideLegend();
        return;
    }

    const type = document.getElementById('layer-dropdown').value;
    const hasSelection = selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd;
    const startIdx = hasSelection ? selectionStart : 0;
    const endIdx = hasSelection ? selectionEnd : gpsPoints.length - 1;
    const toLatLng = (p) => [p.lat, p.lon];

    if (hasSelection) {
        mapOverlayLayers.push(L.polyline(gpsPoints.map(toLatLng), {
            color: THEME.dimTrack,
            weight: 2,
            opacity: 0.6
        }));
    }

    if (OVERLAY_SCALES[type]) {
        const range = getColorRange(type, startIdx, endIdx);
        mapOverlayLayers.push(buildColoredOverlay(type, startIdx, endIdx, range));
        renderLegend(type, range, hasSelection);
    } else {
        mapOverlayLayers.push(L.polyline(
            gpsPoints.slice(startIdx, endIdx + 1).map(toLatLng),
            hasSelection ? {color: THEME.highlight, weight: 4, opacity: 1.0} : {color: THEME.accent, weight: 3}
        ));
        hideLegend();
    }

    mapOverlayLayers.forEach(layer => layer.addTo(map));
}

const LEGEND_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

function renderLegend(type, range, hasSelection) {
    const scale = OVERLAY_SCALES[type];
    const [darkEnd, brightEnd] = range;
    const span = Math.abs(brightEnd - darkEnd);

    document.getElementById('legend-title').textContent = scale.title;
    document.getElementById('legend-bar').style.background = 'linear-gradient(to right, ' + COLOR_RAMP.join(', ') + ')';
    document.getElementById('legend-ticks').replaceChildren(...LEGEND_TICK_FRACTIONS.map((fraction) => {
        const label = document.createElement('span');
        label.style.left = (fraction * 100) + '%';
        label.textContent = scale.formatTick(darkEnd + (brightEnd - darkEnd) * fraction, span);
        return label;
    }));
    document.getElementById('legend-nodata-label').textContent = scale.noDataLabel;
    document.getElementById('legend-scope').textContent = colorScaleMode === 'relative'
        ? (hasSelection ? 'Fitted to selection' : 'Fitted to this session')
        : 'Fixed range';
    document.querySelectorAll('.scale-toggle button').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.scale === colorScaleMode));
    });
    document.getElementById('colorbar-fixed').classList.add('visible');
}

function hideLegend() {
    document.getElementById('colorbar-fixed').classList.remove('visible');
}
