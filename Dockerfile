FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @bikecare/core --workspace @bikecare/api --include-workspace-root
COPY packages/core packages/core
COPY apps/api apps/api
ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3333
CMD ["sh", "-c", "npm run bootstrap && npm start"]
