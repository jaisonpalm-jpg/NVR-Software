# Vision NVR

WS1-U4 shell for the VMS. The frontend is the baseline Vision NVR page with locked primary navigation. The API stores cameras in SQLite, probes the LAN for ONVIF devices, authenticates a selected device on the server, configures that camera from non-secret device information, and runs non-media test checks with the stored login. This unit does not open streams or play video.

## Run locally

Requires Node.js 22 or newer. The API uses the built-in `node:sqlite` and `node:dgram` modules, so there are no packages to install.

```bash
npm start
```

One process serves both:

- Frontend: http://127.0.0.1:8787
- API: http://127.0.0.1:8787/api/cameras

`npm run api` and `npm run frontend` start that same process. Open the frontend in a browser at the URL above; do not open `index.html` as a file, or the API calls will have nowhere to go.

Optional environment variables:

- `PORT` — listen port, default `8787`
- `VMS_DB_PATH` — SQLite file, default `data/vms.sqlite`

The database file is created on first start and is gitignored.

## Discover ONVIF devices

`POST /api/onvif/discover` sends WS-Discovery Probe datagrams (SOAP over UDP) and waits for ProbeMatches.

- Multicast group: `239.255.255.250`
- Port: `3702`
- Probe types: `dn:NetworkVideoTransmitter` and `tds:Device`
- Default wait: 2 seconds (`timeoutMs` from 100 through 5000)

An empty network is a successful result: `ok: true`, `implemented: true`, and `devices: []`. Discovery does not add rows to the camera store.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover \
  -H 'content-type: application/json' \
  -d '{}'
```

Optional unicast probe of one host. `port` is the WS-Discovery UDP port and defaults to `3702`. This is not an ONVIF HTTP login and it does not call GetDeviceInformation.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover \
  -H 'content-type: application/json' \
  -d '{"host":"192.168.1.64","port":3702,"timeoutMs":2000}'
```

Each device, when a camera answers, includes `address`, ONVIF `port` when the XAddr has one, `name`, `manufacturer`, and `model` when those scopes are present, plus a `probe` object (`endpoint`, `types`, `metadataVersion`, `xaddrs`, `scopes`). Username, password, and any other body fields are ignored. They are not logged, stored, or copied into the JSON. URL userinfo is stripped from XAddrs and scopes.

The Cameras page button **Discover ONVIF devices** calls this endpoint with an empty body and lists the result. Saving a camera is a separate name / site / group action.

### Network notes

The process must be allowed to send and receive UDP on the LAN interface. Replies come back to the ephemeral source port, so a host firewall has to allow that inbound UDP. Linux containers often drop multicast unless they use the host network. macOS local-network privacy can block packaged apps; a normal Node process on a developer machine can send the probe.

This cloud agent VM has no route to a camera LAN. The probe still runs. With no answers it returns `devices: []`.

IPv6 discovery is a later unit. Authentication, configure, and test call the ONVIF device service. Configure also calls GetProfiles on a same-host media service when the device advertises one. Test does not. This unit does not resolve an RTSP URI, start WebRTC, or start a media server such as MediaMTX or go2rtc.

## Authenticate a discovered device

`POST /api/onvif/authenticate` takes the host and ONVIF port from a discover result (optional `scheme`, `path`, and display `name`) plus a username and password. The server calls `GetDeviceInformation` on that device service with a WS-Security UsernameToken. The password is sent only as a digest. The raw password is not placed in the SOAP body.

Login is stored only in the SQLite table `camera_credentials`, tied to the camera by host and ONVIF port. The database file is mode `0600` when the process can set it, and it is gitignored. `GET /api/cameras` and `GET /api/cameras/:id` select the public allowlist (`id`, `name`, `site`, `group`, `status`, `createdAt`) and never read `camera_credentials`. A successful device-service response sets `status` to `authenticated`. A rejected or unanswered attempt stores nothing and does not mark a camera authenticated. Signing in again to the same host and port updates the stored login and keeps one camera row.

The response is success or failure only:

```json
{"ok":true,"contract":"onvif.authenticate.v0","authenticated":true,"cameraId":"<id>"}
```

