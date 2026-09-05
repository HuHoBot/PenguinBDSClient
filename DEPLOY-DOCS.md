# 文档站独立部署指南

组织仓库 `HuHoBot/PenguinBDSClient` 已无管理员权限（开不了 GitHub Pages），文档站改为在**个人仓库**部署。文档源码仍在本仓库 `docs/` 目录维护，更新后同步到个人仓库即可。

## 一次性部署（3 步）

1. 在个人账号下新建一个仓库（如 `PenguinBDSClient-Docs`，可为空仓库）

2. 把以下 4 项拷贝到个人仓库（保持目录结构）：

   ```text
   docs/                                   # 全部页面
   mkdocs.yml
   requirements.txt
   .github/workflows/deploy-docs.yml
   ```

3. 在个人仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**
   （你是该仓库的管理员，这一步没问题），然后到 **Actions → Deploy Docs → Run workflow** 手动触发一次。

站点地址：`https://<你的用户名>.github.io/<仓库名>/`

## 日常更新

文档内容改动在**本仓库** `docs/` 进行 → push 后，把 `docs/` 目录同步到个人仓库（直接复制覆盖 + commit push），Pages 会自动重新部署。

## 本地预览

```bash
pip install -r requirements.txt
python -m mkdocs serve
# 打开 http://127.0.0.1:8000
```

## 备注

- `mkdocs.yml` 的 `repo_url` 指向源码仓库（HuHoBot/PenguinBDSClient），保留即可；如需 "编辑此页" 跳转到个人仓库，可自行修改
- `deploy-docs.yml` 的 `paths` 过滤只在 `docs/**` / `mkdocs.yml` / `requirements.txt` 变化时触发，同步时若只改了页面内容不会跑多余构建——想每次 push 都部署可去掉 `on.push.paths`
