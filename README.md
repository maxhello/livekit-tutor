# livekit-tutor

AI 英语口语陪练(Emma):双语短句教学,面向 A1 初学者,自用。

```
web/    陪练 H5 页面(React + livekit-client),GitHub Pages 托管
        https://maxhello.github.io/livekit-tutor/
src/    Voice agent(LiveKit Agents Python),部署在 LiveKit Cloud
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

## 常用命令

```bash
lk agent dev            # 本地开发 agent(改动热重载)
lk agent deploy         # 更新云端部署(改 agent 后跑这个)
cd web && npm run dev   # 本地开发页面
```
