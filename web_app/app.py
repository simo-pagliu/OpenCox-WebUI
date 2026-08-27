"""Simple Flask Web App for Rowing Data Analysis using the mixed Pico log only."""

from flask import Flask, render_template, request, jsonify, send_from_directory
import csv
import json
import math
import os
import subprocess
import sys
from werkzeug.utils import secure_filename


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = Flask(__name__)

try:
    from analysis_pipeline.gps_analysis import DEFAULT_PAUSE_THRESHOLD
except ImportError:
    DEFAULT_PAUSE_THRESHOLD = 1.5


UPLOAD_FOLDER = 'output'
UPLOAD_TEMP_FOLDER = 'uploads_temp'
CURRENT_UPLOAD_FILENAME = 'current_upload.csv'
ALLOWED_EXTENSIONS = {'csv'}

CURRENT_CSV_FILE = None

MIXED_HEADER = [
    'record_type', 'date', 'time', 'uptime_ms', 'accel_x', 'accel_y', 'accel_z',
    'gyro_x', 'gyro_y', 'gyro_z', 'speed_mps', 'spm', 'gps_lat', 'gps_lon',
    'distance_m', 'stroke_flag', 'sats', 'hdop', 'fix_quality', 'course_deg',
    'catch_duration_ms', 'exit_duration_ms', 'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4'
]

SHAPE_POINT_COUNT = 5

MAX_GPS_POINT_SPEED_MPS = 15.0


os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(UPLOAD_TEMP_FOLDER, exist_ok=True)


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def get_current_csv_file():
    global CURRENT_CSV_FILE
    if CURRENT_CSV_FILE is None:
        uploaded_file = os.path.join(UPLOAD_TEMP_FOLDER, CURRENT_UPLOAD_FILENAME)
        if os.path.exists(uploaded_file):
            CURRENT_CSV_FILE = uploaded_file
    return CURRENT_CSV_FILE


def set_current_csv_file(filepath):
    global CURRENT_CSV_FILE
    if os.path.exists(filepath) and filepath.lower().endswith('.csv'):
        CURRENT_CSV_FILE = filepath
        return True
    return False


def clear_current_csv_file():
    global CURRENT_CSV_FILE
    uploaded_file = os.path.join(UPLOAD_TEMP_FOLDER, CURRENT_UPLOAD_FILENAME)
    if os.path.exists(uploaded_file):
        try:
            os.remove(uploaded_file)
        except OSError:
            pass
    CURRENT_CSV_FILE = None


def _validate_mixed_header(fieldnames):
    if list(fieldnames or []) != MIXED_HEADER:
        raise ValueError('Unsupported CSV format. Expected the mixed Pico log header.')


