#!/usr/bin/env python3
"""
HuHoBotPenguin 构建脚本：将公共 lib + 版本独有文件合并，生成发布 zip。

用法：
    python build.py              构建两版到 dist/
    python build.py standard     仅构建标准版
    python build.py llama        仅构建 Llama 版
"""

import os
import sys
import shutil
import zipfile

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(REPO_ROOT, 'dist')
VERSION = '1.3.1'

# 各版本的独有文件（相对于 repo root）
VERSIONS = {
    'standard': {
        'src_dir': 'standard',
        'zip_name': 'HuHoBotPenguin-LLSE.zip',
        'plugin_dir': 'HuHoBotPenguin-LLSE',
    },
    'llama': {
        'src_dir': 'llama',
        'zip_name': 'HuHoBotPenguin-LLSE-Llama.zip',
        'plugin_dir': 'HuHoBotPenguin-LLSE-Llama',
    },
}

# 公共目录（构建时复制到每个版本）
COMMON_DIRS = ['addons', 'Markdown']
COMMON_FILES = ['LICENSE']


def build_version(name):
    cfg = VERSIONS[name]
    src_dir = os.path.join(REPO_ROOT, cfg['src_dir'])
    lib_dir = os.path.join(REPO_ROOT, 'lib')
    dest = os.path.join(DIST_DIR, cfg['plugin_dir'])

    # 清理旧构建
    if os.path.exists(dest):
        shutil.rmtree(dest)

    # 复制公共 lib/
    shutil.copytree(lib_dir, os.path.join(dest, 'lib'))

    # 复制版本独有目录（main.js, config.js, commands.js, manifest.json, README.md）
    for item in os.listdir(src_dir):
        s = os.path.join(src_dir, item)
        d = os.path.join(dest, item)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)

    # 复制公共目录和文件
    for d in COMMON_DIRS:
        src = os.path.join(REPO_ROOT, d)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(dest, d))
    for f in COMMON_FILES:
        src = os.path.join(REPO_ROOT, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dest, f))

    # 打 zip
    zip_path = os.path.join(DIST_DIR, cfg['zip_name'])
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(dest):
            for fn in sorted(files):
                full = os.path.join(root, fn)
                arc = os.path.relpath(full, dest).replace('\\', '/')
                z.write(full, arc)

    file_count = sum(len(files) for _, _, files in os.walk(dest))
    size = os.path.getsize(zip_path)
    print(f'  {cfg["zip_name"]}: {file_count} files, {size:,} bytes')


def main():
    os.makedirs(DIST_DIR, exist_ok=True)

    target = sys.argv[1] if len(sys.argv) > 1 else None
    if target and target not in VERSIONS:
        print(f'未知版本: {target}（可选: standard, llama）')
        sys.exit(1)

    print(f'Building v{VERSION}...')
    for name in ([target] if target else VERSIONS):
        build_version(name)
    print('Done.')


if __name__ == '__main__':
    main()
