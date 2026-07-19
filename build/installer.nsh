!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifdef BUILD_UNINSTALLER
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.appendApplicationDirectory

  Function un.appendApplicationDirectory
  FunctionEnd
!else
  Var installDirectoryWasCompleted

  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE appendApplicationDirectory

  Function appendApplicationDirectory
    StrCpy $installDirectoryWasCompleted "0"
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5

    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1019
    ${If} $1 != 0
      ${NSD_GetText} $1 $2
      StrCpy $4 $2

      ; Ignore a trailing separator when checking the final directory name,
      ; except for drive roots such as D:\.
      StrCpy $3 $4 1 -1
      ${If} $3 == "\"
        StrLen $5 $4
        ${If} $5 > 3
          StrCpy $4 $4 -1
        ${EndIf}
      ${EndIf}

      ${GetFileName} "$4" $3
      ${If} $3 != "${APP_FILENAME}"
        StrCpy $3 $4 1 -1
        ${If} $3 == "\"
          StrCpy $4 "$4${APP_FILENAME}"
        ${Else}
          StrCpy $4 "$4\${APP_FILENAME}"
        ${EndIf}
        StrCpy $installDirectoryWasCompleted "1"
      ${EndIf}

      ${NSD_SetText} $1 "$4"
    ${EndIf}

    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0

    ; Keep the directory page visible once so the completed path is explicit.
    ${If} $installDirectoryWasCompleted == "1"
      Abort
    ${EndIf}
  FunctionEnd
!endif
