# 只保留 Baileys 直连传输，去掉 WAHA

部署方是英国的非技术人员，机器只有 Windows。WAHA 必须跑在 Docker 里，在 Windows 上装 Docker 门槛高，出问题也难排查。Baileys 直连只要装 Node 就能跑。维护两套传输（外加各自的 e2e 和 Docker 配置），换来的只是一条部署方用不上的路，所以删掉 WAHA、`Dockerfile` 和 `docker-compose.yml`。

## Considered Options

- 两套都留：维护面翻倍，WAHA 那条在 Windows 上实际不会用。
- 只留 WAHA：部署方得先装好 Docker，否决。

## Consequences

以后要是迁到 Linux 服务器、需要容器化，得重新写传输层和 Docker 配置。可以参考删除前的提交历史。
