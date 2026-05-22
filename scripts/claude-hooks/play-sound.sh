#!/usr/bin/env bash
# Воспроизводит звук уведомления Claude Code с градуированным fallback.
# Аргумент: stop | notify
#   stop   — один короткий звук (по завершении задачи)
#   notify — три звука / привлекающий внимание (нужно подтверждение)
#
# Порядок попыток:
#   1. paplay — Linux PulseAudio (работает в WSLg, если установлен pulseaudio-utils)
#   2. powershell.exe — Windows-звук через WSL Interop (если включён)
#   3. printf '\a' >&2 — терминальный bell (fallback)

set -u
mode="${1:-stop}"

# Громкость 0..65536 (65536 = 100%). Переопределяется через env CLAUDE_SOUND_VOLUME.
VOLUME="${CLAUDE_SOUND_VOLUME:-49152}"

LINUX_STOP="/usr/share/sounds/freedesktop/stereo/complete.oga"
LINUX_NOTIFY="/usr/share/sounds/freedesktop/stereo/message.oga"
WIN_STOP='C:\Windows\Media\Windows Ding.wav'
WIN_NOTIFY='C:\Windows\Media\Windows Notify.wav'
PWSH="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

play_paplay() {
  command -v paplay >/dev/null 2>&1 || return 1
  case "$mode" in
    stop)   paplay --volume="$VOLUME" "$LINUX_STOP"   2>/dev/null ;;
    notify) paplay --volume="$VOLUME" "$LINUX_NOTIFY" 2>/dev/null ;;
  esac
}

play_powershell() {
  [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || return 1
  [ -x "$PWSH" ] || return 1
  local wav
  case "$mode" in
    stop)   wav="$WIN_STOP" ;;
    notify) wav="$WIN_NOTIFY" ;;
  esac
  "$PWSH" -NoProfile -Command "(New-Object Media.SoundPlayer '$wav').PlaySync()" 2>/dev/null
}

play_bell() {
  case "$mode" in
    stop)
      printf '\a' >&2
      ;;
    notify)
      for _ in 1 2 3; do
        printf '\a' >&2
        sleep 0.25
      done
      ;;
  esac
}

play_paplay || play_powershell || play_bell
exit 0
