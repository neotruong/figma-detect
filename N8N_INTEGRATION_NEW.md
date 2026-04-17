# n8n Integration Guide for Figma Detect (Multi-Screen Baseline + History)

This project supports a multi-screen baseline-and-history flow designed for Figma automation:

- Keep separate baseline images per screen (onboarding, landing, pricing, etc.)
- Compare incoming Figma images with screen-specific baselines
- Save comparison history per screen  
- Generate diff reports only when changes are detected
- Update baselines to latest images

## 1) API Endpoints

Main endpoints:

- `GET /health` - Health check
- `POST /api/compare` - Compare image with baseline and update history
- `GET /api/history` - Fetch run history for a screen

## 2) POST /api/compare Request

### Request Body Parameters

**Required:**
- `imageUrl` - URL of the Figma image to compare

**Optional (choose one):**
- `screen` - Screen identifier (e.g., "onboarding", "landing", "pricing")
- `baseline` - Full baseline filename (e.g., "onboarding_baseline.png", "landing_baseline.png")

### Examples

**Using screen parameter:**
```json
{
  "imageUrl": "{{ $json.after_image_url }}",
  "screen": "onboarding"
}
```

**Using baseline parameter (n8n compatible):**
```json
{
  "imageUrl": "{{ $json.after_image_url }}",
  "baseline": "onboarding_baseline.png"
}
```

### Response

```json
{
  "status": "ok|baseline_created",
  "severity": "none|minor|major",
  "percentage": 0.0,
  "reportUrl": null,
  "processedAt": "2026-04-16T03:51:25.666Z",
  "screen": "onboarding",
  "baselineFile": "onboarding_baseline.png"
}
```

**Response fields:**
- `status`: "baseline_created" on first run, "ok" on subsequent runs
- `severity`: Classification based on percentage change
- `percentage`: Pixel difference percentage
- `reportUrl`: URL to HTML diff report (null if no changes detected)
- `screen`: Screen identifier extracted from baseline or screen parameter
- `baselineFile`: Name of the baseline file in storage

## 3) GET /api/history Endpoint

Fetch the run history for a screen.

### Query Parameters

**Optional (choose one):**
- `screen` - Screen identifier (e.g., "onboarding")
- `baseline` - Baseline filename (e.g., "onboarding_baseline.png")

### Example

```
GET /api/history?baseline=onboarding_baseline.png
```

### Response

```json
{
  "screen": "onboarding",
  "history": [
    {
      "timestamp": "2026-04-16T03:51:25.373Z",
      "percentage": 0,
      "reportUrl": null,
      "severity": "none"
    },
    {
      "timestamp": "2026-04-16T03:51:26.666Z",
      "percentage": 2.5,
      "reportUrl": "https://...public.blob.vercel-storage.com/reports/onboarding/...",
      "severity": "minor"
    }
  ]
}
```

## 4) Severity Rules

- `major`: `percentage >= 5`
- `minor`: `0.1 <= percentage < 5`
- `none`: `percentage < 0.1`

## 5) n8n Workflow Example

Recommended node sequence:

1. `Schedule Trigger` or `Webhook`
2. `HTTP Request` - Get image URL from Figma Images API
3. `Set` - Prepare data with screen identifier
4. `HTTP Request` - POST to `/api/compare`
5. `IF` - Check severity for notifications
6. `Slack` / `Email` / `Teams` - Send alerts

### Node 4 (HTTP Request) - Compare Request

**Method:** `POST`

**URL:** `https://your-vercel-app.vercel.app/api/compare`

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "imageUrl": "{{ $json.after_image_url }}",
  "baseline": "{{ $json.baseline_name }}"
}
```

### Node 5 (IF) - Check for Changes

```javascript
{{ $json.severity !== 'none' }}
```

For major changes only:
```javascript
{{ $json.severity === 'major' }}
```

## 6) Storage Structure

Data is stored in Vercel Blob:

- `baseline.png` - Default screen baseline
- `onboarding_baseline.png` - Onboarding screen baseline
- `landing_baseline.png` - Landing screen baseline
- `history.json` - Default screen history
- `onboarding_history.json` - Onboarding screen history
- `landing_history.json` - Landing screen history
- `reports/{screen}/{date}/{timestamp}.html` - Diff reports (only created when changes detected)

## 7) Error Handling

The API returns appropriate HTTP status codes:
- `200` - Successful comparison
- `201` - Baseline created (first run)
- `400` - Missing required parameters
- `500` - Server error

Check the response `status` field for detailed status information.

## 8) Slack Message Template Example

```
🎨 Figma Change Detected

Screen: {{ $json.screen }}
Severity: {{ $json.severity.toUpperCase() }}
Change: {{ $json.percentage }}% pixels changed

{{#if $json.reportUrl}}
📊 Report: {{ $json.reportUrl }}
{{/if}}

Processed: {{ $json.processedAt }}
```
