!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
!include "nsProcess.nsh"

!macro customCheckAppRunning
  checkInvoiceManagerRunning:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "发票整理助手正在运行。请先关闭应用，然后单击“重试”继续安装。" /SD IDCANCEL IDRETRY checkInvoiceManagerRunning
      ${nsProcess::Unload}
      Quit
  ${EndIf}
  ${nsProcess::Unload}

  ; CHECK_APP_RUNNING is invoked immediately before the previous version is
  ; uninstalled. Preserve user data here, only after the old application has
  ; actually exited. Doing this in customInit is too early: that hook runs as
  ; soon as Setup opens, before the close-app prompt is shown.
  IfFileExists "$INSTDIR\data\settings.json" 0 preserveDataAfterCloseDone
  RMDir /r "$INSTDIR.__update-data"
  Rename "$INSTDIR\data" "$INSTDIR.__update-data"
  preserveDataAfterCloseDone:
!macroend

!ifndef BUILD_UNINSTALLER
  Var customInstallDirectoryInput
  Var customInstallBrowseButton

  !macro customInstall
    IfFileExists "$INSTDIR.__update-data\settings.json" 0 restoreDataDone
    ; Never delete the newly-created data directory before the preserved data
    ; has been restored successfully. Keep it aside so a failed Rename can be
    ; rolled back instead of starting the application with empty settings.
    RMDir /r "$INSTDIR.__new-data"
    IfFileExists "$INSTDIR\data\*.*" 0 restorePreservedData
    Rename "$INSTDIR\data" "$INSTDIR.__new-data"
    restorePreservedData:
    Rename "$INSTDIR.__update-data" "$INSTDIR\data"
    IfFileExists "$INSTDIR\data\settings.json" restoreDataSucceeded 0
    IfFileExists "$INSTDIR.__new-data\*.*" 0 restoreDataDone
    Rename "$INSTDIR.__new-data" "$INSTDIR\data"
    Goto restoreDataDone
    restoreDataSucceeded:
    RMDir /r "$INSTDIR.__new-data"
    restoreDataDone:
  !macroend

  !macro customPageAfterChangeDir
    Page custom createInstallDirectoryPage leaveInstallDirectoryPage
  !macroend

  Function createInstallDirectoryPage
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:选择安装位置"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:选择 发票整理助手 要安装的文件夹。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 4u 100% 24u "Setup 将安装 发票整理助手 到下列文件夹。要安装到不同文件夹，请单击 [浏览] 并选择父文件夹。"
    Pop $0
    ${NSD_CreateGroupBox} 0 42u 100% 48u "目标文件夹"
    Pop $0
    ${NSD_CreateText} 10u 60u -94u 13u "$INSTDIR"
    Pop $customInstallDirectoryInput
    ${NSD_CreateBrowseButton} -78u 59u 68u 15u "浏览(B)..."
    Pop $customInstallBrowseButton
    ${NSD_OnClick} $customInstallBrowseButton selectInstallParentDirectory

    nsDialogs::Show
  FunctionEnd

  Function selectInstallParentDirectory
    ${NSD_GetText} $customInstallDirectoryInput $0
    ${GetParent} "$0" $1
    ${If} $1 == ""
      StrCpy $1 "$0"
    ${EndIf}
    nsDialogs::SelectFolderDialog "选择安装位置" "$1"
    Pop $0
    ${If} $0 != error
    ${AndIf} $0 != ""
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrLen $2 $0
        ${If} $2 > 3
          StrCpy $0 $0 -1
        ${EndIf}
      ${EndIf}
      ${GetFileName} "$0" $1
      ${If} $1 != "invoice-manager"
        StrCpy $0 "$0\invoice-manager"
      ${EndIf}
      StrCpy $INSTDIR "$0"
      ${NSD_SetText} $customInstallDirectoryInput "$INSTDIR"
    ${EndIf}
  FunctionEnd

  Function leaveInstallDirectoryPage
    ${NSD_GetText} $customInstallDirectoryInput $INSTDIR
    ${If} $INSTDIR == ""
      MessageBox MB_ICONEXCLAMATION "请选择安装位置。"
      Abort
    ${EndIf}
  FunctionEnd
!endif
