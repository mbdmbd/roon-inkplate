# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository rather than in a public issue. Include the steps to reproduce and
the version (commit) you tested.

## Design notes

roon-inkplate is meant for a trusted home network. In summary:

- **The HTTP API is LAN-only.** Don't publish port 8765 to the internet.
- **Cross-site requests are refused.** `POST /control` rejects any request that
  carries an `Origin` or `Sec-Fetch-Site` header, so a web page in someone's
  browser can't send commands. The Inkplate and command-line tools don't send
  these headers.
- **DNS rebinding is blocked.** Every endpoint rejects requests whose `Host`
  header isn't an IP address, `localhost`, a `.local` name or a name listed in
  `ALLOWED_HOSTS`.
- **Commands can require a token.** Set `CONTROL_TOKEN` on the bridge and the
  same value in the Inkplate's `config.h` to stop other devices on the network
  from sending commands. The read-only endpoints (`/frame`, `/status`,
  `/preview.png`) stay open to the LAN.
- **The volume ceiling is enforced by the bridge**, not the panel, and settings
  are validated at startup: the bridge refuses to run with a value that could
  defeat it.
- **Untrusted metadata is bounded.** Track text (which internet radio stations
  control) is stripped of control characters, capped in length and escaped
  before rendering.
- **Secrets stay out of git.** The Roon pairing token (`bridge/config.json`)
  and the firmware's `config.h` (Wi-Fi password, control token) are in
  `.gitignore`, and files the bridge writes are readable only by its user.
- **Physical access wins.** The Wi-Fi password and control token are stored
  unencrypted in the ESP32's flash. Consider putting the Inkplate on an IoT or
  guest network that can only reach the bridge.
- **Traffic is plain HTTP** between the Inkplate and the bridge, as is Roon's
  own extension protocol.
