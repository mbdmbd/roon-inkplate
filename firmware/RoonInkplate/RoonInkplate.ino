/*
 * RoonInkplate: Inkplate 6PLUS client for roon-inkplate-bridge.
 *
 * Polls the bridge for a ready-made 1024x758 frame (4 bits per pixel,
 * levels 0-7, high nibble = left pixel), draws it in 3-bit greyscale mode and
 * sets the frontlight from the X-Frontlight header. All Roon logic, layout and
 * dithering live in the bridge, so this sketch rarely needs reflashing.
 *
 * Touch (directions as you look at the panel):
 *   Album art:  tap = play/pause, swipe left = next, swipe right = previous,
 *               swipe up = volume up, swipe down = volume down
 *   Text area:  tap = light on/off, swipe up = brighter, swipe down = dimmer
 * A quick pulse of the frontlight confirms a playback or volume command.
 *
 * Board: Tools > Board > Soldered Inkplate Boards > "Soldered Inkplate 6PLUS"
 *        (or "e-radionica Inkplate 6PLUS" for the original crowdfunded board)
 * Library: InkplateLibrary by Soldered, v10 or v11+ (see inkplate_compat.h)
 *
 * Setup: copy config.example.h to config.h and fill in Wi-Fi and the bridge URL.
 */

#if !defined(ARDUINO_INKPLATE6PLUS) && !defined(ARDUINO_INKPLATE6PLUSV2)
#error "Select an Inkplate 6PLUS board in Tools > Board"
#endif

#include "Inkplate.h"
#include <WiFi.h>
#include <HTTPClient.h>
#if __has_include("config.h")
#include "config.h"
#else
#error "Copy config.example.h to config.h and fill in your Wi-Fi details and bridge URL"
#endif
#ifndef CONTROL_TOKEN
#define CONTROL_TOKEN "" // older config.h files don't define it
#endif
#include "inkplate_compat.h"

static const int PANEL_W = 1024;
static const int PANEL_H = 758;
static const int ART = 758; // the art square, in upright (viewer) pixels
static const size_t FRAME_BYTES = (size_t)PANEL_W * PANEL_H / 2;

// Gesture tuning, in panel pixels (about 8 per millimetre).
static const int SWIPE_MIN_PX = 90;              // ~11 mm of travel to count as a swipe
static const int TAP_MAX_PX = 30;                // a tap may wobble this much
static const uint32_t TAP_MAX_MS = 600;          // longer presses are ignored
static const uint32_t RELEASE_TIMEOUT_MS = 800;  // in case a lift-off report is missed

Inkplate display(INKPLATE_3BIT);

static String etag;           // ETag of the frame currently on the panel
static String controlUrl;     // BRIDGE_URL with /frame replaced by /control
static int currentLight = 0;  // frontlight level 0-63 (off after every reset)
static bool portrait = true;  // layout and rotation come from the bridge's headers
static int rotateDeg = 90;
static bool touchOk = false;
static uint8_t rxBuf[4096];
static uint32_t lastPollAt = 0;
static uint32_t lastPollOk = 0;
static uint32_t wifiLostAt = 0;

struct Gesture
{
    bool down;
    int sx, sy, lx, ly; // start and latest point, viewer coordinates
    uint32_t t0, tLast;
};
static Gesture g = {};

// ---------------------------------------------------------------- frontlight

// Smoothly move the frontlight to a level (0 turns the circuit off).
void fadeTo(int target)
{
    target = constrain(target, 0, 63);
    if (target == currentLight)
        return;
    if (currentLight == 0)
    {
        setFrontlightLevel(display, 0);
        setFrontlightPower(display, true);
    }
    int step = target > currentLight ? 1 : -1;
    for (int v = currentLight; v != target; v += step)
    {
        setFrontlightLevel(display, v + step);
        delay(15);
    }
    currentLight = target;
    if (target == 0)
        setFrontlightPower(display, false);
}

