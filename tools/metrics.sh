#!/bin/bash
# metrics.sh - Métricas del host

# ========================
# FUNCIONES AUXILIARES
# ========================
round() { printf "%.0f" "$1"; }

# ========================
# HOSTNAME desde environment
# ========================
HOSTNAME="${HOSTNAME:-$(hostname)}"

# ========================
# DOCKME VERSION
# ========================
VERSION="unknown"
if [ -f /tools/version.json ]; then
  VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tools/version.json)
fi

# ========================
# CPU USAGE INSTANTÁNEO (modo rápido)
# ========================
read_cpu() {
  local cpu=($(grep '^cpu ' /proc/stat))
  local total=0
  local idle=${cpu[4]}
  for i in "${cpu[@]:1}"; do total=$((total + i)); done
  echo "$total $idle"
}

# Modo rápido: 2 muestras con 0.5s entre ellas = 1s total
cpu1=($(read_cpu))
sleep 0.5
cpu2=($(read_cpu))

total_delta=$((cpu2[0]-cpu1[0]))
idle_delta=$((cpu2[1]-cpu1[1]))

if [ "$total_delta" -gt 0 ]; then
  cpu_avg=$((100*(total_delta - idle_delta)/total_delta))
else
  cpu_avg=0
fi
cpu_avg=$(round "$cpu_avg")

# ========================
# MEMORIA REAL (%) estilo TrueNAS / ZFS-aware
# ========================
# Memoria total (kB)
mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
# Memoria disponible real (kB) – kernel moderno
mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
# ZFS ARC (kB) si existe
if [ -f /proc/spl/kstat/zfs/arcstats ]; then
    zfs_arc_bytes=$(awk '/^size/ {print $3}' /proc/spl/kstat/zfs/arcstats)
    zfs_arc_kb=$(( zfs_arc_bytes / 1024 ))
else
    zfs_arc_kb=0
fi
# Memoria usada real:
# - En sistemas sin ZFS: total - MemAvailable
# - En sistemas con ZFS: total - MemAvailable - ARC
mem_used=$(( mem_total - mem_available - zfs_arc_kb ))
# Evitar negativos por seguridad
if [ "$mem_used" -lt 0 ]; then
    mem_used=0
fi
# Porcentaje
mem_usage=$(( mem_used * 100 / mem_total ))
mem_usage=$(round "$mem_usage")

# ========================
# TEMPERATURAS
# ========================
# CPU coretemp
temp_sum=0
temp_count=0
cpu_hwmon=""
for hw in /sys/class/hwmon/hwmon*; do
  if [ -f "$hw/name" ]; then
    name=$(cat "$hw/name")
    if [[ "$name" == *coretemp* ]]; then
      cpu_hwmon="$hw"
      break
    fi
  fi
done

if [ -n "$cpu_hwmon" ]; then
  for f in "$cpu_hwmon"/temp*_input; do
    if [ -f "$f" ]; then
      val=$(cat "$f")
      if [[ "$val" -gt 0 ]]; then
        temp_sum=$((temp_sum + val))
        temp_count=$((temp_count + 1))
      fi
    fi
  done
  if [ "$temp_count" -gt 0 ]; then
    temp_cpu=$((temp_sum / temp_count / 1000))
  else
    temp_cpu=null
  fi
else
  temp_cpu=null
fi

# Board / placa
hwmon0="/sys/class/hwmon/hwmon0/temp1_input"
if [ -f "$hwmon0" ]; then
  temp_board=$(( $(cat "$hwmon0") / 1000 ))
else
  temp_board=null
fi

# ========================
# DOCKER CONTAINERS
# ========================
if command -v docker &> /dev/null; then
  docker_running=$(docker ps --filter "status=running" --format "{{.ID}}" 2>/dev/null | wc -l)
  docker_stopped=$(docker ps -a --filter "status=exited" --format "{{.ID}}" 2>/dev/null | wc -l)
else
  docker_running=0
  docker_stopped=0
fi

# ========================
# UPTIME, TIMESTAMP
# ========================
uptime_seconds=$(awk '{print int($1)}' /proc/uptime)
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ========================
# JSON FINAL
# ========================
json=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "version": "$VERSION",
  "timestamp": "$timestamp",
  "uptime_seconds": $uptime_seconds,
  "cpu": $cpu_avg,
  "memory": $mem_usage,
  "temp_cpu": ${temp_cpu},
  "temp_board": ${temp_board},
  "docker_running": $docker_running,
  "docker_stopped": $docker_stopped
}
EOF
)

# Imprimir a stdout (sin escribir a disco)
echo "$json"