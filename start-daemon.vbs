' Antigravity Chrome Bridge Silent Background Daemon
' Starts node server.js with zero console window
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = strPath
WshShell.Run "node server.js", 0, False
