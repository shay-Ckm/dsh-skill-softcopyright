# 第三方组件声明 / Third-Party Notices

本插件（`dsh-skill-softcopyright`）自身以 MIT 许可证发布，见 [LICENSE](LICENSE)。

本插件**随包分发**了下列第三方组件。它们的许可证与版权归各自作者所有，
此处按许可证要求保留其声明。

---

## 1. html2canvas

| 项 | 内容 |
|---|---|
| 文件 | `assets/skills/manual-ui-screenshots/assets/html2canvas.min.js` |
| 版本 | 随技能包分发（压缩版） |
| 许可证 | MIT |
| 版权 | Copyright (c) 2022 Niklas von Hertzen <https://hertzen.com> |
| 项目主页 | <https://html2canvas.hertzen.com/> |

该文件**自身首部已内嵌 MIT 许可证声明**，随包分发时**不得移除**。
其用途是把界面图集的 HTML 导出为 PNG（备用路径）；
本插件的主力截图路径是 Playwright 驱动真实浏览器，不依赖该文件。

---

## 2. 关于技能资产（重要，请阅读）

`assets/skills/` 下的四个技能包：

- `python-software-delivery`
- `manual-ui-screenshots`
- `aigc-review-reduction`
- `software-copyright-aigc-appeal`

它们的 `SKILL.md` frontmatter 中均标记 `agent_created: true`，
且**不包含作者署名、许可证或版权声明**。

**这意味着**：本插件无法从文件本身判定这四个技能包的著作权归属。
如果你不是这些内容的著作权人，**公开发布本插件等同于再分发他人的作品**。

发布前请确认下列之一：

1. 这四个技能包由你本人（或你所属组织）创作，你有权以 MIT 分发；或
2. 你已获得原作者的再分发许可；或
3. 改用「仅发布框架、由使用者自备技能包」的分发方式
   （见 README 的「只带框架发布」一节）。

> 本插件对这三个技能包的脚本做过少量必要修补，均已在
> `docs/` 的验收报告中逐条记录（`check_aigc.py` 超集、
> `build_src_package.py` 重复条目修复、新增 `scripts/package.json` 以恢复 CommonJS）。
