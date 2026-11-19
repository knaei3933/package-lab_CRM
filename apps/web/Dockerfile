FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build --workspace @kanei/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The container is reached by Caddy over the private network, so it listens on
# every interface of the container; outside a container `npm start` binds
# 127.0.0.1 unless WEB_HOST says otherwise (apps/web/package.json).
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=3080
COPY --from=build /app /app
USER node
EXPOSE 3080
CMD ["npm", "--workspace", "@kanei/web", "run", "start"]
