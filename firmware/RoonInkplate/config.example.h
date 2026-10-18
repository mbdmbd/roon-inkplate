#pragma once
// Copy this file to config.h (same folder) and fill in your details.
// config.h is ignored by git so your Wi-Fi password stays out of the repository.

// 2.4 GHz network only (the ESP32 has no 5 GHz radio).
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"

// The machine running the bridge. Give it a fixed IP (DHCP reservation) and use
// the IP: the ESP32's HTTP client doesn't reliably resolve .local names.
#define BRIDGE_URL "http://192.168.1.10:8765/frame"

// Optional: must match CONTROL_TOKEN on the bridge. Leave empty if the bridge
// doesn't set one. Generate one with: openssl rand -hex 16
#define CONTROL_TOKEN ""

// How often to ask the bridge for changes. Unchanged frames cost a 304.
#define POLL_INTERVAL_MS 2000

// If the bridge is unreachable this long, fade the frontlight out (image stays).
#define BRIDGE_LOST_MS (10UL * 60UL * 1000UL)

// If Wi-Fi stays down this long, reboot the ESP32.
#define WIFI_LOST_REBOOT_MS (5UL * 60UL * 1000UL)
