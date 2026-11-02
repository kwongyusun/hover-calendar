# Hover Calendar

A calendar that sits as a small date tab on your screen, above all other windows.
Hover over the tab and the calendar slides out. Move your mouse away and it tucks back in.

## Run it on Windows

1. Download `HoverCalendar-Windows.zip`, right-click it and choose **Extract All...**
2. Move the extracted `Hover Calendar` folder somewhere permanent (e.g. Documents), open it and double-click `Hover Calendar.exe`. Windows SmartScreen may say "Windows protected your PC" because the app isn't signed:
   click **More info**, then **Run anyway**.
3. A small date tab appears on the right edge of your screen. Hover over the date to open it.
   Drag the dotted strip at the top of the tab to move it anywhere.

Your events are saved in `%APPDATA%\Hover Calendar\calendar-data.json` (back this file up if you like).

## Using it

- **Hover** the tab to open, move away to hide. **📌** (or `Ctrl+Alt+C`) keeps it open. **Esc** hides it.
- **New event:** `+ New event`, or click / click-and-drag on an empty part of the week grid,
  or double-click a day in the month view.
- **Repeat:** daily, every weekday, weekly on chosen days (every N weeks), monthly, yearly, with an optional end date.
  Editing or deleting a repeating event asks: only this one, this and following, or the whole series.
- **Colours:** 🏷 manages categories (name + colour). Click a category chip under the toolbar to hide/show it.
- **Week view** shows each day's time blocks. **Month view** places each event by time of day inside the day box (morning at the top, evening at the bottom). Click a date number to jump to that week.
- **🎨 Themes:** 45 colour themes, dark and light. Your category colours stay unless you choose to recolour them.
- **⚙ Settings:** week start (Mon/Sun), 12/24-hour time, hours shown in the month view, start with Windows, move the tab back to the edge, quit.
- The tray icon (bottom-right of the taskbar) has pin, move tab back to the edge, start with Windows, and quit.
- Keys when open: ← → previous/next, `t` today, `w` week, `m` month, `n` new event.

## Develop

```
npm install
npm start            # run from source
./build-win.sh       # build the Windows portable .exe (from Linux needs wine; on Windows: npx electron-builder --win portable)
```
