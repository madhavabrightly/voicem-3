; ahk_fallback.ahk — AHK v2 fallback sidecar for P5 application lifecycle
; Tickets 446, 491–494: launch, attach, switch, restore
;
; Protocol: stdin JSON-lines, stdout JSON-lines (no Base64 framing needed —
; this is a simple last-resort path, not the primary driver).
;
; Commands (one per line, JSON):
;   { "cmd": "run_app",      "name": "notepad" }
;   { "cmd": "win_activate", "name": "notepad" }
;   { "cmd": "win_exists",   "name": "notepad" }
;   { "cmd": "win_wait",     "name": "notepad", "timeout": 10000 }
;   { "cmd": "win_close",    "name": "notepad" }
;   { "cmd": "exit" }
;
; Responses: { "ok": true/false, "hwnd": "0x...", "error": "..." }
;
; IMPORTANT: This file is inert unless AutoHotkey v2 is installed and on PATH.
; The Node layer (app_engine_driver.js) auto-detects AHK availability.

#Requires AutoHotkey v2.0
#SingleInstance Off

; Read commands from stdin in a loop
loop {
    line := FileRead("*")
    if (line = "")
        continue

    try {
        obj := Jxon_Load(line)
    } catch {
        FileAppend('{"ok":false,"error":"invalid JSON"}' . "`n", "*")
        continue
    }

    cmd := obj.Has("cmd") ? obj["cmd"] : ""

    switch cmd {
        case "run_app":
            name := obj.Has("name") ? obj["name"] : ""
            try {
                Run(name)
                FileAppend('{"ok":true,"action":"run","name":"' . name . '"}' . "`n", "*")
            } catch as e {
                FileAppend('{"ok":false,"error":"' . StrReplace(e.Message, '"', "'") . '"}' . "`n", "*")
            }

        case "win_activate":
            name := obj.Has("name") ? obj["name"] : ""
            try {
                WinActivate("ahk_exe " . name . ".exe")
                hwnd := WinExist("ahk_exe " . name . ".exe")
                FileAppend('{"ok":true,"hwnd":"0x' . Format("{:X}", hwnd) . '"}' . "`n", "*")
            } catch {
                try {
                    WinActivate(name)
                    hwnd := WinExist(name)
                    FileAppend('{"ok":true,"hwnd":"0x' . Format("{:X}", hwnd) . '"}' . "`n", "*")
                } catch as e {
                    FileAppend('{"ok":false,"error":"' . StrReplace(e.Message, '"', "'") . '"}' . "`n", "*")
                }
            }

        case "win_exists":
            name := obj.Has("name") ? obj["name"] : ""
            hwnd := WinExist("ahk_exe " . name . ".exe")
            if (!hwnd)
                hwnd := WinExist(name)
            if (hwnd)
                FileAppend('{"ok":true,"running":true,"hwnd":"0x' . Format("{:X}", hwnd) . '"}' . "`n", "*")
            else
                FileAppend('{"ok":true,"running":false}' . "`n", "*")

        case "win_wait":
            name    := obj.Has("name")    ? obj["name"]    : ""
            timeout := obj.Has("timeout") ? obj["timeout"] : 10000
            try {
                hwnd := WinWait("ahk_exe " . name . ".exe", , timeout / 1000)
                if (!hwnd) hwnd := WinWait(name, , timeout / 1000)
                FileAppend('{"ok":true,"hwnd":"0x' . Format("{:X}", hwnd) . '"}' . "`n", "*")
            } catch as e {
                FileAppend('{"ok":false,"error":"timeout or not found"}' . "`n", "*")
            }

        case "win_close":
            name := obj.Has("name") ? obj["name"] : ""
            try {
                WinClose("ahk_exe " . name . ".exe")
                FileAppend('{"ok":true,"action":"close"}' . "`n", "*")
            } catch as e {
                FileAppend('{"ok":false,"error":"' . StrReplace(e.Message, '"', "'") . '"}' . "`n", "*")
            }

        case "exit":
            ExitApp()

        default:
            FileAppend('{"ok":false,"error":"unknown command: ' . cmd . '"}' . "`n", "*")
    }
}
