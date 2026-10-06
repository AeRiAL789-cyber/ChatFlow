' Launches the WhatsApp export listener with no visible console window.
' Called by the "WhatsApp Export" logon task.
Dim sh, base
Set sh = CreateObject("WScript.Shell")
base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = base
sh.Run """" & base & "service-run.cmd""", 0, False
