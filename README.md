# livekit-tutor

AI 英语口语陪练(Emma):双语短句教学,面向 A1 初学者,自用。

```
web/     陪练 H5 页面(React + livekit-client),GitHub Pages 托管
         https://maxhello.github.io/livekit-tutor/
agent/   Voice agent(LiveKit Agents Python),部署在 LiveKit Cloud
         STT assemblyai/universal-3-5-pro · LLM gemma-4-31b · TTS fishaudio Hannah
         全部走 LiveKit Inference 托管推理,无需第三方 API key
         实时纠错:每轮说完后台小模型分析,纠错卡推到页面错题本
         Simli 真人头像(可选):配置 SIMLI_API_KEY/SIMLI_FACE_ID 即启用
server/  历史后端(FastAPI + Neon 免费 PostgreSQL),部署在自己的 k3s 服务器
         部署见 server/deploy/README.md;GitHub 登录沿用,后端校验+白名单
```

## 连接原理(token 由后端签发)

登录后点 Start,页面请求后端 `POST /api/token`,后端用 LiveKit API 密钥现签一个
**12 小时短时 token**(内嵌 agent dispatch,Emma 自动进房)返回给页面直连。
LiveKit 密钥只在服务器上,浏览器不再保存任何长期凭证——不用再手工 `lk token create`
和粘贴换发了。房间固定 `tutor-max`、identity 固定 `max`。

> 手动调试仍可 `lk token create --join --room tutor-max --identity max --agent livekit-tutor`。

## 练习历史(GitHub 登录 → 自己的后端)

练完的对话先存浏览器 localStorage;在页面"练习历史"里挑好的点「保存」,
会上传到自己后端(数据库用 Neon 免费 PostgreSQL)。换浏览器/设备登录同一账号即可找回;
不登录也能练,只是不能上传。

- 登录仍是 GitHub 账号:页面把 PAT 发给后端,后端调 GitHub API 校验并按
  白名单(`GITHUB_ALLOWLIST`,见 `server/deploy/config.yaml`)放行,签发 30 天 JWT
- 后端地址在 `web/src/api.ts` 的 `API_BASE`(sslip.io 域名,见 `server/deploy/README.md`)
- 服务器部署/更新/备份:`server/deploy/README.md`

## 常用命令

```bash
lk agent dev agent/agent.py   # 本地开发 agent(改动热重载)
lk agent deploy               # 更新云端部署(改 agent 后跑这个)
cd web && npm run dev         # 本地开发页面
cd server && uv run pytest    # 后端测试
```
