# Vision NVR

WS1-U6 shell for the VMS. The frontend is the baseline Vision NVR page with locked primary navigation. The API stores cameras in SQLite, probes the LAN for ONVIF devices, authenticates a selected device on the server, configures that camera from non-secret device information, runs non-media test checks with the stored login, and closes onboarding with Review and Success. Live View then shows a picture for a camera whose status is `ready`. The media URI and the login stay on the server. The browser only receives a same-origin proxy path.

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

IPv6 discovery is a later unit. Authentication, configure, and test call the ONVIF device service. Configure also calls GetProfiles on a same-host media service when the device advertises one. Test does not. Live View, and only for a `ready` camera, calls GetStreamUri on that same-host media service and proxies frames. WebRTC, MediaMTX, and go2rtc are not started.

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

`POST /api/cameras/:id/configure` saves `name`, `site`, and `group`, plus an optional `profileId` chosen from the profiles just read. The saved camera status is `configured`. Public GETs may then include `manufacturer`, `model`, `profileId`, and `profileLabel`. They still do not include the login, a stream URL, or firmware. `GET /api/cameras/:id/stream` returns HTTP 409 until the camera is `ready`. Saving before a successful read returns `not_interrogated`. A camera with no stored login returns `not_authenticated`. Signing in again clears the saved device fields and sets status back to `authenticated`.

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

A camera that is not configured returns `not_configured` (HTTP 409). A camera with no stored login returns `not_authenticated`. An unknown id returns `not_found`. Those errors do not include the request body. `GET /api/cameras/:id/stream` returns HTTP 409 while the camera is not `ready`.

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

## Review, then Success

Review and Success run after a passed Test. They do not call the device and they do not read the stored login. The operator does not type a username or password. A request body cannot replace that login. Fields other than `confirm: true` are ignored.

`POST /api/cameras/:id/review` confirms the non-secret summary for a camera whose status is `configured` and whose `lastTestSummary` is `passed`. The server stores `reviewedAt`. Status stays `configured`. A camera that has not passed Test returns `not_tested` (HTTP 409). A camera whose last test failed returns `test_failed` (HTTP 409). Confirming again keeps the same `reviewedAt`.

`POST /api/cameras/:id/success` marks that reviewed camera `ready`. `ready` means onboarding is finished and Live View may open a picture. Success itself does not contact the device and does not open a stream. Success before review returns `not_reviewed` (HTTP 409). The same not-tested and failed-test rejections apply. Marking a camera that is already `ready` returns the saved row again.

Public GETs may include `reviewedAt` after review, and `status` `ready` after success. They still omit the login, firmware, and any stream URL. The stream route is a separate request and is described under Live View.

A new Test run clears `reviewedAt`, so Success requires Review again. Saving Configure again returns status to `configured` and clears `reviewedAt`. The last test summary remains until a new test or a new sign-in. Signing in again clears the test summary, the review time, and the ready state, and sets status back to `authenticated`.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/review \
  -H 'content-type: application/json' \
  -d '{"confirm":true}'
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/success \
  -H 'content-type: application/json' \
  -d '{"confirm":true}'
