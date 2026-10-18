#pragma once
#include <stdint.h>

// InkplateLibrary renamed its frontlight and touchscreen calls in v11:
//   v10:   display.frontlight(on)          display.setFrontlight(level)
//          display.tsInit(on)              display.tsAvailable()      display.tsGetData(x, y)
//   v11+:  display.frontlight.setState()   display.frontlight.setBrightness()
//          display.touchscreen.init()      display.touchscreen.available()  .getData(x, y)
// These overloads pick whichever the installed library has, at compile time.
// The int/long tag makes the v11 form win whenever it compiles.

// ---- frontlight
template <typename T>
auto frontlightPower(T &d, bool on, int) -> decltype(d.frontlight.setState(on), void())
{
    d.frontlight.setState(on);
}
template <typename T> void frontlightPower(T &d, bool on, long)
{
    d.frontlight(on);
}

template <typename T>
auto frontlightLevel(T &d, uint8_t v, int) -> decltype(d.frontlight.setBrightness(v), void())
{
    d.frontlight.setBrightness(v);
}
template <typename T> void frontlightLevel(T &d, uint8_t v, long)
{
    d.setFrontlight(v);
}

// ---- touchscreen
template <typename T>
auto touchInitImpl(T &d, int) -> decltype(d.touchscreen.init(true), bool())
{
    return d.touchscreen.init(true);
}
template <typename T> bool touchInitImpl(T &d, long)
{
    return d.tsInit(true);
}

template <typename T>
auto touchAvailableImpl(T &d, int) -> decltype(d.touchscreen.available(), bool())
{
    return d.touchscreen.available();
}
template <typename T> bool touchAvailableImpl(T &d, long)
{
    return d.tsAvailable();
}

template <typename T>
auto touchGetDataImpl(T &d, uint16_t *x, uint16_t *y, int) -> decltype(d.touchscreen.getData(x, y), uint8_t())
{
    return d.touchscreen.getData(x, y);
}
template <typename T> uint8_t touchGetDataImpl(T &d, uint16_t *x, uint16_t *y, long)
{
    return d.tsGetData(x, y);
}

// ---- what the sketch calls
template <typename T> inline void setFrontlightPower(T &d, bool on) { frontlightPower(d, on, 0); }
template <typename T> inline void setFrontlightLevel(T &d, uint8_t v) { frontlightLevel(d, v, 0); }
template <typename T> inline bool touchBegin(T &d) { return touchInitImpl(d, 0); }
template <typename T> inline bool touchAvailable(T &d) { return touchAvailableImpl(d, 0); }
template <typename T> inline uint8_t touchRead(T &d, uint16_t *x, uint16_t *y) { return touchGetDataImpl(d, x, y, 0); }
