FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build --workspace @kanei/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3081
CMD ["./node_modules/.bin/tsx", "apps/api/src/server.ts"]
