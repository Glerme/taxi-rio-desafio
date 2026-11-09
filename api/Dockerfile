FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts ./packages/contracts
COPY api ./api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter contracts build && pnpm --filter api build
RUN pnpm --filter api deploy --prod /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
