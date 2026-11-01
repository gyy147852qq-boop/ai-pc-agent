Option Explicit
' AI PC Agent - silent launcher
' Starts start.bat with no console window, then waits for the local panel to answer.
' Closing the app is done from the panel's "Quit" button.

Dim sh, fso, base, bat, port, url, i, up

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
bat = base & "\start.bat"

If Not fso.FileExists(bat) Then
  MsgBox "start.bat not found:" & vbCrLf & bat, 16, "AI PC Agent"
  WScript.Quit 1
End If

port = ReadPort(base)
url = "http://127.0.0.1:" & port & "/"

' If already running, server.js will hit EADDRINUSE and just reopen the panel window.
sh.CurrentDirectory = base
sh.Run """" & bat & """", 0, False

up = False
For i = 1 To 40
  WScript.Sleep 500
  If UrlOk(url) Then
    up = True
    Exit For
  End If
Next

If Not up Then
  MsgBox "Failed to start." & vbCrLf & vbCrLf & _
         "Possible reasons:" & vbCrLf & _
         "  1. Node.js 22+ is not installed  (https://nodejs.org)" & vbCrLf & _
         "  2. Port " & port & " is taken by another program" & vbCrLf & vbCrLf & _
         "Log: " & base & "\data\server.log", 48, "AI PC Agent"
End If

Function ReadPort(b)
  Dim f, s, re, m
  ReadPort = 8787
  On Error Resume Next
  If Not fso.FileExists(b & "\data\config.json") Then Exit Function
  Set f = fso.OpenTextFile(b & "\data\config.json", 1)
  s = f.ReadAll
  f.Close
  Set re = New RegExp
  re.Pattern = """port""\s*:\s*(\d+)"
  re.IgnoreCase = True
  Set m = re.Execute(s)
  If m.Count > 0 Then ReadPort = CLng(m(0).SubMatches(0))
  On Error GoTo 0
End Function

Function UrlOk(u)
  Dim h
  UrlOk = False
  On Error Resume Next
  Err.Clear
  Set h = CreateObject("MSXML2.XMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set h = CreateObject("MSXML2.XMLHTTP")
  End If
  Err.Clear
  h.Open "GET", u, False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then UrlOk = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
