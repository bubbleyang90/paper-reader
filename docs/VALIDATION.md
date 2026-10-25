# 验证记录

验证日期：2026-10-23。平台：当前 Windows x64 环境，已安装系统 WebView2 Runtime。

## 最终产物

| 文件 | 字节数 |
| --- | ---: |
| `release/Paper/Paper.exe` | 4,247,552 |
| `release/Paper/WebView2Loader.dll` | 160,880 |
| 合计 | 4,408,432（4.204 MiB） |

EXE SHA-256：`45EB5A11932540CF11EEE4D9BFB2AE133E49B7A73D17464E3986C05C6A9377B2`。

PE 导入检查确认，除随包的 WebView2Loader.dll 外，只依赖 Windows 系统 DLL；不需要安装 MinGW、libgcc、libwinpthread 或开发工具链。仍需系统 WebView2 Runtime，4.204 MiB 不包含该共享运行时。

## 验证结果

- Rust 单元测试：8/8 通过，包括 GFM 与中文、脚本和危险链接清洗、只读复选框、UTF-8/BOM、文件大小限制、图片路径范围和外链协议、Windows 父目录文档链接。
- `cargo fmt --check`：通过。
- Release 构建：通过。最终增加低占用参数后再次增量构建成功。
- Edge 浏览器集成测试：7/7 通过，覆盖真实文件导入、恶意 HTML/重复 ID、搜索、偏好恢复、源码/专注模式、阅读位置恢复、宽窄窗口的侧栏和目录。
- 最终便携版原生验证：通过。实际启动 `release/Paper/Paper.exe`，通过 WebView2 检查命令行文件打开、Rust IPC、内容清洗、GFM、主题、搜索，并保存真实渲染截图。

## 内存快照

使用全新的测试配置目录，打开 README、切换阅读指南/主题并执行搜索后，统计应用及 WebView2 子进程。测试连接了 DevTools 协议，不代表无测试工具时的稳定空闲占用。

| 配置 | 进程数 | 专用提交内存合计 | 工作集合计 |
| --- | ---: | ---: | ---: |
| 默认 GPU 配置，单次快照 | 7 | 310.3 MiB | 523.7 MiB |
| 最终软件合成配置，单次快照 | 7 | 157.7 MiB | 494.0 MiB |

工作集合计含共享页面，不能直接视为独占物理内存；专用提交内存也不等于常驻物理内存。上述数值仅说明本机测试场景的结果，不能作为最低占用或跨机器承诺。最终配置降低了本次测试的专用提交内存，但系统 WebView 仍有明显开销。关闭 GPU 合成可能增加复杂页面滚动时的 CPU 工作量。

资源控制还包括：无前端框架、无后台轮询、按可视区域读取本地图片、最多两个图片读取任务、仅保留当前文档、按需生成源码视图。超长文档目前未做虚拟化。

## 复现

```powershell
.\scripts\build.ps1 -Mode test
.\scripts\build.ps1 -Mode fmt
.\scripts\build.ps1 -Mode release
node --test tests/browser.test.mjs
node tests/native-smoke.mjs release/Paper/Paper.exe
```

浏览器和原生验证脚本需要开发依赖 Playwright；普通用户运行便携版无需 Node.js 或 Playwright。
