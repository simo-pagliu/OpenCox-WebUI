// State shared by the page's scripts: the loaded session, the selection, the
// map layers and charts, and the dark theme's colours for Chart.js.

let gpsPoints = [];
let map;

// The current selection, in meters along the track — this is the single
// source of truth. It's what's drawn on the pace chart and what the map
// highlight/section stats are derived from (via the index pair below).
// Using distance (not point index) throughout avoids a subtle bug the old
// slider had: GPS points are roughly evenly spaced in *time*, not distance
// (a pause packs many points into a few meters), so an index-based '%'
// position and a distance-based chart axis silently disagree.
let selectionStartDistance = null;
let selectionEndDistance = null;
// Point indices into gpsPoints matching the distances above, kept in sync
// by setSelectionRange() — these are what the map/stats API calls use.
let selectionStart = null;
let selectionEnd = null;

// Every Leaflet layer currently drawn by renderMapOverlay(), so the
// next render can remove exactly those before drawing its own.
let mapOverlayLayers = [];
let mapResizeObserver = null;

let totalDistance = 0;
let totalTime = 0;
let cumulativeDistances = [];
let cumulativeTimes = [];
// Pace is per stroke: the mean GPS speed from one catch to the next.
// allStrokes holds them on the session's axes (see placeStrokes);
// segmentPaces[i] is the pace of the stroke that track segment
// i -> i + 1 falls in, 0 outside any stroke (map colors).
let allStrokes = [];
let segmentPaces = [];

// Chart references
let paceProfileChart = null;

// Dark theme palette, kept in sync with the CSS custom properties in
// index.css. Chart.js draws to canvas, so it needs its own copy of the
// colors rather than inheriting them from the stylesheet.
const THEME = {
    accent: '#4da3ff',
    accentSoft: 'rgba(77, 163, 255, 0.18)',
    highlight: '#8ecbff',
    cyan: '#22d3ee',
    dimTrack: '#3a4356',
    panelBg: '#1b212f',
    text: '#c7cee0',
    textMuted: '#8891a5',
    grid: 'rgba(255, 255, 255, 0.08)'
};
if (typeof Chart !== 'undefined') {
    Chart.defaults.color = THEME.text;
    Chart.defaults.borderColor = THEME.grid;
    Chart.defaults.font.size = 11;
}
