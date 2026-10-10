# 后端部署(k3s)

三部分:PostgreSQL(StatefulSet + local-path PVC)· API(GHCR 镜像)· 入口(自带 Traefik + cert-manager 自动 HTTPS)。

## 域名(sslip.io,零成本)

公网 IP `1.2.3.4` 对应域名 `1-2-3-4.sslip.io`(横杠代替点)。Let's Encrypt 可以为它签正式证书,浏览器信任。

改两处后 apply:

1. `ingress.yaml` 里两处 `203-0-113-10.sslip.io` → 你的 `<IP横杠>.sslip.io`,`email` 换成你的邮箱
2. 前端 `web/src/api.ts` 的 `API_BASE` 同步改

> 国内服务器注意:未备案域名走 80/443 可能被拦。先 `curl http://<ip>` 验证;不行就把 Ingress 挂到非标端口(8080/8443)或改用 Cloudflare Tunnel。

## 首次部署(一次性)

```bash
# 1) cert-manager(集群级,只需一次)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager

# 2) 真实密钥(只存在集群里,绝不进仓库)
kubectl create namespace tutor
kubectl -n tutor create secret generic tutor-secrets \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)"

# 3) 应用全部清单
kubectl apply -f server/deploy/

# 4) 看状态:pod 就绪、证书签发完成(Takes ~1min)
kubectl -n tutor get pods
kubectl -n tutor get certificate   # READY True 即证书就绪
```

GHCR 镜像默认私有;最省事的做法:在 GitHub → Packages → tutor-api → Settings 设为 **public**(镜像里没有数据),就不用配 imagePullSecret。想保持私有则:

```bash
kubectl -n tutor create secret docker-registry regcred \
  --docker-server=ghcr.io --docker-username=maxhello --docker-password=<GitHub PAT(write:packages)>
# 然后在 api.yaml 的 spec.template.spec 加 imagePullSecrets: [{name: regcred}]
```

## 日常更新

push 到 main(触碰 `server/**`)会自动构建新镜像推 GHCR(见 `.github/workflows/server-image.yml`),然后在服务器上:

```bash
kubectl -n tutor rollout restart deploy/tutor-api
```

改配置(白名单/CORS):改 `config.yaml` 后 `kubectl apply -f server/deploy/config.yaml && kubectl -n tutor rollout restart deploy/tutor-api`。

改密钥:`kubectl -n tutor delete secret tutor-secrets` 后按上面命令重建,再 restart。

## 备份

数据都在 PG 里:

```bash
kubectl -n tutor exec postgres-0 -- pg_dump -U tutor tutor | gzip > tutor-$(date +%F).sql.gz
```
