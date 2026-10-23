# OpenCox UI

A web page for analysing OpenCox rowing logs. Open a session's CSV file and
it shows the track on a map, pace and stroke rate along the session, and
statistics for the whole session or any stretch of it.

Part of [OpenCox](https://github.com/simo-pagliu/OpenCox):

| Repo | Contents |
|------|----------|
| **OpenCoxUI** (this one) | Web page that analyses the logs |
| [OpenCox-RP2350](https://github.com/simo-pagliu/OpenCox-RP2350) | Firmware for the logger that records them |

## Features

- **Pace & stroke rate profile** along the session, with distance and time
  axes. Pace is shown per stroke.
- **Map** of the track, plain or coloured by pace or stroke rate, on a fixed
  scale (comparable across sessions) or one fitted to what's on screen.
- **Selection**: drag across the profile, or type a distance or time range,
  to analyse one stretch, such as a single piece; double-click to clear.
  The map, statistics and a zoomed pace chart follow the selection.
- **Statistics**: distance, time, average pace and stroke rate, and the
  average, median, minimum, maximum and 1st/99th percentiles of pace, stroke
  rate and speed, with pace and stroke rate distributions.

Everything runs in the browser: the log never leaves your computer, and
there is no server-side code. The libraries are bundled in `vendor/`; only
the map tiles (Esri World Dark Gray) are loaded from the internet.

## Running it

Open `index.html` in a browser and pick a log file. No build step or
installation is needed, and the page also works opened straight from disk.

## Deployment

The page is static files: `index.html`, `config.js`, `css/`, `js/` and
`vendor/`. Copy them to any web server or static hosting. All paths are
relative, so it can be served from a sub-folder.

A Docker image with nginx is included:

```bash
docker build -t opencox-ui .
docker run --rm -p 8080:80 opencox-ui
```

Then open <http://localhost:8080>. Behind a reverse proxy, point it at the
container's port 80.

## Configuration

A deployment can add a round home button at the top left, linking back to
the site that hosts the page, and a message in the footer. The footer also
links to this repository. The settings are in `config.js`:

| `config.js` | Environment variable | Default | Effect |
|-------------|----------------------|---------|--------|
| `homeUrl` | `OPENCOX_HOME_URL` | empty | Shows the home button, linking to this URL |
| `footerText` | `OPENCOX_FOOTER_TEXT` | empty | Message at the start of the footer |
| `footerUrl` | `OPENCOX_FOOTER_URL` | empty | Makes the footer message a link |
| `repoUrl` | `OPENCOX_REPO_URL` | this repository | "Source code" link in the footer; empty hides it |

With the static files, edit `config.js`. With the Docker image, set the
environment variables instead: the container rewrites `config.js` from them
at start-up. A variable that is not set keeps the default; one set to an
empty value clears the setting.

```bash
docker run --rm -p 8080:80 \
  -e OPENCOX_HOME_URL=https://example.org/ \
  -e OPENCOX_FOOTER_TEXT="Hosted by Example Rowing Club" \
  -e OPENCOX_FOOTER_URL=https://example.org/ \
  opencox-ui
```

Or in a Compose file:

```yaml
services:
  opencox-ui:
    build: .
    ports:
      - "8080:80"
    environment:
      OPENCOX_HOME_URL: "https://example.org/"
      OPENCOX_FOOTER_TEXT: "Hosted by Example Rowing Club"
      OPENCOX_FOOTER_URL: "https://example.org/"
```

## How the numbers are computed

- **Pace** is computed per stroke: the mean GPS speed over the fixes from one
  catch to the next, using the catches the logger marks in the log
  (`stroke_flag`). The boat's speed surges within every stroke, so a whole
  stroke is the natural unit to average over. Gaps between catches outside
  1.2–4.3 s (a pause, or a missed catch) are not counted as strokes and leave
  a gap in the charts.
- **Distance** is measured between GPS points at least about 1 s apart:
  summing every 0.2 s step would add the position noise of each fix.
- **Average pace and speed** are moving distance over moving time; stretches
  slower than 1.5 m/s count as pauses. Distance and time in the summary cover
  the whole selection, pauses included.
- **Stroke rate** is the SPM recorded by the logger.

The log format is described in the
[firmware README](https://github.com/simo-pagliu/OpenCox-RP2350#log-format).

## Project structure

```
.
├── index.html              # Markup
├── config.js               # Deployment settings (see Configuration)
├── css/app.css             # Styles
├── js/                     # Scripts, loaded by index.html in this order:
│   ├── util.js             #   helpers: debounce, formatting, median
│   ├── state.js            #   shared state, chart theme
│   ├── log.js              #   CSV parsing, strokes, statistics for a stretch
│   ├── charts.js           #   pace & stroke rate profile, selection chart
│   ├── stats.js            #   statistics panel, distributions
│   ├── map.js              #   map, colour layers, legend
│   ├── selection.js        #   selecting a stretch
│   └── app.js              #   opening a file, startup
├── vendor/                 # Leaflet 1.9.4, Chart.js 4.4.0
├── Dockerfile, nginx.conf  # Container image
└── docker/                 # Container start-up script that writes config.js
```

The scripts are plain scripts that share their globals, not ES modules, so
the page works without a build step and from `file://`. Their order in
`index.html` matters: at load time each script uses only what the scripts
before it define.

## License

OpenCox UI is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, study,
change and share it for any noncommercial purpose (personal use, hobby
projects, research, teaching, clubs and other noncommercial organisations),
as long as the license and its `Required Notice` line come with any copy you
pass on. Commercial use is not covered by this license: to use OpenCox
commercially, ask the author for permission.

The libraries in `vendor/` keep their own licenses:
[Leaflet](vendor/leaflet-1.9.4/LICENSE) (BSD 2-Clause) and
[Chart.js](vendor/chart.js-4.4.0/LICENSE.md) (MIT).
