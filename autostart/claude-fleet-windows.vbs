' Windows: starts Claude Fleet without a console window (set up as a shortcut by "fleet setup").
' Usage: wscript claude-fleet-windows.vbs ["C:\path\node.exe"] [--no-open]
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
nodeExe = "node"
rest = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If i = 0 And LCase(Right(a, 4)) = ".exe" Then
    If fso.FileExists(a) Then nodeExe = """" & a & """"
  Else
    rest = rest & " " & a
  End If
Next
sh.Run nodeExe & " """ & dir & "\dist\fleet.cjs"" start" & rest, 0, False
