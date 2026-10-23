// The pace & stroke rate profile chart, the selection pace chart, and their
// axes.

// Pace per stroke as chart points at each stroke's middle, for the
// strokes between fromX and toX meters. A null point breaks the line
// where strokes don't follow on and where the pace is off the axis.
function strokePaceSeries(fromX, toX) {
    const series = [];
    allStrokes.forEach((stroke) => {
        if (stroke.x < fromX || stroke.x > toX) {
            return;
        }
        const onAxis = stroke.pace >= PACE_AXIS_MIN && stroke.pace <= PACE_AXIS_MAX;
        if (!stroke.followsPrevious || !onAxis) {
            series.push({x: stroke.x, y: null, t: stroke.midS});
        }
        if (onAxis) {
            series.push({x: stroke.x, y: stroke.pace, t: stroke.midS});
        }
    });
    return series;
}

// Redraws the selection band on the profile chart (pace and SPM panels).
function redrawPaceProfileChart() {
    if (!paceProfileChart) {
        paceProfileChart = Chart.getChart('paceProfileChart');
    }
    if (paceProfileChart) {
        paceProfileChart.update('none');
    }
}

// Zoomed-in pace for just the selected range, on its own x scale from
// the selection's start to its end. With no selection the card shows a
// hint instead of an empty plot.
function updateSelectedPaceChart() {
    const existingChart = Chart.getChart('selectionPaceChart');
    if (existingChart) {
        existingChart.destroy();
    }

    const hasSelection = selectionStart !== null && selectionEnd !== null && selectionStart < selectionEnd;
    const chartPoints = hasSelection
        ? strokePaceSeries(cumulativeDistances[selectionStart], cumulativeDistances[selectionEnd])
        : [];
    const hasPace = chartPoints.some(point => point.y !== null);

    const emptyHint = document.getElementById('selectionPaceEmpty');
    if (emptyHint) {
        emptyHint.style.display = hasPace ? 'none' : '';
        emptyHint.textContent = hasSelection
            ? 'No strokes in this range.'
            : 'Select a range on the profile above to see its pace here.';
    }
    if (!hasPace) {
        return;
    }

    new Chart(document.getElementById('selectionPaceChart').getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                label: 'Pace',
                data: chartPoints,
                borderColor: THEME.accent,
                backgroundColor: THEME.accentSoft,
                borderWidth: 2,
                tension: 0.35,
                cubicInterpolationMode: 'monotone',
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHitRadius: 12,
                pointHoverBackgroundColor: THEME.accent,
                // The y-axis is reversed (faster pace at the top). Chart.js's
                // 'start'/'end' fill keywords resolve to the axis's pixel
                // start/end, which flips along with reverse and still shades
                // the wrong side — so target an explicit scale value instead
                // (the slow/max boundary), which always fills toward it.
                fill: {value: PACE_AXIS_MAX}
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Hover anywhere near a given x position (not just exactly on
            // the invisible point) to show that point's tooltip.
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            },
            scales: {
                y: {
                    min: PACE_AXIS_MIN,
                    max: PACE_AXIS_MAX,
                    reverse: true,
                    ticks: {stepSize: PACE_TICK_STEP, callback: (value) => formatPaceShort(value)}
                },
                x: {
                    type: 'linear',
                    min: cumulativeDistances[selectionStart],
                    max: cumulativeDistances[selectionEnd],
                    afterBuildTicks: (scale) => {
                        scale.ticks = buildDistanceTicks(scale);
                    },
                    // Plain meters: a zoomed range is often too short for
                    // formatDistanceLabel's 0.1 km steps to tell ticks apart.
                    ticks: {maxRotation: 0, autoSkip: true, callback: (value) => Math.round(value) + 'm'}
                }
            },
            plugins: {
                legend: {display: false},
                tooltip: {
                    callbacks: {
                        title: profileTooltipTitle,
                        label: (item) => 'Pace: ' + formatPace(item.parsed.y) + ' /500m'
                    }
                }
            }
        }
    });
}

// Helper function to get adaptive distance tick interval
// The smallest round step that keeps the axis to about ten labels. A
// step that would need more makes Chart.js fall back to an arbitrary
// spacing (labels like 987m, 3.9km).
function getDistanceTickInterval(maxDistance) {
    const steps = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
    return steps.find(step => maxDistance / step <= 10) || 20000;
}

