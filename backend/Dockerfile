# Backend unificado de Ommex (Express + TypeScript, ESM) para Fly.io.
# Agrupa los dominios TURNOS y TRAZABILIDAD en un solo proceso con un único
# pool de MongoDB Atlas. Sin disco persistente: el estado vive en Atlas y R2.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Solo dependencias de producción para una imagen más liviana.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
# Artefactos compilados desde la etapa de build.
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