// Brief flash to acknowledge a command; the e-ink takes seconds to show it.
void pulseLight()
{
    int base = currentLight;
    int peak = base > 39 ? base - 24 : base + 24;
    int step = peak > base ? 4 : -4;
    if (base == 0)
    {
        setFrontlightLevel(display, 0);
        setFrontlightPower(display, true);
    }
    for (int v = base; v != peak; v += step)
    {
        setFrontlightLevel(display, v);
        delay(8);
    }
    for (int v = peak; v != base; v -= step)
    {
        setFrontlightLevel(display, v);
        delay(8);
    }
    setFrontlightLevel(display, base);
    if (base == 0)
        setFrontlightPower(display, false);
}

// ------------------------------------------------------------------ bridge

static const char *HEADER_KEYS[] = {"ETag", "X-Frontlight", "X-Layout", "X-Rotate"};

// Picks up layout/rotation; returns the frontlight level, or -1 if absent.
int readBridgeHeaders(HTTPClient &http)
{
    String layout = http.header("X-Layout");
    if (layout.length())
        portrait = layout != "landscape";
    String rot = http.header("X-Rotate");
    if (rot.length())
        rotateDeg = rot.toInt();
    String light = http.header("X-Frontlight");
    return light.length() ? light.toInt() : -1;
}

// Returns true if the bridge answered (200 or 304), false on any failure.
bool pollBridge()
{
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(10000);
    if (!http.begin(BRIDGE_URL))
        return false;
    http.collectHeaders(HEADER_KEYS, 4);
    if (etag.length())
        http.addHeader("If-None-Match", etag);

    int code = http.GET();
    if (code == HTTP_CODE_NOT_MODIFIED)
    {
        int light = readBridgeHeaders(http);
        http.end();
        if (light >= 0)
            fadeTo(light); // light changes arrive without a new frame
        return true;
    }
    if (code != HTTP_CODE_OK || http.getSize() != (int)FRAME_BYTES)
    {
        Serial.printf("bridge: HTTP %d, %d bytes\n", code, http.getSize());
        http.end();
        return false;
    }

    // Stream straight into the Inkplate framebuffer; nothing is shown until
    // the whole frame has arrived, so a dropped transfer leaves the panel alone.
    WiFiClient *stream = http.getStreamPtr();
    size_t got = 0;
    uint32_t lastData = millis();
    while (got < FRAME_BYTES)
    {
        size_t avail = stream->available();
        if (avail == 0)
        {
            if (!stream->connected() || millis() - lastData > 5000)
                break;
            delay(2);
            continue;
        }
        size_t want = FRAME_BYTES - got;
        if (want > sizeof(rxBuf))
            want = sizeof(rxBuf);
        if (want > avail)
            want = avail;
        size_t n = stream->readBytes(rxBuf, want);
        for (size_t i = 0; i < n; i++)
        {
            size_t p = (got + i) * 2; // two pixels per byte; rows are even-length
            int x = p % PANEL_W;
            int y = p / PANEL_W;
            display.drawPixel(x, y, rxBuf[i] >> 4);
            display.drawPixel(x + 1, y, rxBuf[i] & 0x0F);
        }
        got += n;
        lastData = millis();
    }

    String newTag = http.header("ETag");
    int light = readBridgeHeaders(http);
    http.end();

    if (got != FRAME_BYTES)
    {
        Serial.printf("bridge: short read %u/%u\n", (unsigned)got, (unsigned)FRAME_BYTES);
        return false; // etag unchanged, so the next poll fetches it again
    }

    if (light == 0)
        fadeTo(0); // going idle: light off before the refresh
    display.display();
    if (light > 0)
        fadeTo(light); // playing: light up once the new cover is on screen
    etag = newTag;
    Serial.printf("bridge: new frame %s, light %d\n", etag.c_str(), light);
    return true;
}

// Sends a touch command; returns true if the bridge carried it out.
bool sendControl(const char *action)
{
    if (WiFi.status() != WL_CONNECTED)
        return false;
    HTTPClient http;
    http.setConnectTimeout(2000);
    http.setTimeout(4000);
    if (!http.begin(controlUrl + "?action=" + action))
        return false;
    if (strlen(CONTROL_TOKEN) > 0)
        http.addHeader("X-Control-Token", CONTROL_TOKEN);
    http.collectHeaders(HEADER_KEYS, 4);
    int code = http.POST("");
    int light = readBridgeHeaders(http);
    http.end();
    Serial.printf("control %s: HTTP %d\n", action, code);
    if (code == 401)
        Serial.println("control: bridge wants a CONTROL_TOKEN; check config.h matches the bridge");
    if (light >= 0)
        fadeTo(light);
    return code == HTTP_CODE_OK;
}