```

```json
{"ok":false,"contract":"onvif.review.v0","error":"not_tested"}
```

```json
{"ok":false,"contract":"onvif.success.v0","error":"test_failed"}
```

The Cameras page **Review** card lists cameras that passed Test and shows name, site, group, manufacturer, model, profile label, and last test summary. **Success** lists a reviewed camera and marks it ready. Neither card has a password field, and neither card shows video.

This step does not need a camera LAN. No device call is made.

## Live View

Live View plays a picture for cameras whose status is `ready`. The browser never receives the camera login or the media URI.

`GET /api/cameras/:id/stream` is the public contract.

- A camera that is not `ready` returns HTTP 409 `not_ready`.
- A camera with no stored login returns HTTP 409 `not_authenticated`.
- A ready camera with no saved profile returns HTTP 409 `missing_profile`.
- An unknown id returns HTTP 404 `not_found`.
- A ready camera with a profile makes the server call ONVIF GetStreamUri on the media service advertised for that same host, using the stored login. A media URI on a different host is rejected. The URI stays on the server.
- When that call succeeds, the response is the proxy path only:

```json
{
  "ok": true,
  "contract": "onvif.stream.v0",
  "cameraId": "<id>",
  "stream": "/api/cameras/<id>/live",
  "delivery": "mjpeg",
  "profileId": "<profile>"
}
```

`stream` is a same-origin path. It is not a media URI. `GET /api/cameras/:id/live` resolves the URI again and proxies JPEG frames as `multipart/x-mixed-replace`. The page shows those frames in the tile, or the words Connecting or a fixed error line. Tiles do not show a recording badge or a frame-rate badge.

A device that rejects the login returns HTTP 401 `auth_failed`. A device that does not answer returns HTTP 502 `unreachable`. A resolved URI that cannot be pulled returns HTTP 502 `stream_unavailable`. Those bodies have no login and no media URI.

The Live View page loads `/api/cameras` and, for each ready camera, `/api/cameras/<id>/stream`. It then sets the tile image to the returned path only when that path is exactly `/api/cameras/<id>/live`. It does not render response bodies.

### Verify with a real ONVIF camera

1. Install `ffmpeg` on the machine that runs this server. The server uses it to read the camera URI and write JPEG frames. The browser does not open that URI.
2. Run `npm start` on a host that can reach the camera LAN.
3. Discover the camera, authenticate, configure a profile, run Test, confirm Review, and mark Success.
4. Open Live View. The ready camera tile connects and shows frames.
5. In the browser network panel, confirm the stream and live responses contain no username, no password, and no media URI.

This cloud VM has no route to a camera LAN, and a physical camera was not viewed here. `npm test` injects `streamOptions.client` for GetStreamUri and `streamOptions.frameSource` for frames. Without a puller, or when the device does not answer, the live route returns `stream_unavailable` or `unreachable` and still omits the URI. A Founder check on a real camera is still required.

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
| `GET` | `/api/cameras/:id/stream` | For a ready camera with a profile, a same-origin `/live` path and `delivery: "mjpeg"`. Otherwise 409 or 502. No media URI. |
| `GET` | `/api/cameras/:id/live` | JPEG frames for that ready camera. The login and media URI stay on the server. |
| `POST` | `/api/onvif/discover` | Live WS-Discovery probe. `implemented: true`. `devices` is an array. |
| `POST` | `/api/onvif/authenticate` | Device-service login. Stores credentials only in SQLite. Response has no username or password. |
| `POST` | `/api/cameras/:id/interrogate` | Reads device info and profiles with the stored login. Response has no username, password, or stream URL. |
| `POST` | `/api/cameras/:id/configure` | Saves name, site, group, and an optional profile id. Status becomes `configured`. |
| `POST` | `/api/cameras/:id/test` | Non-media checks for a configured camera, using the stored login. Media checks are `skipped`. |
| `POST` | `/api/onvif/test` | Same test. Body is `{ "cameraId": "<id>" }`. Other fields are ignored. |
| `POST` | `/api/cameras/:id/review` | Confirms the non-secret summary after a passed test. Stores `reviewedAt`. Body is `{ "confirm": true }`. |
| `POST` | `/api/cameras/:id/success` | Marks a reviewed camera `ready`. This call does not open a stream. Body is `{ "confirm": true }`. |

Example:

```bash
curl -sS http://127.0.0.1:8787/api/cameras
curl -sS -X POST http://127.0.0.1:8787/api/onvif/discover -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8787/api/cameras/<id>/test -H 'content-type: application/json' -d '{}'
```

Saved cameras from `POST /api/cameras` accept a display name, site, and group only. That route drops every other field, including a password. Text that contains URL userinfo is stored without that userinfo. Camera list responses never include a stream URL. The stream route returns only a same-origin proxy path, and only after the camera is `ready`. A password is stored only by the authenticate route, and only in `camera_credentials`.

`npm test` checks the empty list, the discover envelope, a scripted ProbeMatches reply, the real socket path, device-service success and failure with an injected client, interrogation and configure save with an injected device client, non-media test checks with an injected device client, review and success for a passed test, rejection of untested and failed-test cameras, refusal of streams for cameras that are not ready, a proxied frame for a ready camera with an injected media client, and that secret-bearing fields are not logged or returned.

## UI scope

Primary navigation is **Live View**, **Playback**, **Cameras**, **Storage**, and **Settings**. Live tiles show ready cameras, with a connecting line or an error line until frames arrive. Playback, Storage, and Settings stay shells. Camera records added in the UI show under Cameras; they do not start video until Success has marked them ready and Live View opens the proxy. Discover results are not saved until Authenticate succeeds. The Authenticate card is the only place a password is typed, and that value is posted to the server and then cleared. Configure reads the stored device and saves name, site, group, and an optional profile. Test runs network, authentication, ONVIF, and saved device-info checks for a configured camera. Stream checks in Test stay skipped. Review shows the non-secret summary and confirms it. Success marks the camera ready. Configure, Test, Review, and Success do not ask for the password again and they do not open a stream.
