FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The vault engine shells out to git and writes one repository per tenant.
RUN apk add --no-cache git \
  && mkdir -p /data/vault \
  && chown -R node:node /data/vault
ENV VAULT_ROOT=/data/vault
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 7692
CMD ["node", "apps/server/dist/index.js"]