// Helper function to format distance label
function formatDistanceLabel(meters) {
    if (meters >= 1000) {
        return (meters / 1000).toFixed(1) + 'km';
    }
    return meters.toFixed(0) + 'm';
}

// Helper function to get adaptive time tick interval
function getTimeTickInterval(maxTimeSeconds) {
    const maxTimeMinutes = maxTimeSeconds / 60;
    if (maxTimeMinutes <= 5) {
        return 60; // 1 minute intervals for short times
    } else if (maxTimeMinutes <= 20) {
        return 300; // 5 minute intervals for medium times
    } else if (maxTimeMinutes <= 60) {
        return 600; // 10 minute intervals for longer times
    } else {
        return 1800; // 30 minute intervals for very long times
    }
}

// Helper function to format time label as h:mm:ss
function formatTimeLabel(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return hours + ':' + minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
    }
    return minutes + ':' + secs.toString().padStart(2, '0');
}

// Pace axis range shared by the profile and selection charts (1:20 to
// 4:00 /500m); segments outside it (pauses, GPS spikes) aren't plotted.
const PACE_AXIS_MIN = 80;
const PACE_AXIS_MAX = 240;
const PACE_TICK_STEP = 40; // 1:20, 2:00, 2:40, 3:20, 4:00

// Tooltip title for points carrying {x: distance, t: elapsed seconds}.
function profileTooltipTitle(items) {
    if (!items.length) {
        return '';
    }
    const raw = items[0].raw;
    return Math.round(raw.x) + ' m · ' + formatTimeLabel(raw.t);
}

// Round-distance ticks (every getDistanceTickInterval meters) for an
// axis with an explicit min/max. Chart.js's own stepSize can't be used
// here: with both bounds set it stretches the step to divide the range
// evenly, giving labels like 2.1km, 4.2km.
function buildDistanceTicks(scale) {
    const step = getDistanceTickInterval(scale.max - scale.min);
    const ticks = [];
    for (let d = Math.ceil(scale.min / step) * step; d <= scale.max; d += step) {
        ticks.push({value: d});
    }
    return ticks;
}

// Ticks for the profile's top (time) axis. The chart's x axis is
// distance, and time isn't linear in distance (a pause spends minutes in
// a few meters), so each round time is placed at the distance covered
// by then. Labels that would land too close together (during a pause)
// are dropped.
const TIME_TICK_MIN_GAP_PX = 56;

function buildTimeAxisTicks(scale) {
    const step = getTimeTickInterval(totalTime);
    const metersPerPixel = (scale.max - scale.min) / Math.max(scale.width || 1, 1);
    const minGapMeters = TIME_TICK_MIN_GAP_PX * metersPerPixel;
    const ticks = [];
    let lastDistance = -Infinity;
    for (let t = 0; t <= totalTime; t += step) {
        const distance = distanceAtTime(t);
        if (distance - lastDistance >= minGapMeters) {
            ticks.push({value: distance, timeLabel: formatTimeLabel(t)});
            lastDistance = distance;
        }
    }
    return ticks;
}

// Hover mode for the profile chart's two stacked panels: the point
// nearest in x within whichever panel (pace or SPM) the pointer is
// over. Chart.js's own 'nearest' mode compares points across both
// panels and would often pick one from the other panel.
const PROFILE_HOVER_MODE = (typeof Chart !== 'undefined' && Chart.Interaction && Chart.Interaction.modes)
    ? 'profilePanel'
    : 'nearest';
if (PROFILE_HOVER_MODE === 'profilePanel') {
    Chart.Interaction.modes.profilePanel = function (chart, event) {
        const datasetIndex = chart.data.datasets.findIndex((dataset) => {
            const scale = chart.scales[dataset.yAxisID];
            return scale && event.y >= scale.top && event.y <= scale.bottom;
        });
        if (datasetIndex < 0) {
            return [];
        }
        let best = null;
        chart.getDatasetMeta(datasetIndex).data.forEach((element, index) => {
            if (element.skip) {
                return;
            }
            const dx = Math.abs(element.x - event.x);
            if (!best || dx < best.dx) {
                best = {element, datasetIndex, index, dx};
            }
        });
        return best ? [best] : [];
    };
}

