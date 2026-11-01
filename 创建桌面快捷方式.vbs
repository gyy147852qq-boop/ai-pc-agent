' ============================================================
'  Create a Desktop shortcut for AI PC Agent
'  Just double-click this file once.
'
'  Why a script instead of a ready-made .lnk:
'  Windows 11 requires the .lnk to carry a target IDList (with volume
'  GUID and timestamps). Hand-built ones end up unopenable, so this
'  calls the system Shell API instead -- guaranteed valid, with the
'  custom icon and the console-less launcher already wired up.
' ============================================================
Option Explicit

Dim sh, fso, base, desk, appName, lnkPath, iconPath, launchPath, sc

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
desk = sh.SpecialFolders("Desktop")

' "AI " + 电脑代理  (built with ChrW so the file stays pure ASCII)
appName = "AI " & ChrW(30005) & ChrW(33041) & ChrW(20195) & ChrW(29702)
lnkPath = fso.BuildPath(desk, appName & ".lnk")
iconPath = fso.BuildPath(base, "assets\icon.ico")
launchPath = fso.BuildPath(base, "launch.vbs")

If Not fso.FileExists(launchPath) Then
  MsgBox "launch.vbs not found:" & vbCrLf & launchPath, 16, "AI PC Agent"
  WScript.Quit 1
End If

If Not fso.FileExists(iconPath) Then
  sh.Run "cmd /c node """ & fso.BuildPath(base, "tools\make-icon.js") & """", 0, True
End If

Set sc = sh.CreateShortcut(lnkPath)
sc.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
sc.Arguments = """" & launchPath & """"
sc.WorkingDirectory = base
sc.IconLocation = iconPath & ",0"
' tooltip: AI 电脑代理 - 让网页 AI 帮你操作电脑
sc.Description = appName & " - " & ChrW(35753) & ChrW(32593) & ChrW(39029) & " AI " & _
                 ChrW(24110) & ChrW(20320) & ChrW(25805) & ChrW(20316) & ChrW(30005) & ChrW(33041)
sc.WindowStyle = 1
sc.Save

If fso.FileExists(lnkPath) Then
  MsgBox "Done. Shortcut created on your Desktop:" & vbCrLf & vbCrLf & lnkPath & vbCrLf & vbCrLf & _
         "Double-click it to start AI PC Agent.", 64, "AI PC Agent"
Else
  MsgBox "Failed to create the shortcut.", 16, "AI PC Agent"
End If
