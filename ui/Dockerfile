# contexto de build = raiz do repo: docker build -f ui/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY ui/package.json ui/
# o workspace lista api, worker e packages/*; o filtro ui... só instala o que a ui precisa
COPY keys/tokens.json keys/
COPY ui ui
RUN pnpm install --frozen-lockfile --filter 'ui...'
RUN pnpm --filter ui build

FROM nginx:alpine
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/ui/dist /usr/share/nginx/html