// ------------------------------------------------------------------- touch

// Native touch coordinates -> upright viewer coordinates (mirrors the bridge's rotation).
void toView(int nx, int ny, int &vx, int &vy)
{
    if (!portrait)
    {
        vx = nx;
        vy = ny;
    }
    else if (rotateDeg == 270)
    {
        vx = PANEL_H - 1 - ny;
        vy = nx;
    }
    else
    {
        vx = ny;
        vy = PANEL_W - 1 - nx;
    }
}

void finishGesture()
{
    g.down = false;
    int dx = g.lx - g.sx;
    int dy = g.ly - g.sy;
    int adx = abs(dx), ady = abs(dy);
    uint32_t ms = g.tLast - g.t0;
    bool inArt = g.sx < ART && g.sy < ART;
    const char *action = nullptr;

    if (adx <= TAP_MAX_PX && ady <= TAP_MAX_PX)
    {
        if (ms <= TAP_MAX_MS)
            action = inArt ? "playpause" : "light_toggle";
    }
    else if (adx >= SWIPE_MIN_PX && adx > ady * 2)
    {
        if (inArt)
            action = dx < 0 ? "next" : "previous";
    }
    else if (ady >= SWIPE_MIN_PX && ady > adx * 2)
    {
        if (inArt)
            action = dy < 0 ? "vol_up" : "vol_down";
        else
            action = dy < 0 ? "light_up" : "light_down";
    }

    Serial.printf("touch: %s (%d,%d) dx=%d dy=%d %ums -> %s\n", inArt ? "art" : "text", g.sx, g.sy, dx, dy,
                  (unsigned)ms, action ? action : "ignored");
    if (!action)
        return;
    bool lightAction = strncmp(action, "light", 5) == 0;
    if (sendControl(action) && !lightAction)
        pulseLight();
}

void handleTouch()
{
    if (!touchOk)
        return;
    uint32_t now = millis();
    if (touchAvailable(display))
    {
        uint16_t x[2], y[2];
        uint8_t fingers = touchRead(display, x, y);
        if (fingers > 0)
        {
            int vx, vy;
            toView(x[0], y[0], vx, vy);
            if (!g.down)
            {
                g.down = true;
                g.sx = vx;
                g.sy = vy;
                g.t0 = now;
            }
            g.lx = vx;
            g.ly = vy;
            g.tLast = now;
        }
        else if (g.down)
        {
            g.tLast = now; // lift-off
            finishGesture();
        }
    }
    else if (g.down && now - g.tLast > RELEASE_TIMEOUT_MS)
    {
        g.tLast = now; // missed lift-off: treat as a long press, never a tap
        finishGesture();
    }
}

// -------------------------------------------------------------------- main

void setup()
{
    Serial.begin(115200);
    display.begin();
    display.clearDisplay(); // clears the buffer only; the panel keeps its image

    touchOk = touchBegin(display);
    Serial.println(touchOk ? "touchscreen ready" : "touchscreen init failed");

    controlUrl = String(BRIDGE_URL);
    controlUrl = controlUrl.substring(0, controlUrl.lastIndexOf('/')) + "/control";

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false); // mains powered: avoid modem-sleep latency
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);

    lastPollOk = millis();
}

void loop()
{
    handleTouch();

    uint32_t now = millis();
    if (!g.down && now - lastPollAt >= POLL_INTERVAL_MS)
    {
        lastPollAt = now;
        if (WiFi.status() == WL_CONNECTED)
        {
            wifiLostAt = 0;
            if (pollBridge())
                lastPollOk = millis();
        }
        else if (wifiLostAt == 0)
        {
            wifiLostAt = now;
        }
        else if (now - wifiLostAt > WIFI_LOST_REBOOT_MS)
        {
            ESP.restart();
        }

        // Bridge gone (Mac asleep, service stopped): don't leave the light on forever.
        if (currentLight > 0 && millis() - lastPollOk > BRIDGE_LOST_MS)
            fadeTo(0);
    }

    delay(5);
}
