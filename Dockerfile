FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY --from=build /app ./
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@companion/server", "start"]
