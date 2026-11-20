# 协作流程

适用于所有人与 Agent 的一切改动。数据与构建契约见 [开发与数据契约](development.md)，项目边界与入口见 [项目交接](handoff.md)。

## 主循环

1. 同步 main。本地 main 只用于同步，不在上面干活。
2. 从最新 main 开分支干活；可每任务一个 worktree。
3. push 前若 main 已前进，把新 main 同步进自己分支；冲突在自己分支上解。
4. push 分支，开 PR。
5. 闸门：必需 CI 检查全绿 + 独立审核结论留在 PR 里。
6. 在 GitHub 上一次合一个；下一个 PR 先更新到最新 main（Update branch 按钮，或本地同步）。更新可由维护者或其 Agent 代办，不要求贡献者长期维护。fork PR 需作者勾选 Allow edits from maintainers 才能代推；未授权则请作者更新，或按下方接管方式处理。同仓库分支不受此限。作者失联且冲突复杂时，可将改动整理到新分支代为合并，保留原作者署名（Co-authored-by），关闭原 PR。
7. 合并后 pull main 冒烟测试。这是双保险——main 自动部署 Pages，主闸门必须在合并前。
8. 清理：只删「已合并且 git status 干净」的分支/worktree；有未提交工作的绝不碰。

## 硬规则

- main 只接收 PR 合并，禁止直推，由分支保护强制。
- 冲突在 PR 分支上解，不在 main 上解。
- 写作者与审核者分离。合并由检查全绿后执行；闸门是 GitHub 必需检查，不是执行者的自觉。
- 合并后发现问题：PR 页面一键 Revert，整单元撤回。

## CI 闸门

- PR 必须跑：`npm test`、`npm run validate -- --strict-research`、`npm run build`。
- 设为必需状态检查，名称固定。单 job 顺序执行即可（任一步失败即检查失败）；仅需独立报告或并行时才拆多 job。
- 浏览器测试在无 Chrome/Edge 时 skip（可用 `CHROME_PATH` 或 `EDGE_PATH` 指定）。检查绿不等于浏览器测试跑过，CI 应显式确认浏览器存在。