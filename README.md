# livekit-tutor

AI 英语口语陪练(Emma):双语短句教学,面向 A1 初学者,自用。

```
web/    陪练 H5 页面(React + livekit-client),GitHub Pages 托管
        https://maxhello.github.io/livekit-tutor/
agent/  Voice agent(LiveKit Agents Python),部署在 LiveKit Cloud
        STT assemblyai/universal-3-5-pro · LLM gemma-4-31b · TTS fishaudio Hannah
        全部走 LiveKit Inference 托管推理,无需第三方 API key
```

## 连接原理(零后端)

浏览器拿长期 token 直连房间,token 里带 agent dispatch(Emma 自动进房)。
**token 即门票**:只能进指定房间、可设长有效期,存在浏览器 localStorage,不进仓库。
泄露就换房间名重新签发,旧 token 全部作废。

```bash
# 生成 1 年期 token(粘到页面里)
lk token create --join --room tutor-max --identity max --valid-for 8760h --agent livekit-tutor
```

## 练习历史持久化(GitHub 登录)

练完的对话先存浏览器 localStorage;在页面"练习历史"里挑好的点「保存」,
会上传到本仓库 `sessions/<GitHub用户名>/<时间戳>.json`。换浏览器/设备登录同一账号即可找回;
不登录也能练,只是不能上传。

- **读**:仓库是 public,匿名就能读(找回历史不需要 token)
- **写**:需要 Personal Access Token,页面底部登录后存于 localStorage
- **多人**:各自登录自己的 GitHub 账号,记录按用户名分目录,互不干扰

创建 token(二选一):

| 角色 | 做法 |
|---|---|
| 仓库主人 | Settings → Developer settings → **Fine-grained tokens**:Repository access 只勾本仓库,Permissions 只给 **Contents: Read and write** |
| 其他人 | 先加为仓库 collaborator,再建 **classic token**(勾 `public_repo`;fine-grained 无法访问他人个人仓库,属 GitHub 限制) |

注意:记录提交到的是公开仓库,任何人都看得到,介意的内容请勿保存。

## 常用命令

```bash
lk agent dev            # 本地开发 agent(改动热重载)
lk agent deploy         # 更新云端部署(改 agent 后跑这个)
cd web && npm run dev   # 本地开发页面
```
