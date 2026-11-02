# Despliegue en Render (plan Free) — Ommex

Guía para subir el **backend unificado** (turnos + trazabilidad + academia) al
plan **Free** de Render, con la arquitectura **híbrida** elegida:
frontends estáticos en Vercel (serverless) + backend always-on en Render.

---

## 1. Veredicto

Render **sí puede** alojar este backend, y el plan Free **sirve con matices**.
Pero el Free tiene **dos trampas** que rompen los requisitos "always-on" del
dominio de WhatsApp (socket persistente + `setInterval` cada 60 s y cada 10 min):

| Trampa | Detalle | Impacto |
|---|---|---|
| **Spin-down por inactividad** | Render apaga un servicio Free tras **15 min sin tráfico**; tarda ~1 min en despertar. | El socket de WhatsApp (Baileys) se cae y los jobs se detienen. |
| **750 h de instancia/mes** | Las horas son **por workspace**, compartidas por TODOS los servicios Free. | Solo **UN** servicio puede estar 24/7 (720–744 h). Dos servicios 24/7 (~1440 h) **suspenden todos** los Free hasta el mes siguiente. |

> Render **sí** cuenta los mensajes de WebSocket entrantes como tráfico. Por eso,
> mientras haya una sesión de WhatsApp **vinculada y activa**, el keep-alive
> propio de Baileys suele mantener el servicio despierto. Aun así **no es
> garantía** (si no hay sesión vinculada, no hay socket) → usa el pinger externo.

**Conclusión:** un solo servicio Free (el backend unificado) + un pinger externo
es viable y gratis. Un segundo servicio siempre activo (gateway) **no** cabe en
el Free.

---

## 2. Arquitectura híbrida recomendada

```
┌─────────────────────────────┐        ┌───────────────────────────────┐
│  Frontends (estáticos)      │  HTTP  │  Backend unificado            │
│  Vercel  (Free, serverless) │ ─────▶ │  Render  (Free, 1 servicio)   │
│  turnos / trazabilidad /    │        │  REST + WhatsApp (Baileys)    │
│  academia                   │        │  + jobs (60 s / 10 min)       │
└─────────────────────────────┘        └───────────────────────────────┘
                                        ▲
                                        │ ping /health cada 10 min
                                   ┌────┴─────┐
                                   │ Pinger   │  cron-job.org / UptimeRobot
                                   └──────────┘
```

- **Backend → Render Free.** Un único servicio ya expone `/turnos`,
  `/trazabilidad` y `/academia`, así que **el gateway es redundante**: se omite
  para no gastar las horas Free.
- **Frontends → Vercel.** Al ser estáticos encajan perfecto en serverless (ya
  existe `academia-product/frontend/vercel.json`).
- **Gateway → opcional.** Solo si necesitas el contrato de "una sola URL".
  En ese caso súbelo con plan Starter o acepta que se enfríe.

---

## 3. Prerrequisito: repositorio Git

Render **solo** despliega desde GitHub, GitLab o Bitbucket (o una imagen en un
registry). **Este workspace todavía NO es un repositorio Git**, así que el paso
0 es publicarlo:

```powershell
cd e:\documentos\proyect\ommex_register
git init
git add backend gateway render
git commit -m "Backend unificado Ommex + config de despliegue en Render"
git branch -M main
git remote add origin https://github.com/<usuario>/<repo>.git
git push -u origin main
```

> `.gitignore` de `backend/` ya protege `node_modules`, `dist` y `.env`.
> Verifica con `git status` que `.env` NO se sube antes de hacer push.

---

## 4. Despliegue (Blueprint `render.yaml`)

El archivo [`render.yaml`](./render.yaml) define el servicio. Dos formas:

### A. Desde el panel (recomendado)

1. Render Dashboard → **New +** → **Blueprint**.
2. Conecta el repositorio. Render detecta `render/render.yaml`.
3. Rellena los secretos (`sync: false`) cuando los pida:
   `MONGODB_URI`, `JWT_SECRET`, `AUTH_TOKEN_SECRET`, `APP_PUBLIC_URL`.
