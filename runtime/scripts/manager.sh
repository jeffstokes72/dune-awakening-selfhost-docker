#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

pause() {
  echo
  read -r -p "Press Enter to return to menu..."
}

run_cmd() {
  echo
  echo ">>> $*"
  echo
  "$@"
}

follow_logs() {
  local target="$1"
  echo
  echo "Following logs for: $target"
  echo "Press Ctrl+C to stop following logs and return to the shell."
  echo
  runtime/scripts/dune logs "$target"
}

while true; do
  clear || true

  echo "Dune Awakening Self-Host Docker Manager"
  echo "======================================="
  echo

  if command -v docker >/dev/null 2>&1; then
    echo "Containers:"
    docker ps --filter "name=dune-" --format "  {{.Names}} - {{.Status}}" || true
  fi

  echo
  echo "Setup:"
  echo "  a. init                         First-time setup"
  echo
  echo "Stack:"
  echo "  1. status                       Full status"
  echo "  2. ready                        Readiness check"
  echo "  3. ports                        Show ports/listeners"
  echo "  4. start                        Start stack"
  echo "  5. stop                         Stop stack"
  echo "  6. update                       Update server files/images/db"
  echo
  echo "Restart:"
  echo "  7. restart survival             Restart Survival_1"
  echo "  8. restart overmap              Restart Overmap"
  echo "  9. restart director             Restart Director"
  echo " 10. restart gateway              Restart ServerGateway"
  echo " 11. restart text-router          Restart TextRouter"
  echo
  echo "Logs:"
  echo " 12. logs survival                Follow Survival_1 logs"
  echo " 13. logs overmap                 Follow Overmap logs"
  echo " 14. logs director                Follow Director logs"
  echo " 15. logs gateway                 Follow ServerGateway logs"
  echo " 16. logs text-router             Follow TextRouter logs"
  echo " 17. logs rmq-game                Follow game RabbitMQ logs"
  echo
  echo "Shell:"
  echo " 18. shell orchestrator           Open shell in orchestrator container"
  echo
  echo "  q. quit"
  echo

  read -r -p "Select an option: " choice

  case "$choice" in
    a|A)
      run_cmd runtime/scripts/dune init
      pause
      ;;

    1)
      run_cmd runtime/scripts/dune status
      pause
      ;;

    2)
      run_cmd runtime/scripts/dune ready
      pause
      ;;

    3)
      run_cmd runtime/scripts/dune ports
      pause
      ;;

    4)
      run_cmd runtime/scripts/dune start
      pause
      ;;

    5)
      run_cmd runtime/scripts/dune stop
      pause
      ;;

    6)
      run_cmd runtime/scripts/dune update
      pause
      ;;

    7)
      run_cmd runtime/scripts/dune restart survival
      pause
      ;;

    8)
      run_cmd runtime/scripts/dune restart overmap
      pause
      ;;

    9)
      run_cmd runtime/scripts/dune restart director
      pause
      ;;

    10)
      run_cmd runtime/scripts/dune restart gateway
      pause
      ;;

    11)
      run_cmd runtime/scripts/dune restart text-router
      pause
      ;;

    12)
      follow_logs survival
      pause
      ;;

    13)
      follow_logs overmap
      pause
      ;;

    14)
      follow_logs director
      pause
      ;;

    15)
      follow_logs gateway
      pause
      ;;

    16)
      follow_logs text-router
      pause
      ;;

    17)
      follow_logs rmq-game
      pause
      ;;

    18)
      run_cmd docker compose exec orchestrator bash
      pause
      ;;

    q|Q|quit|exit)
      echo "Bye."
      exit 0
      ;;

    *)
      echo "Invalid selection."
      sleep 1
      ;;
  esac
done