def load_gps_points(csv_path):
    gps_points = []
    with open(csv_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        _validate_mixed_header(reader.fieldnames)

        for index, row in enumerate(reader):
            if (row.get('record_type') or '').strip().upper() != 'G':
                continue

            try:
                lat = float(row.get('gps_lat', ''))
                lon = float(row.get('gps_lon', ''))
            except (TypeError, ValueError):
                continue

            if lat == 0 or lon == 0:
                continue

            time_value = float(row.get('time', 0) or 0) * 1000.0
            if time_value <= 0:
                continue

            speed_mps = float(row.get('speed_mps', 0) or 0)
            spm_value = float(row.get('spm', 0) or 0)

            gps_points.append({
                'lat': lat,
                'lon': lon,
                'time': time_value,
                'index': index,
                'speed_mps': speed_mps,
                'spm': spm_value,
                'uptime_ms': int(float(row.get('uptime_ms', 0) or 0)),
                'sats': row.get('sats', ''),
                'hdop': row.get('hdop', ''),
                'fix_quality': row.get('fix_quality', ''),
                'course_deg': row.get('course_deg', ''),
            })

    gps_points.sort(key=lambda point: (point['time'], point['index']))

    ordered_points = []
    for point in gps_points:
        if ordered_points:
            previous_point = ordered_points[-1]
            delta_ms = point['time'] - previous_point['time']
            if delta_ms <= 0:
                continue

            distance_m = haversine(previous_point['lat'], previous_point['lon'], point['lat'], point['lon'])
            implied_speed = distance_m / (delta_ms / 1000.0)
            if implied_speed > MAX_GPS_POINT_SPEED_MPS:
                continue

        if ordered_points and ordered_points[-1]['lat'] == point['lat'] and ordered_points[-1]['lon'] == point['lon']:
            continue
        ordered_points.append(point)

    return ordered_points


def _parse_optional_float(value):
    if value in (None, ''):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_stroke_events(csv_path, start_uptime_ms=None, end_uptime_ms=None):
    """Extract per-stroke catch/exit transient durations and shape points from A rows.

    uptime_ms is the shared Pico monotonic clock written by both A and G
    rows, so a GPS-based time-range selection can be translated into an
    uptime_ms window and used to filter these accel-derived events without
    needing a second, GPS-synced clock.
    """
    catch_durations_ms = []
    exit_durations_ms = []
    shapes = []

    with open(csv_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        _validate_mixed_header(reader.fieldnames)

        for row in reader:
            if (row.get('record_type') or '').strip().upper() != 'A':
                continue

            uptime_val = _parse_optional_float(row.get('uptime_ms'))
            if uptime_val is None:
                continue
            if start_uptime_ms is not None and uptime_val < start_uptime_ms:
                continue
            if end_uptime_ms is not None and uptime_val > end_uptime_ms:
                continue

            catch_duration = _parse_optional_float(row.get('catch_duration_ms'))
            if catch_duration is not None:
                catch_durations_ms.append(catch_duration)

            exit_duration = _parse_optional_float(row.get('exit_duration_ms'))
            if exit_duration is not None:
                exit_durations_ms.append(exit_duration)

            shape_values = [_parse_optional_float(row.get('shape_%d' % i)) for i in range(SHAPE_POINT_COUNT)]
            if all(v is not None for v in shape_values):
                shapes.append(shape_values)

    return {
        'catch_durations_ms': catch_durations_ms,
        'exit_durations_ms': exit_durations_ms,
        'shapes': shapes,
    }


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2) ** 2 +
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def analyze_section(gps_points, start_idx, end_idx, pause_threshold=None):
    if pause_threshold is None:
        pause_threshold = DEFAULT_PAUSE_THRESHOLD

    if start_idx >= end_idx or start_idx < 0 or end_idx >= len(gps_points):
        return None

    section_points = gps_points[start_idx:end_idx + 1]
    if len(section_points) < 2:
        return None

    total_distance = 0.0
    moving_distance = 0.0
    speeds = []
    paces = []
    spms = []
    times = []
    cumulative_distances = [0.0]
    moving_distances = [0.0]
    is_pause = [False]

    for i in range(len(section_points) - 1):
        p1 = section_points[i]
        p2 = section_points[i + 1]
        dist = haversine(p1['lat'], p1['lon'], p2['lat'], p2['lon'])
        total_distance += dist
        cumulative_distances.append(total_distance)

        time_diff = (p2['time'] - p1['time']) / 1000.0
        if time_diff > 0:
            speed = dist / time_diff
            pace = 500.0 / speed if speed > 0 else 0.0
        else:
            speed = 0.0
            pace = 0.0

        speeds.append(speed)
        paces.append(pace)

        if pause_threshold is not None and speed < pause_threshold:
            is_pause.append(True)
            moving_distances.append(moving_distances[-1])
        else:
            is_pause.append(False)
            moving_distance += dist
            moving_distances.append(moving_distance)

        spms.append(float(p1.get('spm', 0.0) or 0.0))
        times.append(p2['time'])

    total_time = (times[-1] - times[0]) / 1000.0 if times else 0.0
    moving_time = 0.0
    if pause_threshold is None:
        moving_time = total_time
    else:
        for i in range(len(section_points) - 1):
            segment_time = (section_points[i + 1]['time'] - section_points[i]['time']) / 1000.0
            if not is_pause[i + 1]:
                moving_time += segment_time

    pause_count = 0
    in_pause = False
    for i in range(1, len(is_pause)):
        if is_pause[i] and not in_pause:
            pause_count += 1
            in_pause = True
        elif not is_pause[i]:
            in_pause = False

    pause_percentage = ((total_time - moving_time) / total_time) * 100.0 if total_time > 0 else 0.0
    avg_speed = moving_distance / moving_time if moving_time > 0 else 0.0
    avg_pace = 500.0 / avg_speed if avg_speed > 0 else 0.0

    valid_speeds = [s for s in speeds if s > 0]
    valid_paces = [p for p in paces if p > 0]
    valid_spms = [s for s in spms if s > 0]

    def median(values):
        if not values:
            return 0.0
        values = sorted(values)
        n = len(values)
        if n % 2:
            return values[n // 2]
        return (values[n // 2 - 1] + values[n // 2]) / 2

    def percentile(values, pct):
        if not values:
            return 0.0
        values = sorted(values)
        k = (len(values) - 1) * (pct / 100)
        f = math.floor(k)
        c = math.ceil(k)
        if f == c:
            return values[int(k)]
        return values[f] * (c - k) + values[c] * (k - f)

    return {
        'start_idx': start_idx,
        'end_idx': end_idx,
        'point_count': len(section_points),
        'total_distance': total_distance,
        'moving_distance': moving_distance,
        'total_time': total_time,
        'moving_time': moving_time,
        'avg_speed': avg_speed,
        'avg_pace': avg_pace,
        'min_speed': min(valid_speeds) if valid_speeds else 0.0,
        'max_speed': max(valid_speeds) if valid_speeds else 0.0,
        'min_pace': min(valid_paces) if valid_paces else 0.0,
        'max_pace': max(valid_paces) if valid_paces else 0.0,
        'median_speed': median(valid_speeds),
        'median_pace': median(valid_paces),
        'speed_percentile_1': percentile(valid_speeds, 1),
        'speed_percentile_99': percentile(valid_speeds, 99),
        'pace_percentile_1': percentile(valid_paces, 1),
        'pace_percentile_99': percentile(valid_paces, 99),
        'avg_spm': sum(valid_spms) / len(valid_spms) if valid_spms else 0.0,
        'min_spm': min(valid_spms) if valid_spms else 0.0,
        'max_spm': max(valid_spms) if valid_spms else 0.0,
        'median_spm': median(valid_spms),
        'spm_percentile_1': percentile(valid_spms, 1),
        'spm_percentile_99': percentile(valid_spms, 99),
        'pause_percentage': pause_percentage,
        'pause_count': pause_count,
        'is_pause': is_pause,
        'start_lat': section_points[0]['lat'],
        'start_lon': section_points[0]['lon'],
        'end_lat': section_points[-1]['lat'],
        'end_lon': section_points[-1]['lon'],
        'speeds': speeds,
        'paces': paces,
        'spms': spms,
        'cumulative_distances': cumulative_distances,
        'moving_distances': moving_distances,
    }


def _require_current_file():
    current_file = get_current_csv_file()
    if not current_file:
        return None, (jsonify({'status': 'error', 'message': 'No CSV file selected'}), 400)
    return current_file, None


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/gps_points')
def get_gps_points():
    current_file = get_current_csv_file()
    if not current_file:
        return jsonify([])
    try:
        return jsonify(load_gps_points(current_file))
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400


@app.route('/api/section_stats', methods=['POST'])
def section_stats():
    data = request.get_json() or {}
    start_idx = data.get('start_idx', 0)
    end_idx = data.get('end_idx', 0)
    pause_threshold = data.get('pause_threshold', DEFAULT_PAUSE_THRESHOLD)

    if pause_threshold is not None and (not isinstance(pause_threshold, (int, float)) or pause_threshold <= 0):
        pause_threshold = None

    current_file, error_response = _require_current_file()
    if error_response:
        return error_response

    try:
        gps_points = load_gps_points(current_file)
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400

    stats = analyze_section(gps_points, start_idx, end_idx, pause_threshold=pause_threshold)
    if stats is None:
        return jsonify({'status': 'error', 'message': 'Invalid section range or not enough points'}), 400

    return jsonify({'status': 'success', 'stats': stats})


@app.route('/api/stroke_stats', methods=['POST'])
def stroke_stats():
    """Catch/exit transient durations and stroke-shape points for a time range.

    The range is given directly as uptime_ms bounds (the clock shared by A
    and G rows) rather than gps_points indices, since the frontend already
    has each gps_point's uptime_ms and can compute the bounds itself; both
    bounds are optional and default to the whole file.
    """
    data = request.get_json() or {}
    start_uptime_ms = _parse_optional_float(data.get('start_uptime_ms'))
    end_uptime_ms = _parse_optional_float(data.get('end_uptime_ms'))

    current_file, error_response = _require_current_file()
    if error_response:
        return error_response

    try:
        result = load_stroke_events(current_file, start_uptime_ms, end_uptime_ms)
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400

    return jsonify({'status': 'success', 'stroke_stats': result})


@app.route('/api/process', methods=['POST'])
def process():
    data = request.get_json() or {}
    exclude_ranges = data.get('exclude_ranges', [])
    pause_threshold = data.get('pause_threshold', DEFAULT_PAUSE_THRESHOLD)

    current_file, error_response = _require_current_file()
    if error_response:
        return error_response

    exclude_str = ','.join(f"{start}-{end}" for start, end in exclude_ranges)
    cmd = [
        sys.executable,
        '-m', 'analysis_pipeline.process_csv',
        '--csv', current_file,
        '--exclude', exclude_str,
        '--output-dir', UPLOAD_FOLDER,
        '--pause-threshold', str(pause_threshold),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        if result.stderr:
            print('STDERR:', result.stderr)

        analysis_json_path = os.path.join(UPLOAD_FOLDER, 'analysis_results.json')
        analysis_data = {}
        if os.path.exists(analysis_json_path):
            with open(analysis_json_path, 'r') as f:
                analysis_data = json.load(f)

        gps_points = load_gps_points(current_file)
        filtered_gps_points = [p for i, p in enumerate(gps_points) if not any(start <= i <= end for start, end in exclude_ranges)]
        spm_values = [float(point.get('spm', 0.0) or 0.0) for point in filtered_gps_points]
        valid_spm_values = [value for value in spm_values if value > 0]

        analysis_data['spms'] = spm_values
        analysis_data['avg_spm'] = (sum(valid_spm_values) / len(valid_spm_values)) if valid_spm_values else 0.0

        return jsonify({
            'status': 'success',
            'gps_file': os.path.join(UPLOAD_FOLDER, 'gps_data.csv'),
            'accel_file': os.path.join(UPLOAD_FOLDER, 'accel_data.csv'),
            'analysis': analysis_data,
        })
    except subprocess.CalledProcessError as exc:
        return jsonify({'status': 'error', 'message': exc.stderr or str(exc)}), 500


@app.route('/output/<path:filename>')
def download_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename, as_attachment=True)


@app.route('/api/upload_csv', methods=['POST'])
def upload_csv():
    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': 'No file part in the request'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'status': 'error', 'message': 'No selected file'}), 400

    if not (file and allowed_file(file.filename)):
        return jsonify({'status': 'error', 'message': 'Invalid file type. Only CSV files are allowed.'}), 400

    filename = secure_filename(file.filename)
    target_path = os.path.join(UPLOAD_TEMP_FOLDER, CURRENT_UPLOAD_FILENAME)

    try:
        file.save(target_path)
        if set_current_csv_file(target_path):
            return jsonify({'status': 'success', 'message': f'File {filename} uploaded successfully', 'filename': filename})

        try:
            os.remove(target_path)
        except OSError:
            pass
        return jsonify({'status': 'error', 'message': 'Failed to process uploaded file'}), 500
    except Exception as exc:
        return jsonify({'status': 'error', 'message': f'Error saving file: {str(exc)}'}), 500


@app.route('/api/clear_csv', methods=['POST'])
def clear_csv():
    clear_current_csv_file()
    return jsonify({'status': 'success', 'message': 'Current CSV file cleared'})


@app.route('/api/current_csv')
def current_csv():
    current_file = get_current_csv_file()
    if current_file:
        return jsonify({'filename': os.path.basename(current_file), 'is_uploaded': os.path.dirname(current_file) == UPLOAD_TEMP_FOLDER})
    return jsonify({'filename': None, 'is_uploaded': False})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)