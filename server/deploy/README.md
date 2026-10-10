# 后端部署(k3s)

三部分:API(GHCR 镜像)· 入口(自带 Traefik + cert-manager 自动 HTTPS)· 数据库(Neon 免费 serverless PostgreSQL,不在集群里)。

域名已定:本服务用 `tutor.161-118-202-85.sslip.io`(ingress.yaml 和 web/src/api.ts 都已填好)。
sslip.io 会把「任意前缀 + IP 横杠」解析到该 IP,所以**每个服务一个子域名**(以后第二个服务用
`xxx.161-118-202-85.sslip.io`,新建一个 Ingress 即可,互不干扰)。
邮箱已填,**清单里没有要改的了**。

> 国内服务器注意:未备案域名走 80/443 可能被拦。先 `curl http://161.118.202.85` 验证;不行就把 Ingress 挂到非标端口(8080/8443)或改用 Cloudflare Tunnel。

## 数据库:Neon(一次性)

1. 注册 [neon.tech](https://neon.tech)(免费),建一个 project
   - Region 选离 k3s 服务器最近的(如新加坡 ap-southeast-1 / 东京 ap-northeast-1)
2. 控制台复制 **直连** Connection string(形如
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`),
   改造成后端格式:驱动前缀加 `+psycopg`:
   `postgresql+psycopg://user:pass@ep-xxx....neon.tech/neondb?sslmode=require`
   - ⚠️ 用 `ep-xxx` 直连端点,**不要**用 `-pooler` 端点(PgBouncer 事务模式与 psycopg 预编译语句有兼容坑)
3. 免费版特性:空闲约 5 分钟自动挂起,下一请求冷启动约 0.5~1s(点「保存」时偶尔慢一下,正常)

## 首次部署(一次性)

```bash
# 1) cert-manager(集群级,只需一次;它是 sslip.io 能有正式证书的关键)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager

# 2) 通用命名空间,手动建一次,以后所有服务共用(不再一服务一空间)
kubectl create namespace max

# 3) 建 tutor-api.yaml(含明文密钥,已 gitignore 不进仓库,clone 后没有它;
#    照下方模板抄,填上 Neon 连接串)
vim server/deploy/tutor-api.yaml

# 4) 应用全部清单
kubectl apply -f server/deploy/

# 5) 看状态:pod 就绪、证书签发完成(Takes ~1min)
kubectl -n max get pods
kubectl -n max get certificate   # READY True 即证书就绪
```

### tutor-api.yaml 模板(整个文件,照抄后只改 DATABASE_URL 和 JWT_SECRET)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tutor-api
  namespace: max
  labels:
    app: tutor-api
    part-of: livekit-tutor
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: tutor-api
      part-of: livekit-tutor
  template:
    metadata:
      labels:
        app: tutor-api
        part-of: livekit-tutor
    spec:
      containers:
        - name: tutor-api
          image: ghcr.io/maxhello/tutor-api:latest
          ports:
            - containerPort: 8000
          env:
            - name: DATABASE_URL
              value: "postgresql+psycopg://USER:PASS@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
            - name: JWT_SECRET
              value: "<openssl rand -hex 32 生成>"
            - name: GITHUB_ALLOWLIST
              value: "maxhello"
            - name: CORS_ORIGINS
              value: "https://maxhello.github.io,http://localhost:5173"
          readinessProbe:
            httpGet:
              path: /api/health
              port: 8000
            initialDelaySeconds: 3
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: tutor-api
  namespace: max
  labels:
    app: tutor-api
    part-of: livekit-tutor
spec:
  selector:
    app: tutor-api
    part-of: livekit-tutor
  ports:
    - port: 8000
```

GHCR 镜像默认私有;最省事的做法:在 GitHub → Packages → tutor-api → Settings 设为 **public**(镜像里没有数据),就不用配 imagePullSecret。想保持私有则:

```bash
kubectl -n max create secret docker-registry regcred \
  --docker-server=ghcr.io --docker-username=maxhello --docker-password=<GitHub PAT(write:packages)>
# 然后在 tutor-api.yaml 的 spec.template.spec 加 imagePullSecrets: [{name: regcred}]
```

## 日常更新

push 到 main(触碰 `server/**`)会自动构建新镜像推 GHCR(见 `.github/workflows/server-image.yml`),然后在服务器上:

```bash
kubectl -n max rollout restart deploy/tutor-api
```

改配置(白名单/CORS/密钥):都在 `tutor-api.yaml` 的 env 里;改完
`kubectl apply -f server/deploy/tutor-api.yaml` 即可(滚动重建,不用再 rollout restart)。

## 备份

数据在 Neon:控制台自带快照/恢复(免费版保留期有限),重要节点可再导一份:

```bash
# 本机装 psql 即可,不依赖集群
pg_dump "<Neon 控制台复制的连接串>" | gzip > tutor-$(date +%F).sql.gz
```
