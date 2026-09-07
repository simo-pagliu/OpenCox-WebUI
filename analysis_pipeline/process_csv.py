"""Process mixed Pico rowing logs and generate filtered output files."""

import csv
import argparse
import json
import os
from analysis_pipeline.gps_analysis import (
    analyze_gps,
    format_pace,
    format_time,
    DEFAULT_PAUSE_THRESHOLD,
    haversine,
)


MAX_GPS_POINT_SPEED_MPS = 15.0


def _empty_analysis_payload():
    """Return a non-stale analysis payload for files with insufficient GPS points."""
    return {
        'lats': [],
        'lons': [],
        'times_ms': [],
        'original_indices': [],
        'speeds': [],
        'paces': [],
        'distances': [],
        'moving_distances': [],
        'is_pause': [],
        'total_distance': 0.0,
        'moving_distance': 0.0,
        'total_time': 0.0,
        'moving_time': 0.0,
        'avg_speed': 0.0,
        'avg_pace': 0.0,
        'pause_percentage': 0.0,
        'pause_count': 0,
        'insufficient_gps_points': True
    }


MIXED_HEADER_COLUMNS = [
    'record_type', 'date', 'time', 'uptime_ms', 'accel_x', 'accel_y', 'accel_z',
    'gyro_x', 'gyro_y', 'gyro_z', 'speed_mps', 'spm', 'gps_lat', 'gps_lon',
    'distance_m', 'stroke_flag', 'sats', 'hdop', 'fix_quality', 'course_deg',
    'catch_duration_ms', 'exit_duration_ms', 'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4',
    'stroke_duration_ms'
]


def _parse_optional_float(value):
    if value in (None, ''):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _validate_mixed_header(fieldnames):
    if list(fieldnames or []) != MIXED_HEADER_COLUMNS:
        raise ValueError('Unsupported CSV format. Expected the mixed Pico log header.')




def load_csv(csv_path):
    """Load the mixed log and split it into accel, GPS, and stroke rows."""
    return load_mixed_log_csv(csv_path)


