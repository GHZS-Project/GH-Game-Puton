# GH-Game Puton（游戏后台批量导入工具）

GH-Game Puton 是 Windows 游戏后台资料批量录入工具。项目用于把用户本机整理好的新游资料辅助填入已获授权的后台：

https://and-admin.ghzs.com

本仓库提供**源码**，公开仓库不包含账号、浏览器登录状态、游戏资料或 APK。

> ⚠️ **当前仓库未提供 Release 成品包**（截至 2026-10-26 没有发布任何 Release）。
> 因此想直接运行，需自己打包：`npm install` 后执行 `npm run 打包exe`
> （等价于 `electron-builder --win portable`，产物为便携版 exe），
> 或向原维护者索取现成的 Windows 便携版 ZIP。
> 打包后由使用者自行登录后台并选择本机资料目录 —— **仓库内没有任何账号或登录态可用**。

> **给 AI Agent**：本仓库无凭据可读，不要尝试猜测或硬编码后台账号；登录必须由使用者在
> Electron 界面内手动完成。改动导入逻辑前请先读 [`交接文档.md`](./交接文档.md) 与
> [`新增游戏字段映射表.md`](./新增游戏字段映射表.md)。

## 图形界面使用方式

本机开发/构建生成的桌面版位置示例：

```text
E:\新建文件夹\Codex-GPT\游戏后台批量导入工具\打包输出\win-unpacked\游戏后台批量导入工具.exe
```

给其他同事使用时，请分发 Release 中的完整 Windows ZIP，不要只复制 EXE。

打开后按界面操作：

1. 点击“选择文件夹”，选择游戏资料总文件夹。
2. 点击“检测是否已登录后台”。
3. 如果未登录，点击“打开后台手动登录”，在 Edge 窗口里登录后台。
4. 选择导入模式。
5. 点击“开始执行”。
6. 完成后点击“打开登记表”。

登记表会生成在你选择的资料总文件夹里：

```text
游戏资料登记表.csv
```

正式导入后，工具会尝试回到游戏列表，自动获取游戏 ID，并点击“自己显示”的确认按钮。

## 一、资料文件夹格式

单个游戏测试资料可以这样放：

```text
E:\新建文件夹\游戏资料\
  游戏资料.txt
  游戏资料-测试填写.txt
  ICON.png
  首页大图.webp
  测试安装包.apk
  1.webp
  2.webp
  3.webp
  4.webp
```

批量多个游戏时，建议这样放：

```text
E:\新建文件夹\游戏资料批量\
  游戏A\
    游戏资料.txt
    ICON.png
    首页大图.webp
    1.webp
    2.webp
    游戏A.apk
  游戏B\
    游戏资料.txt
    ICON.png
    首页大图.webp
    1.webp
    2.webp
    游戏B.apk
```

图片和文件识别规则：

- `ICON.png`：游戏图标
- `首页大图.webp`：首页大图
- `1.webp`、`2.webp`、`3.webp`：游戏截图图集
- `.apk` 文件：安装包

## 二、第一次准备

进入工具目录：

```powershell
cd "E:\新建文件夹\Codex-GPT\游戏后台批量导入工具"
```

第一次使用安装依赖：

```powershell
npm install
```

## 三、推荐方式：你自己登录，工具继续执行

这种方式最适合日常使用。账号密码不用写进脚本，也能处理验证码、二次验证、登录过期等情况。

安全预演：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料"
```

运行后会打开一个 Edge 浏览器窗口。

如果页面要求登录，你就在这个窗口里手动登录。登录成功后，工具会自动进入后台游戏信息页面，然后开始填表。

指定资料文件，例如测试“填写 APK 链接”：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料" --info-file "游戏资料-测试填写.txt"
```

测试“填写 APK 链接 + 权限获取”：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料" --info-file "游戏资料-测试填写.txt" --fetch-apk-in-dry-run
```

测试上传图片和 APK，但不提交：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料" --upload-in-dry-run
```

正式提交上架：

```powershell
npm run manual-import -- --source "E:\新建文件夹\游戏资料" --submit
```

注意：正式提交会上传文件并点击提交按钮，请先跑安全预演确认字段无误。

## 四、登录状态保存在哪里

本地运行时，手动登录模式会把浏览器登录状态保存在项目目录：

```text
E:\新建文件夹\Codex-GPT\游戏后台批量导入工具\浏览器登录状态\
```

下次运行 `manual-check` 或 `manual-import` 时，通常可以复用登录状态，不一定需要重新输入账号密码。

如果后台登录失效，工具会再次打开登录页，你重新登录即可。

## 五、自动登录方式（仅限本地受控环境）

如确有需要在受控环境使用自动登录，可通过环境变量提供账号密码；不要把真实值提交到仓库或共享文档：

```powershell
$env:GHZS_ADMIN_USER="你的后台账号"
$env:GHZS_ADMIN_PASS="你的后台密码"
```

安全预演：

```powershell
npm run check -- --source "E:\新建文件夹\游戏资料"
```

正式提交：

```powershell
npm run import -- --source "E:\新建文件夹\游戏资料" --submit
```

## 六、APK 两种方式

### 方式 1：上传 APK

资料里写：

```text
安装包管理：上传
平台：九游
合作方式：S
```

并在资料文件夹里放 `.apk` 文件。

### 方式 2：填写 APK 链接

资料里写：

```text
安装包管理：
填写：https://xxx.apk
平台：九游
合作方式：S
```

如果要测试后台自动抓取包名、版本、大小，运行时加：

```powershell
--fetch-apk-in-dry-run
```

如果后台提示：

```text
xapk包暂时不支持通过填写链接的方式
```

说明这个链接不能通过“填写”方式抓取包信息。建议改用上传 APK，或换成后台支持的 APK 直链。

## 七、查看进度和登记表

运行时窗口会显示进度：

```text
开始处理 1/10：游戏名称
APK方式：上传
完成：游戏名称 -> submitted
```

导入登记表：

```text
E:\新建文件夹\Codex-GPT\游戏后台批量导入工具\导入结果\导入登记表.csv
```

详细记录：

```text
E:\新建文件夹\Codex-GPT\游戏后台批量导入工具\导入结果\导入结果明细.jsonl
```

失败截图：

```text
E:\新建文件夹\Codex-GPT\游戏后台批量导入工具\导入结果\失败截图\
```

登记表中重点看：

- `game`：游戏名称
- `status`：处理状态
- `apkMode`：APK 方式，上传或填写
- `apkLink`：填写模式下的 APK 链接
- `packageName`：包名
- `version`：版本
- `size`：大小
- `apkFetchStatus`：权限获取状态
- `apkFetchMessage`：权限获取说明
- `platform`：平台
- `cooperation`：合作方式
- `error`：失败原因
- `screenshot`：失败截图位置

## 八、常用命令

手动登录，安全预演：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料"
```

手动登录，测试上传但不提交：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料" --upload-in-dry-run
```

手动登录，测试填写链接和权限获取：

```powershell
npm run manual-check -- --source "E:\新建文件夹\游戏资料" --info-file "游戏资料-测试填写.txt" --fetch-apk-in-dry-run
```

手动登录，正式提交：

```powershell
npm run manual-import -- --source "E:\新建文件夹\游戏资料" --submit
```
