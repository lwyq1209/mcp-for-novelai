// The update helper of macOS and Linux: a fixed /bin/sh script that the app writes into the update's state folder and
// starts detached right before it quits (updater.ts). Every value reaches it as a separate argument ("$1" … quoted
// everywhere, never evaluated); the app checks them first (install-posix.ts). It uses only system tools (sh, mv, rm,
// sleep, kill, date, and on macOS open and xattr), nothing inside either app.
//
//   sh helper.sh <platform> <state> <pid> <target> <staging> <from> <to> <launcher> <background> [<exitTimeout> <confirmTimeout>]
//
// platform    darwin | linux
// state       the update's state folder in the data root (<data root>/updates/<id>): helper.log, helper-state (one word per
//             line, appended), launch.env (macOS: NAME=value lines handed to `open --env`), and the new app's started
//             (its pid) and confirmed files (startup.ts)
// pid         the app that is quitting
// target      the app to replace: macOS the .app bundle, Linux the extracted folder; it keeps this path
// staging     <parent of target>/.mcp-for-novelai-update-<random>: new/<name of target> is the checked new app, old/ will
//             hold the old one until the new one confirmed its start
// launcher    /usr/bin/open (macOS), the executable's file name in the folder (Linux), or — tests of this script only —
//             an absolute path of a stand-in that is run as <launcher> <app> <argument>
// background  1: open -g (the rehearsal's test apps start without coming to the front); 0 otherwise
//
// Steps: wait for the app to exit (at most exitTimeout s, default 300: else nothing changes); rename target → old;
// rename new → target (else old goes back); remove a quarantine mark from the new app (macOS); start it with
// --updated-from=<from>; wait for its confirmed file (at most confirmTimeout s, default 120). Confirmed: remove the
// staging folder (the old app). Not confirmed: if the new app is still running (its started pid alive), leave it — it
// removes the old app itself once it confirms; otherwise, or when it could not be started, put the old app back and
// start it with --update-rolled-back=<to>. Any failure of a step undoes the steps before it.
export const POSIX_HELPER_SCRIPT = String.raw`#!/bin/sh
# MCP for NovelAI update helper (macOS, Linux). Written and started by the app; see electron/update/helper-posix.ts.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

platform=$1; state=$2; pid=$3; target=$4; staging=$5; from=$6; to=$7; launcher=$8; background=$9
shift 9
exit_timeout=${"${"}1:-300}; confirm_timeout=${"${"}2:-120}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$state/helper.log" 2>/dev/null; }
mark() { printf '%s\n' "$1" >> "$state/helper-state" 2>/dev/null; log "state $1"; }

case "$platform" in darwin|linux) ;; *) exit 2 ;; esac
case "$pid" in ''|*[!0-9]*) exit 2 ;; esac
case "$exit_timeout$confirm_timeout" in *[!0-9]*) exit 2 ;; esac
case "$staging" in */.mcp-for-novelai-update-*) ;; *) log "refused: staging folder name"; mark "aborted:arguments"; exit 2 ;; esac
[ -d "$state" ] || exit 2
if [ "$(dirname "$staging")" != "$(dirname "$target")" ]; then log "refused: staging is not next to the app"; mark "aborted:arguments"; exit 2; fi
name=$(basename "$target")
new="$staging/new/$name"
old="$staging/old"
failed="$staging/failed"

log "helper started for $from -> $to (pid $pid)"
mark waiting

# 1. The app quits on its own; it is never killed.
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge $((exit_timeout * 5)) ]; then log "the app did not quit"; mark "aborted:app_running"; exit 1; fi
  sleep 0.2
  waited=$((waited + 1))
done
log "the app has quit"
# The app withdraws an update it could not hand over by removing the state folder (and pending.json).
if [ ! -f "$state/helper-state" ] || [ ! -f "$(dirname "$state")/pending.json" ]; then exit 1; fi

# launch.args: extra arguments of the started app, one per line (rehearsal builds only: the test switches of the run).
launch() {
  # $1 the app (bundle or folder), $2 the argument for it
  l_app=$1; l_arg=$2
  case "$launcher" in
    /usr/bin/open)
      set -- -n
      [ "$background" = 1 ] && set -- "$@" -g
      set -- "$@" -a "$l_app"
      if [ -f "$state/launch.env" ]; then
        while IFS= read -r l_line || [ -n "$l_line" ]; do
          [ -n "$l_line" ] && set -- "$@" --env "$l_line"
        done < "$state/launch.env"
      fi
      set -- "$@" --args "$l_arg"
      if [ -f "$state/launch.args" ]; then
        while IFS= read -r l_line || [ -n "$l_line" ]; do
          [ -n "$l_line" ] && set -- "$@" "$l_line"
        done < "$state/launch.args"
      fi
      /usr/bin/open "$@" >> "$state/helper.log" 2>&1
      ;;
    /*)
      "$launcher" "$l_app" "$l_arg" >> "$state/helper.log" 2>&1
      ;;
    *)
      [ -x "$l_app/$launcher" ] || return 1
      set -- "$l_arg"
      if [ -f "$state/launch.args" ]; then
        while IFS= read -r l_line || [ -n "$l_line" ]; do
          [ -n "$l_line" ] && set -- "$@" "$l_line"
        done < "$state/launch.args"
      fi
      if command -v setsid >/dev/null 2>&1; then
        ( cd "$l_app" && exec setsid "./$launcher" "$@" < /dev/null > /dev/null 2>&1 ) &
      else
        ( cd "$l_app" && exec nohup "./$launcher" "$@" < /dev/null > /dev/null 2>&1 ) &
      fi
      ;;
  esac
}

restore_old() {
  # Puts the old app back at the target path (the new one, if it is there, goes to failed/).
  if [ -e "$old" ]; then
    if [ -e "$target" ]; then mv "$target" "$failed" || return 1; fi
    mv "$old" "$target" || return 1
  fi
  return 0
}

roll_back() {
  mark "rolling_back:$1"
  if restore_old; then
    mark "rolled_back:$1"
    launch "$target" "--update-rolled-back=$to" || log "the old app could not be started"
    rm -rf "$staging"
  else
    mark "rollback_failed:$1"
    log "rollback failed: the old app is in $old"
  fi
  exit 1
}

# 2. The swap: two renames in the same folder.
if [ ! -d "$target" ] || [ ! -d "$new" ] || [ -e "$old" ]; then log "the app or the new version is missing"; mark "aborted:missing"; exit 1; fi
if ! mv "$target" "$old"; then log "the app could not be moved aside (permissions?)"; mark "aborted:not_movable"; launch "$target" "--update-rolled-back=$to"; rm -rf "$staging"; exit 1; fi
if ! mv "$new" "$target"; then log "the new app could not be moved into place"; roll_back move_failed; fi
mark swapped
if [ "$platform" = darwin ]; then xattr -dr com.apple.quarantine "$target" 2>/dev/null; fi

# 3. The new app starts and confirms.
if ! launch "$target" "--updated-from=$from"; then log "the new app could not be started"; roll_back launch_failed; fi
mark launched
waited=0
while [ "$waited" -lt $((confirm_timeout * 2)) ]; do
  if [ -f "$state/confirmed" ]; then
    mark confirmed
    rm -rf "$staging"
    mark done
    exit 0
  fi
  if [ -f "$state/started" ]; then
    started=$(cat "$state/started" 2>/dev/null)
    case "$started" in ''|*[!0-9]*) ;; *) if ! kill -0 "$started" 2>/dev/null && [ ! -f "$state/confirmed" ]; then roll_back new_app_exited; fi ;; esac
  fi
  sleep 0.5
  waited=$((waited + 1))
done
started=$(cat "$state/started" 2>/dev/null)
case "$started" in
  ''|*[!0-9]*) roll_back not_started ;;
  *) if kill -0 "$started" 2>/dev/null; then mark "slow"; log "the new app is still starting; it removes the old version itself once it confirms"; exit 0; fi
     [ -f "$state/confirmed" ] && { mark confirmed; rm -rf "$staging"; mark done; exit 0; }
     roll_back new_app_exited ;;
esac
`;