```json
{"ok":false,"contract":"onvif.authenticate.v0","authenticated":false,"error":"auth_failed"}
```

`error` is `auth_failed` (HTTP 401) or `unreachable` (HTTP 502). Bodies, later GETs, and process logs do not include the username, the password, or a stream URL.

The Cameras page password field posts that JSON to the server and is cleared on submit. The page does not write credentials to `localStorage` or `sessionStorage`, and it does not render the response body. Fixed text reports authenticated, failed, or unanswered.

This cloud VM has no route to a camera LAN, so a physical device was not authenticated here. The default client is still the device-service call. Tests inject `authOptions.client` or `authOptions.fetchImpl`. A call to a non-routable address returns `unreachable` and stores nothing. No RTSP URI is resolved, and WebRTC, MediaMTX, and go2rtc are not started.

## Configure an authenticated camera

Configure uses the login already stored in `camera_credentials`. The operator does not type the username or password again. Re-authentication is the only path that replaces that login.

`POST /api/cameras/:id/interrogate` loads that stored login and calls `GetDeviceInformation` and `GetCapabilities` on the device service. When capabilities advertise a media service on the same host, it calls `GetProfiles` there. It does not call `GetStreamUri`. The response is non-secret device information and profile ids and labels. A media address with URL userinfo is stripped before use, and a media address on a different host is ignored. Username, password, serial number, and stream URIs are not returned. A failed read returns `auth_failed` or `unreachable` and does not change the camera.

`POST /api/cameras/:id/configure` saves `name`, `site`, and `group`, plus an optional `profileId` chosen from the profiles just read. The saved camera status is `configured`. Public GETs may then include `manufacturer`, `model`, `profileId`, and `profileLabel`. They still do not include the login, a stream URL, or firmware. `GET /api/cameras/:id/stream` stays `{ "stream": null, "delivery": "unavailable" }`. Saving before a successful read returns `not_interrogated`. A camera with no stored login returns `not_authenticated`. Signing in again clears the saved device fields and sets status back to `authenticated`.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/interrogate \
  -H 'content-type: application/json' \
  -d '{}'
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/configure \
  -H 'content-type: application/json' \
  -d '{"name":"Gate","site":"Main","group":"Exterior","profileId":"Profile_1"}'
```

The Cameras page **Configure** card lists authenticated cameras, reads the device, and saves those fields. It has no password field.

This cloud VM has no route to a camera LAN, so a physical device was not interrogated here. The default client is still the device and media capability calls. Tests inject `interrogateOptions.client` or `interrogateOptions.fetchImpl`. A call to a non-routable address returns `unreachable`. No RTSP URI is resolved, and WebRTC, MediaMTX, and go2rtc are not started.

## Test a configured camera

Test runs after Configure. It uses the login already stored in `camera_credentials` and the device snapshot from interrogation. The operator does not type the username or password again. A request body cannot replace that login.

`POST /api/cameras/:id/test` (and `POST /api/onvif/test` with `{ "cameraId": "<id>" }`) is for a camera whose status is `configured`.

Real checks, with no media:

| Check | What it does |
| --- | --- |
| `network` | TCP connect to the stored host and ONVIF port. `pass` or `fail` (`unreachable`). |
| `authentication` | `GetDeviceInformation` with the stored login. `pass`, or `fail` with `auth_failed` when the device answers and rejects the login. |
| `onvif` | The device service answered that call. `pass` on a device-information response or an authentication fault. `fail` when the service does not answer. |
| `deviceInfo` | Saved manufacturer, model, or profile from the prior interrogation. `pass` when at least one is present. `fail` with `no_device_info` when none are. |

Deferred checks stay `skipped` with reason `not_implemented`: `mainStream`, `substream`, `ptz`, `audio`, and `events`. Test does not call `GetStreamUri`, `GetProfiles`, or `GetCapabilities`, and it does not open RTSP or WebRTC.

A finished run returns HTTP 200. `summary` is `passed` when every real check passed, otherwise `failed`. `ok` follows that summary. The server stores only `lastTestAt` and `lastTestSummary` (`passed` or `failed`). Public GETs may include those two fields. They still omit the login, firmware, and any stream URL. Signing in again clears the test summary with the other saved device fields.

A camera that is not configured returns `not_configured` (HTTP 409). A camera with no stored login returns `not_authenticated`. An unknown id returns `not_found`. Those errors do not include the request body. `GET /api/cameras/:id/stream` stays `{ "stream": null, "delivery": "unavailable" }`.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/test \
  -H 'content-type: application/json' \
  -d '{}'
```

