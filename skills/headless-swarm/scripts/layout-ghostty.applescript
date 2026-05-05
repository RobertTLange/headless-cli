on parseStateLine(stateLine)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to tab
  set parts to text items of stateLine
  set AppleScript's text item delimiters to oldDelimiters
  if (count of parts) < 2 then return {"", ""}
  return {item 1 of parts, item 2 of parts}
end parseStateLine

on containsValue(theList, theValue)
  repeat with itemValue in theList
    if (itemValue as text) is theValue then return true
  end repeat
  return false
end containsValue

on appendUnique(theList, theValue)
  if theValue is not "" and theList does not contain theValue then
    set end of theList to theValue
  end if
  return theList
end appendUnique

on run argv
  set workDir to item 1 of argv
  set aggregatorSession to item 2 of argv
  set tmuxPath to item 3 of argv
  set existingState to paragraphs of (item 4 of argv)

  tell application "Ghostty"
    activate
    set cfg to new surface configuration
    set initial working directory of cfg to workDir
    set currentTab to selected tab of front window
    set anchor to focused terminal of currentTab

    set trackedPaneIds to {}
    set panesToClose to {}
    repeat with stateLine in existingState
      set parsedState to my parseStateLine(stateLine as text)
      set trackedKind to item 1 of parsedState
      set trackedValue to item 2 of parsedState
      if (trackedKind is "pane" or trackedKind is "swarm-pane") and trackedValue is not "" then
        set trackedPaneIds to my appendUnique(trackedPaneIds, trackedValue)
      end if
    end repeat

    if my containsValue(trackedPaneIds, id of anchor) or (name of anchor) starts with "headless-" then
      repeat with term in terminals of currentTab
        if not my containsValue(trackedPaneIds, id of term) and (name of term) does not start with "headless-" then
          set anchor to term
          exit repeat
        end if
      end repeat
    end if

    repeat with term in terminals of currentTab
      if id of term is not id of anchor then
        set end of panesToClose to term
      end if
    end repeat

    repeat with term in panesToClose
      close term
    end repeat

    set command of cfg to "/usr/bin/env -u TMUX " & quoted form of tmuxPath & " attach-session -t " & quoted form of aggregatorSession
    set wait after command of cfg to true
    set swarmRoot to split anchor direction right with configuration cfg
    focus anchor

    set outputLines to {}
    set end of outputLines to ("pane" & tab & (id of swarmRoot))
    set oldDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to linefeed
    set outputText to outputLines as text
    set AppleScript's text item delimiters to oldDelimiters
    return outputText
  end tell
end run
