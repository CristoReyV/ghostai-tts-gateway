# 🎙️ GhostAI TTS Gateway

High-performance Text-to-Speech (TTS) Gateway and Serverless API ready for immediate deployment on **Netlify**.

---

## 🚀 Despliegue en Netlify

Este repositorio está preconfigurado con `netlify.toml` y funciones serverless para que el despliegue sea inmediato:

1. Entra a [Netlify](https://app.netlify.com/).
2. Haz clic en **"Add new site"** > **"Import an existing project"**.
3. Selecciona **GitHub** y busca el repositorio `CristoReyV/ghostai-tts-gateway`.
4. La configuración se detecta automáticamente desde `netlify.toml`:
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
5. Haz clic en **Deploy Site**.

---

## 📡 Endpoints del Gateway

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado del gateway, uptime y región |
| `GET` | `/api/tts` | Información de motores y voces disponibles |
| `POST` | `/api/tts` | Petición para síntesis de audio |

---

## 🛠️ Estructura del Proyecto

```text
ghostai-tts-gateway/
├── netlify.toml               # Configuración de Netlify (build, redirects, CORS)
├── package.json               # Metadatos del microservicio
├── public/                    # Frontend / Landing & Status monitor
│   ├── index.html
│   └── styles.css
└── netlify/
    └── functions/             # Serverless Edge Functions
        ├── health.js
        └── tts.js
```

---

## 📄 Licencia

MIT © CristoReyV
