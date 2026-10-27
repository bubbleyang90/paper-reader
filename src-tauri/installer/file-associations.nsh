; Windows associations are candidates, not a takeover of the user's defaults.
; Do not use Tauri's APP_ASSOCIATE/APP_UNASSOCIATE: they overwrite .ext defaults.
; This installer is currentUser-only. Never write Explorer\FileExts\UserChoice.
!define PAPER_PROGID "studio.paper.reader.Markdown"
!define PAPER_CAPABILITIES "Software\studio.paper.reader\Capabilities"

!macro PaperRegisterExtension EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PAPER_PROGID}" ""
  WriteRegStr HKCU "${PAPER_CAPABILITIES}\FileAssociations" ".${EXT}" "${PAPER_PROGID}"
!macroend

!macro PaperUnregisterExtension EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PAPER_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\${PAPER_PROGID}" "" "Markdown document"
  WriteRegStr HKCU "Software\Classes\${PAPER_PROGID}\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\${PAPER_PROGID}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\${PAPER_PROGID}\Application" "ApplicationName" "Paper"
  WriteRegStr HKCU "${PAPER_CAPABILITIES}" "ApplicationName" "Paper"
  WriteRegStr HKCU "${PAPER_CAPABILITIES}" "ApplicationDescription" "A lightweight Markdown reader"
  WriteRegStr HKCU "${PAPER_CAPABILITIES}" "ApplicationIcon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  !insertmacro PaperRegisterExtension "md"
  !insertmacro PaperRegisterExtension "markdown"
  !insertmacro PaperRegisterExtension "mdown"
  WriteRegStr HKCU "Software\RegisteredApplications" "Paper" "${PAPER_CAPABILITIES}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An older uninstaller must not remove a newer installation's registration.
  ReadRegStr $R0 HKCU "Software\Classes\${PAPER_PROGID}\shell\open\command" ""
  ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    !insertmacro PaperUnregisterExtension "md"
    !insertmacro PaperUnregisterExtension "markdown"
    !insertmacro PaperUnregisterExtension "mdown"
    DeleteRegKey HKCU "Software\Classes\${PAPER_PROGID}"
    ReadRegStr $R0 HKCU "Software\RegisteredApplications" "Paper"
    ${If} $R0 == "${PAPER_CAPABILITIES}"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Paper"
    ${EndIf}
    DeleteRegKey HKCU "${PAPER_CAPABILITIES}"
    DeleteRegKey /ifempty HKCU "Software\studio.paper.reader"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