def load_mixed_log_csv(csv_path):
    """
    Load the mixed Pico log format.

    Expected header: see MIXED_HEADER_COLUMNS above.

    Returns:
        (all_rows, gps_rows, stroke_rows)
        - all_rows: A-records (accelerometer stream)
        - gps_rows: G-records with valid GPS coordinates
        - stroke_rows: S-records (per-stroke catch/exit/shape/duration summary)
    """
    all_rows = []
    gps_rows = []
    stroke_rows = []

    with open(csv_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != MIXED_HEADER_COLUMNS:
            raise ValueError('Unsupported CSV format. Expected the mixed Pico log header.')

        for row in reader:
            row_type = (row.get('record_type') or '').strip().upper()
            if row_type == 'A':
                all_rows.append(row)
            elif row_type == 'G':
                try:
                    lat = float(row.get('gps_lat', ''))
                    lon = float(row.get('gps_lon', ''))
                except (ValueError, TypeError):
                    continue
                if lat == 0 or lon == 0:
                    continue
                gps_rows.append({
                    'lat': lat,
                    'lon': lon,
                    'time': float(row.get('time', 0.0)) * 1000.0,
                    'speed_mps': float(row.get('speed_mps', 0.0) or 0.0),
                    'spm': float(row.get('spm', 0.0) or 0.0),
                    'uptime_ms': int(float(row.get('uptime_ms', 0) or 0)),
                    'sats': row.get('sats', ''),
                    'hdop': row.get('hdop', ''),
                    'fix_quality': row.get('fix_quality', ''),
                    'course_deg': row.get('course_deg', ''),
                })
            elif row_type == 'S':
                uptime_val = _parse_optional_float(row.get('uptime_ms'))
                if uptime_val is None:
                    continue
                stroke_rows.append({
                    'uptime_ms': uptime_val,
                    'spm': row.get('spm', ''),
                    'catch_duration_ms': row.get('catch_duration_ms', ''),
                    'exit_duration_ms': row.get('exit_duration_ms', ''),
                    'shape_0': row.get('shape_0', ''),
                    'shape_1': row.get('shape_1', ''),
                    'shape_2': row.get('shape_2', ''),
                    'shape_3': row.get('shape_3', ''),
                    'shape_4': row.get('shape_4', ''),
                    'stroke_duration_ms': row.get('stroke_duration_ms', ''),
                })
            else:
                raise ValueError(f'Unsupported record_type: {row_type}')

    gps_rows.sort(key=lambda row: (float(row.get('time', 0.0) or 0.0), int(float(row.get('uptime_ms', 0) or 0))))

    filtered_gps_rows = []
    for row in gps_rows:
        try:
            lat = float(row.get('lat', ''))
            lon = float(row.get('lon', ''))
            time_value = float(row.get('time', 0.0) or 0.0)
        except (ValueError, TypeError):
            continue

        if lat == 0 or lon == 0 or time_value <= 0:
            continue

        if filtered_gps_rows:
            previous_row = filtered_gps_rows[-1]
            previous_time = float(previous_row.get('time', 0.0) or 0.0)
            delta_ms = time_value - previous_time
            if delta_ms <= 0:
                continue

            distance_m = haversine(
                float(previous_row.get('lat', 0.0) or 0.0),
                float(previous_row.get('lon', 0.0) or 0.0),
                lat,
                lon,
            )
            implied_speed = distance_m / (delta_ms / 1000.0)
            if implied_speed > MAX_GPS_POINT_SPEED_MPS:
                continue

        filtered_gps_rows.append(row)

    stroke_rows.sort(key=lambda row: row['uptime_ms'])

    return all_rows, filtered_gps_rows, stroke_rows


def load_unified_log_csv(csv_path):
    """
    Load unified single-file format (no record_type).

    Format:
      date,time,uptime_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,
      speed_mps,spm,gps_lat,gps_lon,distance_m,paused

    Returns:
        (all_rows, gps_rows)
        - all_rows: all rows (accelerometer + metadata)
        - gps_rows: rows with valid GPS coordinates
    """
    all_rows = []
    gps_rows = []

    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            all_rows.append(row)
            try:
                lat = float(row.get('gps_lat', ''))
                lon = float(row.get('gps_lon', ''))
            except (ValueError, TypeError):
                continue

            if lat == 0 or lon == 0:
                continue

            gps_rows.append({
                'lat': row.get('gps_lat', ''),
                'lon': row.get('gps_lon', ''),
                'time': row.get('time', ''),
                'speed_mps': row.get('speed_mps', ''),
                'spm': row.get('spm', ''),
                'uptime_ms': row.get('uptime_ms', ''),
            })

    return all_rows, gps_rows


def parse_exclude_ranges(exclude_str):
    """
    Parse exclude string like "0-1000,5000-10000" into list of (start, end) tuples.
    
    Args:
        exclude_str: String of comma-separated ranges
        
    Returns:
        List of (start, end) tuples
    """
    if not exclude_str:
        return []
    
    ranges = []
    for range_str in exclude_str.split(','):
        if '-' in range_str:
            start, end = range_str.split('-')
            ranges.append((int(start), int(end)))
        else:
            # Single index
            ranges.append((int(range_str), int(range_str)))
    
    return ranges


def is_excluded(index, exclude_ranges):
    """Check if index is in any excluded range."""
    for start, end in exclude_ranges:
        if start <= index <= end:
            return True
    return False


def generate_output_files(gps_rows, all_rows, stroke_rows, exclude_ranges, output_dir='output', format_type='log_session'):
    """
    Generate output CSV files.

    Args:
        gps_rows: Rows with GPS data (unique coordinates at ~1000ms intervals)
        all_rows: All rows with accelerometer data
        stroke_rows: Per-stroke catch/exit/shape/duration summary rows (S records)
        exclude_ranges: List of (start, end) tuples to exclude
        output_dir: Directory for output files
        format_type: retained only for call-site compatibility; mixed logs only are supported

    Returns:
        Tuple of (gps_output_path, accel_output_path, stroke_output_path)
    """
    if os.path.exists(output_dir) and not os.path.isdir(output_dir):
        os.remove(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    
    # GPS output: 1000ms interval (only GPS data, no accelerometer)
    gps_output_path = os.path.join(output_dir, 'gps_data.csv')
    
    with open(gps_output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['time', 'lat', 'lon', 'speed_mps', 'spm', 'uptime_ms', 'sats', 'hdop', 'fix_quality', 'course_deg'])
        for i, row in enumerate(gps_rows):
            if not is_excluded(i, exclude_ranges):
                writer.writerow([
                    row.get('time', ''),
                    row.get('lat', ''),
                    row.get('lon', ''),
                    row.get('speed_mps', ''),
                    row.get('spm', ''),
                    row.get('uptime_ms', ''),
                    row.get('sats', ''),
                    row.get('hdop', ''),
                    row.get('fix_quality', ''),
                    row.get('course_deg', ''),
                ])
    
    # Accel output: 10ms interval (only accelerometer data, no GPS)
    accel_output_path = os.path.join(output_dir, 'accel_data.csv')
    
    with open(accel_output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        
        writer.writerow([
            'uptime_ms', 'accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'stroke_flag'
        ])
        for i, row in enumerate(all_rows):
            if not is_excluded(i, exclude_ranges):
                writer.writerow([
                    row.get('uptime_ms', ''),
                    row.get('accel_x', ''),
                    row.get('accel_y', ''),
                    row.get('accel_z', ''),
                    row.get('gyro_x', ''),
                    row.get('gyro_y', ''),
                    row.get('gyro_z', ''),
                    row.get('stroke_flag', ''),
                ])

    # Stroke output: one row per completed stroke (catch/exit/shape/duration summary)
    stroke_output_path = os.path.join(output_dir, 'stroke_data.csv')

    with open(stroke_output_path, 'w', newline='') as f:
        writer = csv.writer(f)

        writer.writerow([
            'uptime_ms', 'spm', 'catch_duration_ms', 'exit_duration_ms',
            'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4', 'stroke_duration_ms'
        ])
        for i, row in enumerate(stroke_rows):
            if not is_excluded(i, exclude_ranges):
                writer.writerow([
                    row.get('uptime_ms', ''),
                    row.get('spm', ''),
                    row.get('catch_duration_ms', ''),
                    row.get('exit_duration_ms', ''),
                    row.get('shape_0', ''),
                    row.get('shape_1', ''),
                    row.get('shape_2', ''),
                    row.get('shape_3', ''),
                    row.get('shape_4', ''),
                    row.get('stroke_duration_ms', ''),
                ])

    return gps_output_path, accel_output_path, stroke_output_path


def analyze_and_print_stats(gps_rows, exclude_ranges, pause_threshold=DEFAULT_PAUSE_THRESHOLD):
    """
    Run GPS analysis and print statistics.
    
    Args:
        gps_rows: Rows with GPS data
        exclude_ranges: List of (start, end) tuples to exclude
        pause_threshold: Speed threshold in m/s below which points are considered pauses.
                         Set to None to disable pause detection. Default: 1.5 m/s
    
    Returns:
        Dictionary with analysis results including speeds, paces, lats, lons, times
    """
    # Extract data for analysis
    lats = []
    lons = []
    times_ms = []
    original_indices = []
    
    for i, row in enumerate(gps_rows):
        if not is_excluded(i, exclude_ranges):
            try:
                lats.append(float(row['lat']))
                lons.append(float(row['lon']))
                times_ms.append(float(row.get('time', 0)))
                original_indices.append(i)
            except (ValueError, KeyError, IndexError) as e:
                print(f"Error processing row {i}: {e}")
                pass
    
    if len(lats) < 2:
        print("Not enough GPS data for analysis.")
        return None
    
    # Run analysis with pause detection
    result = analyze_gps(lats, lons, times_ms, pause_threshold=pause_threshold)
    
    # Print statistics
    print("\n" + "=" * 60)
    print("GPS ANALYSIS STATISTICS")
    print("=" * 60)
    print(f"Total GPS points (after exclusion): {len(lats)}")
    print(f"Total distance: {result['total_distance']:.2f} m")
    print(f"Moving distance (excluding pauses): {result['moving_distance']:.2f} m")
    print(f"Total time: {format_time(result['total_time'])}")
    print(f"Moving time (excluding pauses): {format_time(result['moving_time'])}")
    print(f"Average speed (moving only): {result['avg_speed']:.4f} m/s")
    print(f"Average pace (moving only): {format_pace(result['avg_pace'])} /500m")
    
    # Pause statistics
    print(f"\nPause Statistics:")
    print(f"  Pause percentage: {result['pause_percentage']:.1f}%")
    print(f"  Number of pause segments: {result['pause_count']}")
    
    if result['speeds']:
        print(f"\nSpeed Statistics:")
        print(f"  Min speed: {min(result['speeds']):.4f} m/s")
        print(f"  Max speed: {max(result['speeds']):.4f} m/s")
    
    if result['paces']:
        valid_paces = [p for p in result['paces'] if p > 0]
        if valid_paces:
            print(f"\nPace Statistics:")
            print(f"  Min pace: {format_pace(min(valid_paces))} /500m")
            print(f"  Max pace: {format_pace(max(valid_paces))} /500m")
    
    print("=" * 60)
    
    # Return analysis data for web app
    return {
        'lats': lats,
        'lons': lons,
        'times_ms': times_ms,
        'original_indices': original_indices,
        'speeds': result['speeds'],
        'paces': result['paces'],
        'distances': result['distances'],
        'moving_distances': result['moving_distances'],
        'is_pause': result['is_pause'],
        'total_distance': result['total_distance'],
        'moving_distance': result['moving_distance'],
        'total_time': result['total_time'],
        'moving_time': result['moving_time'],
        'avg_speed': result['avg_speed'],
        'avg_pace': result['avg_pace'],
        'pause_percentage': result['pause_percentage'],
        'pause_count': result['pause_count']
    }


def main():
    parser = argparse.ArgumentParser(
        description='Process mixed rowing CSV data and generate filtered output files.'
    )
    parser.add_argument(
        '--csv',
        required=True,
        help='Input mixed CSV file path'
    )
    parser.add_argument(
        '--exclude', 
        default='',
        help='Comma-separated list of index ranges to exclude (e.g., "0-1000,5000-10000")'
    )
    parser.add_argument(
        '--output-dir',
        default='output',
        help='Output directory for CSV files (default: output)'
    )
    parser.add_argument(
        '--pause-threshold',
        type=float,
        default=DEFAULT_PAUSE_THRESHOLD,
        help=f'Speed threshold in m/s below which points are considered pauses. '
             f'Set to 0 or negative to disable. Default: {DEFAULT_PAUSE_THRESHOLD} m/s'
    )
    
    args = parser.parse_args()
    
    # Handle pause threshold - convert 0 or negative to None (disabled)
    pause_threshold = args.pause_threshold if args.pause_threshold > 0 else None
    
    # Load CSV
    print(f"Loading CSV file: {args.csv}")
    all_rows, gps_rows, stroke_rows = load_csv(args.csv)
    print(f"Loaded {len(all_rows)} total rows")
    print(f"Found {len(gps_rows)} rows with GPS data")
    print(f"Found {len(stroke_rows)} stroke summary rows")
    
    # Parse exclude ranges
    exclude_ranges = parse_exclude_ranges(args.exclude)
    print(f"\nExcluding regions: {exclude_ranges}")
    
    # Count remaining points
    remaining = len(gps_rows) - sum(end - start + 1 for start, end in exclude_ranges)
    print(f"Remaining GPS points: {remaining}")
    
    # Pause detection info
    if pause_threshold is not None:
        print(f"\nPause detection enabled: speed < {pause_threshold} m/s will be excluded from statistics")
    else:
        print("\nPause detection disabled")
    
    # Generate output files
    print(f"\nGenerating output files in '{args.output_dir}'...")
    gps_path, accel_path, stroke_path = generate_output_files(
        gps_rows, all_rows, stroke_rows, exclude_ranges, args.output_dir
    )
    print(f"GPS data saved to: {gps_path}")
    print(f"Accel data saved to: {accel_path}")
    print(f"Stroke data saved to: {stroke_path}")
    
    # Analyze and print statistics
    analysis_result = analyze_and_print_stats(gps_rows, exclude_ranges, pause_threshold)

    # Always overwrite analysis JSON to prevent stale fallback from previous runs.
    analysis_json_path = os.path.join(args.output_dir, 'analysis_results.json')
    if not analysis_result:
        analysis_result = _empty_analysis_payload()
        print("Insufficient GPS points for full analysis; writing empty analysis payload.")
    with open(analysis_json_path, 'w') as f:
        json.dump(analysis_result, f, indent=2)
    print(f"Analysis results saved to: {analysis_json_path}")
    
    print(f"\nDone! Output files generated successfully.")


if __name__ == '__main__':
    main()
