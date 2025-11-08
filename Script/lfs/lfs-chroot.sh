#!/usr/bin/env bash
# Preparing Virtual Kernel File Systems (robust version)

set -euo pipefail

# 确认 $LFS 已定义且存在
if [[ -z "${LFS:-}" ]]; then
  echo "Error: LFS variable is not set."
  exit 1
fi

if [[ ! -d "$LFS" ]]; then
  echo "Error: LFS directory '$LFS' does not exist."
  exit 1
fi

# 创建必要目录
mkdir -pv "$LFS"/{dev,proc,sys,run}

# 条件挂载函数
safe_mount() {
  local src=$1 fstype=$2 target=$3 opts=${4:-}
  if mountpoint -q "$target"; then
    echo "Skipping: $target already mounted"
  else
    if [[ -n "$opts" ]]; then
      mount -v -t "$fstype" -o "$opts" "$src" "$target"
    else
      mount -v -t "$fstype" "$src" "$target"
    fi
  fi
}

# 执行挂载
safe_mount /dev none "$LFS/dev" bind
safe_mount devpts devpts "$LFS/dev/pts" "gid=5,mode=0620"
safe_mount proc proc "$LFS/proc"
safe_mount sysfs sysfs "$LFS/sys"
safe_mount tmpfs tmpfs "$LFS/run"

# /dev/shm 特殊处理
if [ -h "$LFS/dev/shm" ]; then
  install -v -d -m 1777 "$LFS$(realpath /dev/shm)"
else
  safe_mount tmpfs tmpfs "$LFS/dev/shm" "nosuid,nodev"
fi

# 进入 chroot 环境
chroot "$LFS" /usr/bin/env -i \
  HOME=/root \
  TERM="$TERM" \
  PS1='(lfs chroot) \u:\w\$ ' \
  PATH=/usr/bin:/usr/sbin \
  MAKEFLAGS="-j$(nproc)" \
  TESTSUITEFLAGS="-j$(nproc)" \
  /bin/bash --login