```json
{
  "ok": true,
  "contract": "onvif.test.v0",
  "implemented": true,
  "cameraId": "<id>",
  "summary": "passed",
  "checkedAt": "2026-09-26T00:00:00.000Z",
  "checks": [
    { "name": "network", "status": "pass" },
    { "name": "authentication", "status": "pass" },
    { "name": "onvif", "status": "pass" },
    { "name": "deviceInfo", "status": "pass" },
    { "name": "mainStream", "status": "skipped", "reason": "not_implemented" },
    { "name": "substream", "status": "skipped", "reason": "not_implemented" },
    { "name": "ptz", "status": "skipped", "reason": "not_implemented" },
    { "name": "audio", "status": "skipped", "reason": "not_implemented" },
    { "name": "events", "status": "skipped", "reason": "not_implemented" }
  ]
}
```

The Cameras page **Test** card lists configured cameras and runs this call. It has no password field. Check lines are fixed labels. The page does not print the raw response.

This cloud VM has no route to a camera LAN, so a physical device was not tested here. The default client is still the TCP connect plus `GetDeviceInformation`. Tests inject `testOptions.client`, `testOptions.connectImpl`, or `testOptions.fetchImpl`. A non-routable address fails `network` and does not open a stream.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/onvif/authenticate \
  -H 'content-type: application/json' \
  -d '{"host":"192.0.2.10","port":80,"username":"<redacted>","password":"<redacted>"}'
```

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/cameras` | JSON array. Empty until a camera is saved. |
| `POST` | `/api/cameras` | Saves `name`, `site`, and `group`. Status is `unknown`. |
| `GET` | `/api/cameras/:id` | Public camera record, or `404`. |
| `GET` | `/api/cameras/:id/stream` | `{ "stream": null, "delivery": "unavailable" }`. No stream URL. |
| `POST` | `/api/onvif/discover` | Live WS-Discovery probe. `implemented: true`. `devices` is an array. |
| `POST` | `/api/onvif/authenticate` | Device-service login. Stores credentials only in SQLite. Response has no username or password. |
| `POST` | `/api/cameras/:id/interrogate` | Reads device info and profiles with the stored login. Response has no username, password, or stream URL. |
| `POST` | `/api/cameras/:id/configure` | Saves name, site, group, and an optional profile id. Status becomes `configured`. |
| `POST` | `/api/cameras/:id/test` | Non-media checks for a configured camera, using the stored login. Media checks are `skipped`. |
| `POST` | `/api/onvif/test` | Same test. Body is `{ "cameraId": "<id>" }`. Other fields are ignored. |

Example:

```bash
curl -sS http://127.0.0.1:8787/api/cameras
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/test -H 'content-type: application/json' -d '{}'
```

Saved cameras from `POST /api/cameras` accept a display name, site, and group only. That route drops every other field, including a password. Text that contains URL userinfo is stored without that userinfo. Responses never include a stream URL. A password is stored only by the authenticate route, and only in `camera_credentials`.

`npm test` checks the empty list, the discover envelope, a scripted ProbeMatches reply, the real socket path, device-service success and failure with an injected client, interrogation and configure save with an injected device client, non-media test checks with an injected device client, and that secret-bearing fields are not logged or returned.

## UI scope

Primary navigation is **Live View**, **Playback**, **Cameras**, **Storage**, and **Settings**. Live tiles are the existing visual placeholders. Playback, Storage, and Settings are shells. Camera records added in the UI show under Cameras; they do not start video. Discover results are not saved until Authenticate succeeds. The Authenticate card is the only place a password is typed, and that value is posted to the server and then cleared. Configure reads the stored device and saves name, site, group, and an optional profile. Test runs network, authentication, ONVIF, and saved device-info checks for a configured camera. Stream checks stay skipped. Configure and Test do not ask for the password again and they do not open a stream.
