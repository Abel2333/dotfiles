#!/usr/bin/env python3
import re
import sys
import os

if len(sys.argv) < 2:
    print("用法: python extract.py input.txt")
    sys.exit(1)

text = open(sys.argv[1], encoding="utf-8").read()

# 匹配下载链接：包括源码包和补丁
urls = re.findall(r"https?://\S+\.(?:tar\.(?:gz|xz|bz2)|patch)", text)

# 匹配 MD5
md5s = re.findall(r"\b[0-9a-f]{32}\b", text)

# 写下载列表
with open("lfs-sources.list", "w") as f:
    f.write("\n".join(urls) + "\n")

# 写校验文件
with open("lfs-checksums.md5", "w") as f:
    for url, md5 in zip(urls, md5s):
        filename = os.path.basename(url)
        f.write(f"{md5}  {filename}\n")
