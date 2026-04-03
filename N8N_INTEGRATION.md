# n8n Integration Guide for pix-diff (Baseline + History)

This project now supports a baseline-and-history flow designed for Figma automation:

- Keep one latest baseline image per case
- Compare incoming newest Figma image with baseline
- Save comparison history report
- Update baseline to newest image

## 1) Folder structure

Runtime data is stored under `data/`:

- `data/baselines/` - latest baseline image for each case (`<caseName>.png`)
- `data/report-history/` - JSON and diff image history, grouped by date

Example:

```text
data/
  baselines/
    home_header.png
    pricing_card.png
  report-history/
    2026-04-03/
      2026-04-03T09-30-15-111Z__home_header.json
      2026-04-03T09-30-15-111Z__home_header.diff.png
```

## 2) API endpoints for n8n

Main endpoints:

- `GET /health`
- `POST /api/figma/sync/:caseName`
- `GET /api/reports`

Severity rule:

- `major`: `percentage >= 5`
- `minor`: `0.1 <= percentage < 5`
- `none`: `percentage < 0.1`

Additional rule:

- if size pre-check detects width/height change, server returns `severity = major`

## 3) Start service

```bash
npm install
npm start
```

Default URL:

- `http://localhost:3000`

If n8n runs in Docker and API runs on host:

- `http://host.docker.internal:3000`

## 4) Main n8n workflow (recommended)

Node sequence:

1. `Schedule Trigger` (or `Webhook`)
2. `HTTP Request` (optional: get latest version from Figma)
3. `HTTP Request` (get image URL from Figma Images API) or `Set` direct `figmaImageUrl`
4. `Set` (`caseName`, Figma fields)
4. `HTTP Request` (`POST /api/figma/sync/:caseName`)
5. `IF` (`severity === 'major'`)
6. `Slack` / `Email` / `Teams`

### Node 4 request details

Method:

- `POST`

URL:

```text
http://localhost:3000/api/figma/sync/{{ $json.caseName }}
```

Body Content Type:

- `JSON`

Body example:

```json
{
  "figmaImageUrl": "{{ $json.figmaImageUrl }}",
  "figmaWidth": "{{ $json.width }}",
  "figmaHeight": "{{ $json.height }}"
}
```

Accepted input modes:

- Direct rendered image URL:
  - `figmaImageUrl` (or `imageUrl`)
- Figma API mode:
  - `figmaFileKey`
  - `figmaNodeId`
  - `figmaToken` (optional if `FIGMA_TOKEN` is set on server)

Optional size metadata for pre-check:

- `figmaWidth`
- `figmaHeight`

Pipeline executed by server:

1. Size Pre-check
2. Fetch Newest Image from Figma
3. Run Pixel Diff with image from baselines

### Behavior of `/api/figma/sync/:caseName`

- If baseline does not exist: create baseline, write history entry, return `status=baseline_created`
- If baseline exists: compare, write history JSON + diff image, overwrite baseline with newest image

Response sample (baseline created):

```json
{
  "caseName": "home_header",
  "status": "baseline_created",
  "percentage": 0,
  "severity": "none",
  "baselineUpdated": true,
  "source": {
    "mode": "direct-image-url",
    "url": "https://example.com/newest.png"
  },
  "sizePrecheck": {
    "baselineExists": false,
    "sizeChanged": false,
    "reason": "baseline_not_found"
  },
  "reportFiles": {
    "jsonPath": "/.../data/report-history/2026-04-03/2026-04-03T09-30-15-111Z__home_header.json",
    "diffPath": null
  }
}
```

Response sample (normal compare):

```json
{
  "caseName": "home_header",
  "status": "ok",
  "percentage": 2.1842,
  "severity": "minor",
  "baselineUpdated": true,
  "source": {
    "mode": "figma-api",
    "fileKey": "abc123",
    "nodeId": "12:34",
    "renderedUrl": "https://s3-alpha.figma.com/..."
  },
  "sizePrecheck": {
    "baselineExists": true,
    "baselineWidth": 1440,
    "baselineHeight": 900,
    "newestWidth": 1440,
    "newestHeight": 900,
    "widthDiff": 0,
    "heightDiff": 0,
    "sizeChanged": false,
    "source": "figma-metadata"
  },
  "reportFiles": {
    "jsonPath": "/.../data/report-history/2026-04-03/2026-04-03T09-35-10-201Z__home_header.json",
    "diffPath": "/.../data/report-history/2026-04-03/2026-04-03T09-35-10-201Z__home_header.diff.png"
  }
}
```

## 5) IF conditions in n8n

Major only:

```js
{{ $json.severity === 'major' }}
```

Major or minor:

```js
{{ $json.severity !== 'none' }}
```

## 6) Slack message example

```text
Figma visual check completed
Case: {{$json.caseName}}
Status: {{$json.status}}
Diff: {{$json.percentage}}% ({{$json.severity}})
Report JSON: {{$json.reportFiles.jsonPath}}
Diff image: {{$json.reportFiles.diffPath || 'n/a'}}
```

## 7) Read report history

List all date folders / files:

```bash
curl "http://localhost:3000/api/reports"
```

List one day:

```bash
curl "http://localhost:3000/api/reports?date=2026-04-03"
```

## 8) Quick curl tests

Create/compare via direct rendered image URL:

```bash
curl -X POST "http://localhost:3000/api/figma/sync/home_header" \
  -H "Content-Type: application/json" \
  -d '{
    "figmaImageUrl":"https://example.com/newest.png",
    "figmaWidth":1440,
    "figmaHeight":900
  }'
```

Create/compare via Figma API mode:

```bash
curl -X POST "http://localhost:3000/api/figma/sync/home_header" \
  -H "Content-Type: application/json" \
  -d '{
    "figmaFileKey":"<file_key>",
    "figmaNodeId":"12:34",
    "figmaToken":"<figma_personal_access_token>",
    "figmaWidth":1440,
    "figmaHeight":900
  }'
```

Health check:

```bash
curl "http://localhost:3000/health"
```

## 9) Common issues

- `Missing Figma input`: provide `figmaImageUrl` (or `imageUrl`) OR `figmaFileKey + figmaNodeId`
- `Missing Figma token`: send `figmaToken` or set `FIGMA_TOKEN` env var on server
- `Figma images API failed`: invalid token, file key, node id, or permission issue
- `Failed to fetch image`: rendered URL inaccessible, expired, or blocked
- `ECONNREFUSED`: wrong host/port or API not running
- if `sizePrecheck.sizeChanged` is true, severity is forced to `major` by design