// The profile chart: pace (top) and SPM (bottom) as two stacked panels
// of one chart, sharing the distance axis (bottom) and the time axis
// (top). Being one chart keeps the panels pixel-aligned, and the
// selection band (rangeSelectorPlugin) spans both.
function initPaceProfileChart() {
    const canvas = document.getElementById('paceProfileChart');
    if (!canvas || gpsPoints.length < 2) {
        return;
    }

    const existingChart = Chart.getChart(canvas);
    if (existingChart) {
        existingChart.destroy();
    }

    // Pace per stroke, plotted at the stroke's middle.
    const pacePoints = strokePaceSeries(-Infinity, Infinity);

    // SPM as logged at each GPS point. 0 means "no recent strokes
    // detected": leave a gap (null) rather than drawing down to zero.
    const spmPoints = gpsPoints.map((point, i) => ({
        x: cumulativeDistances[i],
        y: point.spm > 0 ? point.spm : null,
        t: cumulativeTimes[i]
    }));

    paceProfileChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                label: 'Pace',
                yAxisID: 'yPace',
                data: pacePoints,
                borderColor: THEME.accent,
                backgroundColor: THEME.accentSoft,
                borderWidth: 2,
                tension: 0.35,
                cubicInterpolationMode: 'monotone',
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHitRadius: 12,
                pointHoverBackgroundColor: THEME.accent,
                // The y-axis is reversed (faster pace at the top). Chart.js's
                // 'start'/'end' fill keywords resolve to the axis's pixel
                // start/end, which flips along with reverse and still shades
                // the wrong side — so target an explicit scale value instead
                // (the slow/max boundary), which always fills toward it.
                fill: {value: PACE_AXIS_MAX}
            }, {
                label: 'SPM',
                yAxisID: 'ySpm',
                data: spmPoints,
                borderColor: THEME.accent,
                borderWidth: 1.5,
                tension: 0.2,
                cubicInterpolationMode: 'monotone',
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHitRadius: 12,
                pointHoverBackgroundColor: THEME.accent
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: PROFILE_HOVER_MODE,
                axis: 'x',
                intersect: false
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    min: 0,
                    max: totalDistance,
                    afterBuildTicks: (scale) => {
                        scale.ticks = buildDistanceTicks(scale);
                    },
                    ticks: {
                        maxRotation: 0,
                        autoSkip: true,
                        callback: (value) => formatDistanceLabel(value)
                    }
                },
                xTime: {
                    type: 'linear',
                    position: 'top',
                    min: 0,
                    max: totalDistance,
                    afterBuildTicks: (scale) => {
                        scale.ticks = buildTimeAxisTicks(scale);
                    },
                    ticks: {
                        autoSkip: false,
                        maxRotation: 0,
                        callback: (value, index, ticks) => (ticks[index] ? ticks[index].timeLabel : '')
                    },
                    grid: {drawOnChartArea: false}
                },
                // Stacked panels: Chart.js draws the last listed axis of
                // a stack on top, so SPM is listed first to sit below pace.
                ySpm: {
                    stack: 'profile',
                    stackWeight: 2,
                    suggestedMin: 16,
                    suggestedMax: 40,
                    title: {display: true, text: 'SPM'},
                    // The top label would sit on the panel boundary, on top
                    // of the pace panel's bottom label.
                    ticks: {maxTicksLimit: 4, callback: (value, index, ticks) => (index === ticks.length - 1 ? '' : value)}
                },
                yPace: {
                    stack: 'profile',
                    stackWeight: 3,
                    min: PACE_AXIS_MIN,
                    max: PACE_AXIS_MAX,
                    reverse: true,
                    title: {display: true, text: 'Pace /500m'},
                    ticks: {stepSize: PACE_TICK_STEP, callback: (value) => formatPaceShort(value)}
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        title: profileTooltipTitle,
                        label: (item) => (item.dataset.yAxisID === 'yPace'
                            ? 'Pace: ' + formatPace(item.parsed.y) + ' /500m'
                            : 'SPM: ' + item.parsed.y.toFixed(1))
                    }
                }
            }
        },
        plugins: [rangeSelectorPlugin]
    });

    bindRangeSelector(canvas);
    redrawPaceProfileChart();
    updateSelectedPaceChart();
}
