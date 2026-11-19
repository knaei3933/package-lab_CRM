FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build --workspace @kanei/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3080
CMD ["npm", "--workspace", "@kanei/web", "exec", "--", "next", "start", "--hostname", "0.0.0.0", "--port", "3080"]
