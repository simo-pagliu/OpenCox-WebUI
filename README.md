# OpenCox UI

Web app and analysis pipeline for OpenCox rowing telemetry. Reads the CSV logs
recorded on the boat and turns them into distance, speed, pace and stroke-rate
analysis.

Part of [OpenCox](https://github.com/simo-pagliu/OpenCox):

| Repo | Contents |
|------|----------|
| **OpenCoxUI** (this one) | Web app and analysis pipeline |
| [OpenCox-RP2350](https://github.com/simo-pagliu/OpenCox-RP2350) | Pico 2 W firmware that records the logs |

A simple system for analyzing rowing GPS data with a clean separation between:
1. **Analysis Pipeline** - Simple Python scripts for data processing (maintained by rowing experts)
2. **Web Application** - Flask app for visualizing and excluding regions (maintained by software engineers)

## Architecture

```
.
├── analysis_pipeline/      # Pure Python - NO web dependencies
│   ├── __init__.py
│   ├── gps_analysis.py    # Core analysis: distance, speed, pace calculations
│   └── process_csv.py      # CLI tool: load CSV, exclude regions, generate output files
│
├── web_app/               # Flask web application
│   ├── app.py             # Web server with API endpoints
│   └── templates/
│       └── index.html     # Simple UI for excluding regions
│
├── Dockerfile.web        # Web container
├── Dockerfile.analysis    # Analysis container (optional)
├── docker-compose.yml     # Two-container setup
├── run_web.py            # Run web app directly
├── log_session_1.csv     # Input data
└── output/               # Generated CSV files
```

## Quick Start

### Option 1: Run directly (no Docker)

```bash
# Run the web app
python run_web.py

# Open http://localhost:5000 in your browser
```

### Option 2: Use Docker

```bash
# Build and run with docker-compose
docker-compose up --build

# Open http://localhost:5000 in your browser
```

## Usage

1. **Open the web app** at `http://localhost:5000`
2. **View the GPS track** on the map
3. **Select regions to exclude** by:
   - Clicking on the map to set start and end points
   - Or entering indices manually
4. **Click "Generate CSV Files"** to create:
   - `output/gps_data.csv` - GPS data at 1000ms intervals (lat, lon, time)
   - `output/accel_data.csv` - Accelerometer data at 10ms intervals (x, y, z, time)
5. **Download the files** using the provided links

## Analysis Pipeline (for rowing experts)

The analysis pipeline is designed to be simple and maintainable by non-software engineers.

### Core Function: `analyze_gps()`

```python
from analysis_pipeline.gps_analysis import analyze_gps

# Input: simple arrays
lats = [45.959030, 45.959035, 45.959040, ...]
lons = [8.870124, 8.870129, 8.870134, ...]
times_ms = [0, 1000, 2000, ...]  # milliseconds

# Run analysis
result = analyze_gps(lats, lons, times_ms)

# Output
print(f"Total distance: {result['total_distance']} m")
print(f"Total time: {result['total_time']} s")
print(f"Average speed: {result['avg_speed']} m/s")
print(f"Average pace: {result['avg_pace']} s/500m")

# Access arrays
speeds = result['speeds']    # List of speeds in m/s
paces = result['paces']      # List of paces in seconds per 500m
distances = result['distances']  # Cumulative distances in meters
```

### Command Line Tool

```bash
# Process CSV with exclusions
python -m analysis_pipeline.process_csv --exclude "0-1000,5000-10000"

# Output files will be saved to output/ directory
# Statistics will be printed to console
```

## Web Application (for software engineers)

The web app provides a simple UI for:
- Visualizing the GPS track
- Selecting regions to exclude
- Generating output CSV files

### API Endpoints

- `GET /` - Main page
- `GET /api/gps_points` - Get all GPS points as JSON
- `POST /api/process` - Process with exclusions and generate files
  - Request: `{"exclude_ranges": [[0, 1000], [5000, 10000]]}`
  - Response: `{"status": "success", "gps_file": "...", "accel_file": "..."}`
- `GET /output/<filename>` - Download output files

## Docker Setup

### Single Container (Simpler)

Just use `Dockerfile.web` - it includes both the web app and analysis pipeline.

### Two Container (More Modular)

Use `docker-compose.yml` which provides:
- `web` container: Flask application
- `analysis` container: Analysis pipeline (optional)

The web container calls the analysis pipeline via subprocess, so the two-container setup is optional.

## CSV File Format

Input CSV (`log_session_1.csv`) should contain:
- `uptime_ms` - Time in milliseconds
- `accel_x, accel_y, accel_z` - Accelerometer readings
- `gps_lat, gps_lon` - GPS coordinates

Output CSVs:
- `gps_data.csv` - Columns: `uptime_ms, gps_lat, gps_lon`
- `accel_data.csv` - Columns: `uptime_ms, accel_x, accel_y, accel_z`

## Separation of Concerns

| Component | Responsibility | Maintainers | Dependencies |
|-----------|---------------|-------------|--------------|
| `analysis_pipeline/` | Data loading, GPS analysis, CSV processing | Rowing experts | Python stdlib only |
| `web_app/` | Web UI, API endpoints | Software engineers | Flask |

This separation allows:
- Rowing experts to modify analysis logic without touching web code
- Software engineers to improve the UI without affecting data processing
- Easy testing of each component independently
- Clear ownership and responsibility

## Standalone Deployment (tools.pagliuca.net)

The root-level `index.html` is a separate, self-contained build of the web
app: the same GPS/pace/SPM analysis, ported to run entirely client-side (no
upload, no backend), with Leaflet and Chart.js inlined. It's the artifact
served by the `tools.pagliuca.net` multi-tool deployment at
`tools.pagliuca.net/open-cox/`. It's independent of `web_app/` (the Flask
app above) — that one still requires a Python server; this one doesn't.

Build and run it standalone:

```bash
docker build -t open-cox .
docker run --rm -p 8080:80 open-cox
```

Then open `http://localhost:8080`.

Compose service block for the `tools.pagliuca.net` deployment repo:

```yaml
open-cox:
  build: ./open-cox
  container_name: tools-pagliuca-net-open-cox
  restart: unless-stopped
  networks:
    - proxy
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.open-cox.rule=Host(`tools.pagliuca.net`) && PathPrefix(`/open-cox`)"
    - "traefik.http.routers.open-cox.entrypoints=websecure"
    - "traefik.http.routers.open-cox.tls.certresolver=cloudflare"
    - "traefik.http.routers.open-cox.priority=10"
    - "traefik.http.services.open-cox.loadbalancer.server.port=80"
```

## License

MIT