4. **Apply** → Render construye con `backend/Dockerfile` y publica.

> Si el Blueprint no detecta la ruta, en el panel usa
> **New + → Web Service → Docker** y pon manualmente:
> Root Directory = `backend`, Dockerfile Path = `Dockerfile`,
> Health Check Path = `/health`, Plan = **Free**.

### B. Con la API/CLI de Render

Puedes crear el servicio con la API (`POST /v1/services`) apuntando a
`repo`, `branch`, `rootDir: backend`, `dockerfilePath: Dockerfile`,
`plan: free`, `healthCheckPath: /health`. Requiere una API key de Render.

---

## 5. Variables de entorno

| Variable | Valor | Secreto |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://…` (Atlas) | **Sí** |
| `MONGODB_DB_TURNOS` | `ommex_register` | No |
| `MONGODB_DB_TRAZABILIDAD` | `pluscargo_logging` | No |
| `MONGODB_DB_ACADEMIA` | `ommex_academia` | No |
| `JWT_SECRET` | cadena larga aleatoria | **Sí** |
| `AUTH_TOKEN_SECRET` | cadena larga aleatoria | **Sí** |
| `ENABLE_WHATSAPP_TURNOS` | `true` | No |
| `ENABLE_WHATSAPP_WEB` | `true` | No |
| `APP_PUBLIC_URL` | URL del frontend | No |

`PORT` **no** se define: Render lo inyecta y el backend escucha en
`process.env.PORT` ([server.ts](../backend/src/server.ts#L14-L20)).

> En Atlas, `Network Access` debe permitir `0.0.0.0/0` (Render no da IP fija en Free).

---

## 6. Anti spin-down (crítico para WhatsApp)

Crea un monitor HTTP gratuito que haga `GET` a
`https://ommex-backend.onrender.com/health` **cada 10 minutos**:

- **cron-job.org** (gratis) o **UptimeRobot** (free, 5 min, 50 monitores).
- Intervalo recomendado: 10 min (margen de 5 min frente al corte de 15 min).

Sin esto, el servicio se apaga, el socket de WhatsApp cae y los jobs se
detienen hasta la siguiente petición.

---

## 7. Verificación tras el deploy

```
GET https://ommex-backend.onrender.com/health          → { "service": "ommex-backend" }
GET https://ommex-backend.onrender.com/health/db       → 3 bases "connected"
GET https://ommex-backend.onrender.com/turnos/health   → { "service": "ommex-turnos" }
GET https://ommex-backend.onrender.com/trazabilidad/api/health
GET https://ommex-backend.onrender.com/academia/api/health
```

Si `/health/db` da `disconnected`: revisa `MONGODB_URI` y el `Network Access`
de Atlas (`0.0.0.0/0`).

---

## 8. Rollback

- Panel → servicio → **Deploys** → elige un deploy anterior → **Redeploy**.
- O elimina el Blueprint/servicio y vuelve a Fly.io (`backend/fly.toml`).

---

## 9. Comparativa rápida (always-on real)

| Plataforma | Coste | Always-on | Notas |
|---|---|---|---|
| **Render Free** | $0 | Con pinger + 1 solo servicio | 750 h/mes compartidas; spin-down 15 min |
| Render Starter | ~$14/mo | Sí, garantizado | Sin spin-down |
| Koyeb Pro | ~$29/mo | Sí | Ya hay artefactos en [`koyeb/`](../koyeb/README.md) |
| Railway Hobby | ~$5–12/mo | Sí (pago por uso) | Requiere nueva config |
| VPS propio | ~$4–6/mo | Sí | Tú gestionas el servidor |

**Resumen:** para empezar gratis, un servicio en Render Free + pinger cubre el
caso; si necesitas garantía de always-on (WhatsApp crítico), sube a Render
Starter (~$14/mo) o Koyeb Pro.
