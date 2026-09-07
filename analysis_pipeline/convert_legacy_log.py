"""Convert legacy mixed Pico logs to the current per-stroke-summary format.

Legacy mixed logs (27-column header, no stroke_duration_ms) wrote each
stroke's catch_duration_ms/exit_duration_ms/shape_0..shape_4 directly onto
the A row where stroke_flag flips to 1. The current format (28-column
header) instead reports those fields -- plus a new stroke_duration_ms field
-- on a dedicated S row emitted once the stroke completes, leaving A rows
with only the raw accelerometer/gyro stream and stroke_flag.

This script rewrites a legacy CSV into the new layout:
  - Every A/G row is carried over unchanged (A rows have their
    catch_duration_ms/exit_duration_ms/shape_* fields cleared; the new
    stroke_duration_ms column is added, blank, to every row).
  - For each A row with stroke_flag == 1 that carries catch/exit/shape
    values, an S row is emitted immediately after it with those values
    plus a derived stroke_duration_ms and spm, computed from the elapsed
    uptime_ms since the previous catch. If that gap exceeds
    --min-spm's implied max stroke interval (e.g. no previous catch, or a
    pause in rowing), no duration can be derived and the S row is skipped
    for that catch -- mirroring how the live firmware only emits S rows for
    strokes it can time end-to-end.

Usage (from the repo root):
    python -m analysis_pipeline.convert_legacy_log --input rowing_log001.csv --output rowing_log001_new.csv
    python -m analysis_pipeline.convert_legacy_log --input-dir test_data --output-dir test_data_converted
"""

import argparse
import csv
import glob
import os

LEGACY_HEADER_COLUMNS = [
    'record_type', 'date', 'time', 'uptime_ms', 'accel_x', 'accel_y', 'accel_z',
    'gyro_x', 'gyro_y', 'gyro_z', 'speed_mps', 'spm', 'gps_lat', 'gps_lon',
    'distance_m', 'stroke_flag', 'sats', 'hdop', 'fix_quality', 'course_deg',
    'catch_duration_ms', 'exit_duration_ms', 'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4'
]

NEW_HEADER_COLUMNS = LEGACY_HEADER_COLUMNS + ['stroke_duration_ms']

STROKE_FIELDS = ['catch_duration_ms', 'exit_duration_ms', 'shape_0', 'shape_1', 'shape_2', 'shape_3', 'shape_4']

DEFAULT_MIN_SPM = 14


def _to_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _blank_row(record_type):
    return {col: '' for col in NEW_HEADER_COLUMNS} | {'record_type': record_type}


def convert_rows(rows, min_spm=DEFAULT_MIN_SPM):
    """Convert legacy rows (as dicts keyed by LEGACY_HEADER_COLUMNS) into new-format rows."""
    max_stroke_interval_ms = 60000.0 / min_spm

    out_rows = []
    strokes_converted = 0
    previous_catch_uptime_ms = None

    for row in rows:
        record_type = (row.get('record_type') or '').strip().upper()
        out_row = _blank_row(record_type)
        for col in LEGACY_HEADER_COLUMNS:
            out_row[col] = row.get(col, '')
        for col in STROKE_FIELDS:
            out_row[col] = ''
        out_rows.append(out_row)

        if record_type != 'A':
            continue

        uptime_ms = _to_float(row.get('uptime_ms'))
        stroke_flag = (row.get('stroke_flag') or '').strip()
        catch_duration = row.get('catch_duration_ms', '')

        if uptime_ms is None or stroke_flag != '1' or catch_duration in (None, ''):
            continue

        if previous_catch_uptime_ms is not None:
            stroke_duration_ms = uptime_ms - previous_catch_uptime_ms
            if 0 < stroke_duration_ms <= max_stroke_interval_ms:
                stroke_row = _blank_row('S')
                stroke_row['uptime_ms'] = row.get('uptime_ms', '')
                stroke_row['spm'] = '%.2f' % (60000.0 / stroke_duration_ms)
                for col in STROKE_FIELDS:
                    stroke_row[col] = row.get(col, '')
                stroke_row['stroke_duration_ms'] = '%d' % round(stroke_duration_ms)
                out_rows.append(stroke_row)
                strokes_converted += 1

        previous_catch_uptime_ms = uptime_ms

    return out_rows, strokes_converted


def convert_file(input_path, output_path, min_spm=DEFAULT_MIN_SPM):
    with open(input_path, 'r', newline='') as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != LEGACY_HEADER_COLUMNS:
            raise ValueError(
                f'{input_path}: unsupported header. Expected the legacy 27-column mixed Pico log header.'
            )
        rows = list(reader)

    out_rows, strokes_converted = convert_rows(rows, min_spm=min_spm)

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=NEW_HEADER_COLUMNS)
        writer.writeheader()
        writer.writerows(out_rows)

    return len(rows), strokes_converted


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', help='Single legacy CSV file (overrides --input-dir)')
    parser.add_argument('--output', help='Output path for --input (required if --input is set)')
    parser.add_argument('--input-dir', default='test_data', help='Directory of legacy CSV logs (default: test_data)')
    parser.add_argument('--output-dir', default='test_data_converted', help='Directory for converted logs (default: test_data_converted)')
    parser.add_argument('--pattern', default='*.csv', help='Glob pattern within --input-dir (default: *.csv)')
    parser.add_argument(
        '--min-spm', type=int, default=DEFAULT_MIN_SPM,
        help='Lowest plausible stroke rate; caps how large a catch-to-catch gap may be before it is '
             f'treated as a break in rowing rather than one stroke (default: {DEFAULT_MIN_SPM})'
    )
    args = parser.parse_args()

    if args.input:
        if not args.output:
            parser.error('--output is required when --input is set')
        rows, strokes = convert_file(args.input, args.output, args.min_spm)
        print(f"{args.input} -> {args.output}: {rows} rows, {strokes} stroke summaries generated")
        return

    input_paths = sorted(glob.glob(os.path.join(args.input_dir, args.pattern)))
    if not input_paths:
        print(f"No files matching {args.pattern} in {args.input_dir}")
        return

    for input_path in input_paths:
        output_path = os.path.join(args.output_dir, os.path.basename(input_path))
        rows, strokes = convert_file(input_path, output_path, args.min_spm)
        print(f"{input_path} -> {output_path}: {rows} rows, {strokes} stroke summaries generated")


if __name__ == '__main__':
    main()
