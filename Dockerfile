# 小镜像：node:24-alpine 已内置 node:sqlite 和 fetch，无需 npm install
FROM node:24-alpine
WORKDIR /app
COPY bot.mjs lib.mjs ./
ENV DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bot.mjs"]
