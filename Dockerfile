# Hub do Claude Hub (API + PWA) para Linux.
# O app da ilha é nativo do macOS e não roda em contêiner.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web ./apps/web
COPY tests/e2e/package.json ./tests/e2e/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Só o hub e suas dependências de produção vão para a imagem final.
RUN pnpm --filter @claude-hub/api deploy --legacy --prod /deploy

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    CLAUDE_HUB_HOME=/data \
    CLAUDE_HUB_LOCAL_HOST=0.0.0.0 \
    CLAUDE_HUB_PUBLIC_HOST=0.0.0.0 \
    CLAUDE_HUB_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /deploy /app
COPY --from=build /app/apps/web/out /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317 4318
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
