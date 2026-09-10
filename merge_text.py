#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按顺序将历史版本(历史版本.txt)中的 text 替换到新版本(新版本.txt)的 text 中。

规则:
  1. 按 stage 顺序（第1个stage对第1个stage，第2个对第2个...）
  2. 每个 stage 内按 story 顺序一一对应
  3. 每个 story 内按 pages 顺序一一对应
  4. 只替换 text 字段，其余字段（file/cosKey等）保持新版本原样

用法:
    python merge_text.py 历史版本.txt 新版本.txt 输出.txt
"""

import json
import re
import sys


def load_json_file(path: str):
    """读取 json 文件，兼容完整对象 / 'children':[...] 片段 / 纯数组"""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()

    for wrapper in (lambda s: s,
                    lambda s: "{" + s + "}",
                    lambda s: "[" + s + "]"):
        try:
            return json.loads(wrapper(raw))
        except json.JSONDecodeError:
            continue

    raise ValueError(f"无法解析文件: {path}")


def extract_stage(name: str):
    """从文件夹名中提取 stage 数字"""
    if not name:
        return None
    m = re.search(r"stage\s*(\d+)", name, re.IGNORECASE)
    return int(m.group(1)) if m else None


def get_stage_folders(root):
    """
    返回 root 下的 stage 文件夹列表，按 stage 数字排序。
    支持 root 是 {'children': [...]} 或本身就是 list。
    """
    if isinstance(root, dict):
        children = root.get("children", []) or []
    elif isinstance(root, list):
        children = root
    else:
        return []

    folders = []
    for c in children:
        if isinstance(c, dict) and c.get("type") == "folder":
            stage = extract_stage(c.get("name", ""))
            if stage is not None:
                folders.append((stage, c))

    folders.sort(key=lambda x: x[0])
    return folders


def get_stories(folder):
    """返回 folder 下的 story 列表，按 sortKey 排序（缺省则按原顺序）"""
    stories = [c for c in (folder.get("children", []) or [])
               if isinstance(c, dict) and c.get("type") == "story"]
    stories.sort(key=lambda s: s.get("sortKey", 0))
    return stories


def merge(hist_root, new_root, keep_empty=False):
    """
    按顺序替换 text。
    keep_empty: True 表示历史版本中空 text 也覆盖；False 表示空 text 跳过。
    """
    hist_folders = get_stage_folders(hist_root)
    new_folders = get_stage_folders(new_root)

    report = []

    # 按 stage 顺序一一对应
    for (h_stage, h_folder), (n_stage, n_folder) in zip(hist_folders, new_folders):
        h_stories = get_stories(h_folder)
        n_stories = get_stories(n_folder)

        if len(h_stories) != len(n_stories):
            report.append(
                f"[警告] stage {h_stage} <-> stage {n_stage}: "
                f"故事数量不一致 (历史 {len(h_stories)} vs 新版 {len(n_stories)})，"
                f"按较少的一边处理"
            )

        for h_story, n_story in zip(h_stories, n_stories):
            h_pages = h_story.get("pages", []) or []
            n_pages = n_story.get("pages", []) or []

            if len(h_pages) != len(n_pages):
                report.append(
                    f"[警告] stage {n_stage} 故事 '{n_story.get('title')}': "
                    f"页数不一致 (历史 {len(h_pages)} vs 新版 {len(n_pages)})，"
                    f"按较少的一边处理"
                )

            replaced = 0
            for h_page, n_page in zip(h_pages, n_pages):
                t = h_page.get("text", "")
                if t == "" and not keep_empty:
                    continue
                n_page["text"] = t
                replaced += 1

            report.append(
                f"[OK] stage {n_stage} 故事 '{n_story.get('title')}' "
                f"(历史: '{h_story.get('title')}'): 替换 {replaced}/{len(n_pages)} 页"
            )

    # 如果 stage 数量不一致也提示
    if len(hist_folders) != len(new_folders):
        report.append(
            f"[警告] stage 数量不一致: 历史 {len(hist_folders)} vs 新版 {len(new_folders)}"
        )

    return report


def main():
    if len(sys.argv) < 3:
        print("用法: python merge_text.py 历史版本.txt 新版本.txt [输出.txt]")
        sys.exit(1)

    hist_path = sys.argv[1]
    new_path = sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "merged_output.txt"

    hist_root = load_json_file(hist_path)
    new_root = load_json_file(new_path)

    report = merge(hist_root, new_root, keep_empty=False)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(new_root, f, ensure_ascii=False, indent=2)

    for line in report:
        print(line)

    print(f"\n已写出: {out_path}")


if __name__ == "__main__":
    main()