// The stats box and the pace and SPM distribution charts.

function updateStatsBox(statsData) {
    // Update the main stats box with the provided stats
    // Use null checks and default values to prevent errors
    const totalDistance = (statsData.total_distance || 0).toFixed(1) + 'm';
    const totalTime = formatTime(statsData.total_time || 0);
    const avgSpeed = (statsData.avg_speed || 0).toFixed(3) + ' m/s';
    const avgPace = formatPace(statsData.avg_pace || 0);
    const avgSPM = (statsData.avg_spm || 0).toFixed(1);
    
    document.getElementById('analysis-distance').textContent = totalDistance;
    document.getElementById('analysis-time').textContent = totalTime;
    document.getElementById('analysis-avg-pace').textContent = avgPace;
    document.getElementById('analysis-avg-spm').textContent = avgSPM;
    
    // Update detailed stats for speed
    const speedAvg = (statsData.avg_speed || 0).toFixed(3) + ' m/s';
    const speedMedian = (statsData.median_speed || 0).toFixed(3) + ' m/s';
    const speedMin = (statsData.min_speed || 0).toFixed(3) + ' m/s';
    const speedMax = (statsData.max_speed || 0).toFixed(3) + ' m/s';
    const speedLow = (statsData.speed_percentile_1 || 0).toFixed(3) + ' m/s';
    const speedHigh = (statsData.speed_percentile_99 || 0).toFixed(3) + ' m/s';
    
    document.getElementById('speed-avg').textContent = speedAvg;
    document.getElementById('speed-median').textContent = speedMedian;
    document.getElementById('speed-min').textContent = speedMin;
    document.getElementById('speed-max').textContent = speedMax;
    document.getElementById('speed-low').textContent = speedLow;
    document.getElementById('speed-high').textContent = speedHigh;
    
    // Update detailed stats for pace
    const paceAvg = formatPace(statsData.avg_pace || 0);
    const paceMedian = formatPace(statsData.median_pace || 0);
    const paceMin = formatPace(statsData.min_pace || 0);
    const paceMax = formatPace(statsData.max_pace || 0);
    const paceLow = formatPace(statsData.pace_percentile_1 || 0);
    const paceHigh = formatPace(statsData.pace_percentile_99 || 0);
    
    document.getElementById('pace-avg').textContent = paceAvg;
    document.getElementById('pace-median').textContent = paceMedian;
    document.getElementById('pace-min').textContent = paceMin;
    document.getElementById('pace-max').textContent = paceMax;
    document.getElementById('pace-low').textContent = paceLow;
    document.getElementById('pace-high').textContent = paceHigh;
    
    // Update detailed stats for SPM (placeholders for now)
    const spmAvg = (statsData.avg_spm || 0).toFixed(1);
    const spmMedian = (statsData.median_spm || 0).toFixed(1);
    const spmMin = (statsData.min_spm || 0).toFixed(1);
    const spmMax = (statsData.max_spm || 0).toFixed(1);
    const spmLow = (statsData.spm_percentile_1 || 0).toFixed(1);
    const spmHigh = (statsData.spm_percentile_99 || 0).toFixed(1);
    
    document.getElementById('spm-avg').textContent = spmAvg;
    document.getElementById('spm-median').textContent = spmMedian;
    document.getElementById('spm-min').textContent = spmMin;
    document.getElementById('spm-max').textContent = spmMax;
    document.getElementById('spm-low').textContent = spmLow;
    document.getElementById('spm-high').textContent = spmHigh;

    // Show stats box
    document.getElementById('stats-box').classList.add('visible');

    updateDistributionCharts(statsData);
}

// Bucket raw values into evenly-sized bins between min/max, expressed as
// a percentage of the (valid, in-range) sample count — a distribution,
// not a raw histogram.
function buildHistogram(values, min, max, binCount) {
    const filtered = (values || []).filter(v => typeof v === 'number' && isFinite(v) && v >= min && v <= max);
    if (filtered.length === 0) {
        return {binCenters: [], percentages: []};
    }

    const binWidth = (max - min) / binCount;
    const counts = new Array(binCount).fill(0);
    filtered.forEach(v => {
        let idx = Math.floor((v - min) / binWidth);
        idx = Math.max(0, Math.min(binCount - 1, idx));
        counts[idx]++;
    });

    const total = filtered.length;
    const percentages = counts.map(c => (c / total) * 100);
    const binCenters = counts.map((_, i) => min + (i + 0.5) * binWidth);
    return {binCenters, percentages};
}

function renderDistributionChart(canvasId, values, {min, max, binCount, formatLabel, axisTitle, tickStep, unit = 'samples'}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        return;
    }

    const existingChart = Chart.getChart(canvasId);
    if (existingChart) {
        existingChart.destroy();
    }

    const {binCenters, percentages} = buildHistogram(values, min, max, binCount);
    if (binCenters.length === 0) {
        return;
    }

    // Plot as a smoothed density curve (points at each bin's center,
    // connected with a monotone curve) rather than discrete bars.
    const points = binCenters.map((center, i) => ({x: center, y: percentages[i]}));

    new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                data: points,
                borderColor: THEME.accent,
                backgroundColor: THEME.accentSoft,
                borderWidth: 2.5,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHitRadius: 12,
                pointHoverBackgroundColor: THEME.accent,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Hover anywhere near a given x position (not just exactly on
            // the invisible point) to show that bin's tooltip.
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            },
            // The card's caption names the measure, so the axes only
            // carry units (in the tick labels) to stay compact.
            scales: {
                x: {
                    type: 'linear',
                    min,
                    max,
                    title: {display: false, text: axisTitle},
                    ticks: {maxRotation: 0, autoSkip: true, maxTicksLimit: 5, stepSize: tickStep, callback: formatLabel},
                    grid: {display: false}
                },
                y: {
                    beginAtZero: true,
                    ticks: {maxTicksLimit: 5, callback: (v) => v + '%'}
                }
            },
            plugins: {
                legend: {display: false},
                tooltip: {
                    callbacks: {
                        title: (items) => items.length ? formatLabel(items[0].parsed.x) : '',
                        label: (item) => item.parsed.y.toFixed(1) + '% of ' + unit
                    }
                }
            }
        }
    });
}

function updateDistributionCharts(statsData) {
    renderDistributionChart('paceDistributionChart', statsData.paces, {
        min: 80,
        max: 240,
        binCount: 16,
        tickStep: PACE_TICK_STEP,
        formatLabel: (v) => formatPaceShort(v),
        axisTitle: 'Pace (/500m)',
        unit: 'strokes'
    });

    const validSpms = (statsData.spms || []).filter(v => v > 0);
    const spmMax = validSpms.length > 0 ? Math.max(...validSpms) : 40;
    renderDistributionChart('spmDistributionChart', statsData.spms, {
        min: 10,
        max: Math.max(40, Math.ceil(spmMax / 5) * 5),
        binCount: 12,
        formatLabel: (v) => v.toFixed(0),
        axisTitle: 'SPM'
    });
}
