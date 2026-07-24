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
  ; uninstalled. Copy and verify the settings after the application exits.
  ; Renaming the whole data directory can silently fail while Windows is still
  ; releasing a file handle after shutdown.
  IfFileExists "$INSTDIR\data\settings.json" 0 preserveDataAfterCloseDone
  RMDir /r "$INSTDIR.__update-data-new"
  CreateDirectory "$INSTDIR.__update-data-new"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\data\settings.json" "$INSTDIR.__update-data-new\settings.json"
  IfErrors preserveDataFailed
  IfFileExists "$INSTDIR.__update-data-new\settings.json" 0 preserveDataFailed
  IfFileExists "$INSTDIR\data\settings.json.bak" 0 preserveDataReady
  CopyFiles /SILENT "$INSTDIR\data\settings.json.bak" "$INSTDIR.__update-data-new\settings.json.bak"
  preserveDataReady:
  RMDir /r "$INSTDIR.__update-data"
  Rename "$INSTDIR.__update-data-new" "$INSTDIR.__update-data"
  IfFileExists "$INSTDIR.__update-data\settings.json" preserveDataAfterCloseDone 0
  preserveDataFailed:
  RMDir /r "$INSTDIR.__update-data-new"
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "无法备份应用设置。请稍后重试；在设置成功备份前不会继续安装。" /SD IDCANCEL IDRETRY checkInvoiceManagerRunning
  Quit
  preserveDataAfterCloseDone:
!macroend

!ifndef BUILD_UNINSTALLER
  Var customInstallDirectoryInput
  Var customInstallBrowseButton

  !macro customInstall
    IfFileExists "$INSTDIR.__update-data\settings.json" 0 restoreDataDone
    CreateDirectory "$INSTDIR\data"
    CopyFiles /SILENT "$INSTDIR.__update-data\settings.json" "$INSTDIR\data\settings.json"
    IfFileExists "$INSTDIR.__update-data\settings.json.bak" 0 verifyRestoredData
    CopyFiles /SILENT "$INSTDIR.__update-data\settings.json.bak" "$INSTDIR\data\settings.json.bak"
    verifyRestoredData:
    IfFileExists "$INSTDIR\data\settings.json" restoreDataSucceeded 0
    MessageBox MB_ICONSTOP|MB_OK "应用已安装，但设置恢复失败。备份仍保留在 $INSTDIR.__update-data。"
    Goto restoreDataDone
    restoreDataSucceeded:
    RMDir /r "$INSTDIR.__update-data"
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
