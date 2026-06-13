#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="RedBlink Dune Docker Console"
WEB_COMPOSE="docker-compose.web.yml"
WEB_SERVICE="redblink-dune-docker-console"
WEB_PORT="${ADMIN_BIND_PORT:-8088}"
DOCKER=(docker)
DOCKER_GROUP_UPDATED=0

say() {
  printf '\n%s\n' "$1"
}

step() {
  printf '\n==> %s\n' "$1"
}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This installer needs administrator access for this step, but sudo was not found."
    echo "Please run this installer as root or install sudo, then start it again."
    exit 1
  fi
}

is_linux() {
  [ "$(uname -s 2>/dev/null || true)" = "Linux" ]
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

install_basic_tools() {
  if command -v apt-get >/dev/null 2>&1; then
    need_sudo apt-get update
    need_sudo apt-get install -y ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    need_sudo dnf install -y ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    need_sudo yum install -y ca-certificates curl
  elif command -v zypper >/dev/null 2>&1; then
    need_sudo zypper --non-interactive install ca-certificates curl
  elif command -v pacman >/dev/null 2>&1; then
    need_sudo pacman -Sy --noconfirm ca-certificates curl
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  step "Docker is missing. Installing Docker now."
  install_basic_tools

  if ! command -v curl >/dev/null 2>&1; then
    echo "Docker is missing and curl is not available, so the installer cannot continue automatically."
    echo "Install Docker Engine or Docker Desktop, then run this installer again."
    exit 1
  fi

  curl -fsSL https://get.docker.com | need_sudo sh
}

select_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    return 0
  fi
  if [ "$(id -u)" -eq 0 ] && docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  return 1
}

start_docker() {
  if select_docker_command; then
    return
  fi

  step "Docker is installed but is not running yet. Starting Docker now."

  if has_systemd; then
    need_sudo systemctl enable --now docker || true
  elif command -v service >/dev/null 2>&1; then
    need_sudo service docker start || true
  fi

  if select_docker_command; then
    return
  fi

  if [ "$(id -u)" -ne 0 ] && getent group docker >/dev/null 2>&1; then
    step "Giving your user access to Docker."
    need_sudo usermod -aG docker "$USER" || true
    if select_docker_command; then
      echo "Your user was added to the docker group. The installer will continue with administrator Docker access for this first launch."
      return
    fi
  fi

  echo "Docker is installed, but this installer still cannot reach the Docker engine."
  echo "If you use Docker Desktop, start Docker Desktop and wait until it says it is running."
  echo "Then run this installer again."
  exit 1
}

ensure_docker_group_access() {
  local target_user
  target_user="${SUDO_USER:-${USER:-}}"
  if [ -z "$target_user" ] || [ "$target_user" = "root" ]; then
    return
  fi
  if ! getent group docker >/dev/null 2>&1; then
    return
  fi
  if id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    return
  fi

  step "Allowing your user to run Docker commands later."
  need_sudo usermod -aG docker "$target_user" || true
  DOCKER_GROUP_UPDATED=1
}

ensure_compose() {
  if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    return
  fi

  step "Docker Compose is missing. Installing the Compose plugin now."

  if command -v apt-get >/dev/null 2>&1; then
    need_sudo apt-get update
    need_sudo apt-get install -y docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    need_sudo dnf install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    need_sudo yum install -y docker-compose-plugin
  else
    echo "Docker Compose is missing and this operating system is not supported for automatic Compose installation."
    echo "Install the Docker Compose v2 plugin or use Docker Desktop, then run this installer again."
    exit 1
  fi

  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    echo "Docker Compose is still not available after installation."
    echo "Restart your shell or Docker Desktop, then run this installer again."
    exit 1
  fi
}

host_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^(127\.|169\.254\.|172\.17\.|172\.18\.|172\.19\.|172\.2[0-9]\.|172\.3[0-1]\.)' | head -n1 || true)"
  fi
  printf '%s' "${ip:-127.0.0.1}"
}

public_ip() {
  local ip=""
  if command -v curl >/dev/null 2>&1; then
    ip="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
    if printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      printf '%s' "$ip"
      return
    fi
  fi
}

start_console() {
  if [ ! -f "$WEB_COMPOSE" ]; then
    echo "The installer cannot find $WEB_COMPOSE."
    echo "Run this installer from the extracted release folder."
    exit 1
  fi

  step "Starting the Web UI."
  "${DOCKER[@]}" compose -f "$WEB_COMPOSE" up -d --build "$WEB_SERVICE"
}

read_admin_password() {
  local password_file="$1"
  local attempt
  for attempt in $(seq 1 20); do
    if [ -s "$password_file" ]; then
      tr -d '\r\n' < "$password_file"
      return
    fi
    if command -v sudo >/dev/null 2>&1 && sudo test -s "$password_file" 2>/dev/null; then
      sudo cat "$password_file" | tr -d '\r\n'
      return
    fi
    sleep 1
  done
}

show_finish() {
  local ip public password_file admin_password
  ip="$(host_ip)"
  public="$(public_ip)"
  password_file="$(pwd)/runtime/secrets/admin-web-password.txt"
  admin_password="$(read_admin_password "$password_file")"

  say "$APP_NAME is ready."
  echo
  echo "Open the Web UI in your browser:"
  if [ -n "$public" ] && [ "$public" != "$ip" ]; then
    echo "  Remote / public access: http://$public:$WEB_PORT"
    echo "  Same network access:    http://$ip:$WEB_PORT"
  else
    echo "  http://$ip:$WEB_PORT"
  fi
  echo
  echo "If you are on the same local network as this server, use the same-network address."
  echo "If you are connecting over the internet, use the public address and make sure TCP $WEB_PORT is allowed by the server firewall or VPS firewall."
  if [ "$DOCKER_GROUP_UPDATED" = "1" ]; then
    echo
    echo "Your user was added to the docker group. After you sign out and back in, Docker commands will work without sudo."
  fi
  echo
  echo "Your first admin password was generated automatically."
  if [ -n "$admin_password" ]; then
    echo "Use this password to sign in:"
    echo "  $admin_password"
  else
    echo "The password was not ready yet. Wait a few seconds and run ./install.sh again to show it."
  fi
  echo
  echo "After signing in, the setup wizard will check the server and finish everything from the browser."
}

say "Starting Dune Docker Console Installer."

if ! is_linux; then
  echo "This automatic installer runs on Linux servers."
  echo "For Docker Desktop on Windows or another VM setup, start Docker Desktop first, then start the Web UI from the extracted release folder."
  exit 1
fi

install_docker
start_docker
ensure_docker_group_access
ensure_compose
start_console
show_finish
